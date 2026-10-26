//! «Группы прокси»: эксклюзивные наборы серверов с выбранной стратегией балансировки.
//!
//! Панель хранит группы в собственном файле (`GROUPS_FILE`) и сама переносит их в конфиг ядра —
//! пользователь вручную ничего не пишет.
//!
//! # Xray
//! Мерж нескольких файлов из confdir (`infra/conf/xray.go::Config.Override`, порядок — по имени
//! файла): `routing`, `observatory`, `burstObservatory` — ОБЪЕКТЫ ВЕРХНЕГО УРОВНЯ и целиком
//! заменяются объектом из более позднего файла; поэлементно мержатся только `inbounds`/`outbounds`
//! (по тегу). Значит, отдельный файл с `routing.balancers` перетёр бы все правила пользователя —
//! балансировщики групп вписываются в `routing.balancers` того файла, чей `routing` действует
//! (последний по алфавиту файл с ключом `routing`). Наблюдатель: если у пользователя уже есть
//! `burstObservatory`/`observatory` — расширяем его `subjectSelector`, иначе кладём свой
//! `burstObservatory` в собственный файл `OWN_XRAY_FILE`.
//!
//! `balancer.selector` и `subjectSelector` — ПРЕФИКСНОЕ сопоставление тегов
//! (`app/proxyman/outbound/outbound.go::Manager.Select` — `strings.HasPrefix`). Поэтому селектор
//! группы — полные теги участников, а пересечения считаются по префиксам: участник `sub-1` захватит
//! чужой `sub-10` (коллизия → предлагаем переименовать участника), а чужой балансировщик с
//! селектором `sub` захватит эксклюзивного участника (→ предлагаем сузить его селектор до явного
//! списка остальных тегов).
//!
//! # Mihomo
//! Группы — элементы `proxy-groups` в `config.yaml`. Эксклюзивность: из явных `proxies` чужих групп
//! участники удаляются, а группам с `include-all*`/`use` дописывается `exclude-filter`
//! (`adapter/outboundgroup/groupbase.go`: несколько regexp через обратный апостроф, regexp2).
//!
//! Правка файлов с сохранением комментариев делается на фронтенде (jsonc-parser / yaml Document):
//! бэкенд считает план (`preview`), фронт собирает тексты и показывает diff, `PUT` валидирует,
//! атомарно пишет, при ошибке откатывает и применяет изменения существующими механизмами.

use crate::configs::{ConfigReq, HOT_RELOAD_UNAVAILABLE, apply_mihomo_hot_reload, validate_core};
use crate::controller::{get_pid, soft_restart};
use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::Mutex;

pub const GROUPS_FILE: &str = "/opt/etc/xkeen/proxy-groups.json";
/// Собственный файл панели в confdir Xray: только `burstObservatory` (и `routing`, если у
/// пользователя его нет вовсе). Имя без «tail» — на мерж outbounds не влияет (их тут нет).
pub const OWN_XRAY_FILE: &str = "/opt/etc/xray/configs/90_xkeen-ui-groups.json";
pub const TAG_PREFIX: &str = "grp-";

static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

// ─── Модель ──────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Member {
    pub name: String,
    /// Mihomo: имя proxy-provider, если участник — прокси из провайдера.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct GroupSettings {
    // Xray leastLoad
    pub expected: Option<u32>,
    pub max_rtt: Option<String>,
    pub tolerance: Option<f64>,
    pub baselines: Vec<String>,
    /// Xray costs: тег → вес (больше — реже выбирается).
    pub costs: BTreeMap<String, f64>,
    // Mihomo
    pub url: Option<String>,
    pub interval: Option<u32>,
    pub mihomo_tolerance: Option<u32>,
    pub lazy: Option<bool>,
    pub timeout: Option<u32>,
    pub max_failed_times: Option<u32>,
    /// load-balance: consistent-hashing | round-robin | sticky-sessions
    pub lb_strategy: Option<String>,
}


#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProxyGroup {
    pub id: String,
    pub name: String,
    pub tag: String,
    /// xray | mihomo
    pub core: String,
    pub members: Vec<Member>,
    /// xray: smart | leastLoad | leastPing | roundRobin | random
    /// mihomo: smart | url-test | fallback | load-balance | select
    pub strategy: String,
    pub exclusive: bool,
    pub enabled: bool,
    /// Xray fallbackTag: куда идёт трафик, если все участники недоступны.
    pub fallback: String,
    pub settings: GroupSettings,
}

impl Default for ProxyGroup {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            tag: String::new(),
            core: "xray".into(),
            members: vec![],
            strategy: "smart".into(),
            exclusive: true,
            enabled: true,
            fallback: String::new(),
            settings: GroupSettings::default(),
        }
    }
}

/// Параметры наблюдателя Xray (burstObservatory) — общие для всех групп.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Observer {
    /// Пусто — берётся URL пинга из настроек панели.
    pub destination: String,
    pub interval: String,
    pub sampling: u32,
    pub timeout: String,
}

impl Default for Observer {
    fn default() -> Self {
        // 1 HEAD-запрос на участника в минуту в среднем, окно 5 замеров (~5 мин):
        // на слабом роутере это копейки и при этом отказ замечается за 1–2 цикла.
        Self { destination: String::new(), interval: "1m".into(), sampling: 5, timeout: "5s".into() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Managed {
    /// Mihomo: какой regexp панель дописала в exclude-filter чужой группы (чтобы потом снять).
    pub mihomo_excludes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct GroupsFile {
    pub version: u32,
    pub groups: Vec<ProxyGroup>,
    pub observer: Observer,
    pub managed: Managed,
}

// ─── Чистые помощники ────────────────────────────────────────────────────────────────────────

/// Удаляет из JSONC комментарии и висячие запятые (вне строк) — для serde_json и для
/// валидации (remote-лоадер xray строгий).
pub fn strip_jsonc(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            if c == b'\\' && i + 1 < b.len() {
                out.push_str(&src[i..i + 2]);
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
            let ch_len = utf8_len(c);
            out.push_str(&src[i..i + ch_len]);
            i += ch_len;
            continue;
        }
        match c {
            b'"' => {
                in_str = true;
                out.push('"');
                i += 1;
            }
            b'/' if i + 1 < b.len() && b[i + 1] == b'/' => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < b.len() && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(b.len());
            }
            b',' => {
                let mut j = i + 1;
                // пропускаем пробелы и комментарии, чтобы увидеть следующий значимый символ
                loop {
                    while j < b.len() && (b[j] as char).is_ascii_whitespace() {
                        j += 1;
                    }
                    if j + 1 < b.len() && b[j] == b'/' && b[j + 1] == b'/' {
                        while j < b.len() && b[j] != b'\n' {
                            j += 1;
                        }
                        continue;
                    }
                    if j + 1 < b.len() && b[j] == b'/' && b[j + 1] == b'*' {
                        j += 2;
                        while j + 1 < b.len() && !(b[j] == b'*' && b[j + 1] == b'/') {
                            j += 1;
                        }
                        j = (j + 2).min(b.len());
                        continue;
                    }
                    break;
                }
                if j < b.len() && (b[j] == b']' || b[j] == b'}') {
                    i += 1; // висячая запятая
                } else {
                    out.push(',');
                    i += 1;
                }
            }
            _ => {
                let ch_len = utf8_len(c);
                out.push_str(&src[i..i + ch_len]);
                i += ch_len;
            }
        }
    }
    out
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

/// Транслитерация + slug для тега группы: `grp-<slug>`.
pub fn slugify(name: &str) -> String {
    const MAP: &[(char, &str)] = &[
        ('а', "a"), ('б', "b"), ('в', "v"), ('г', "g"), ('д', "d"), ('е', "e"), ('ё', "e"), ('ж', "zh"),
        ('з', "z"), ('и', "i"), ('й', "y"), ('к', "k"), ('л', "l"), ('м', "m"), ('н', "n"), ('о', "o"),
        ('п', "p"), ('р', "r"), ('с', "s"), ('т', "t"), ('у', "u"), ('ф', "f"), ('х', "h"), ('ц', "ts"),
        ('ч', "ch"), ('ш', "sh"), ('щ', "sch"), ('ъ', ""), ('ы', "y"), ('ь', ""), ('э', "e"), ('ю', "yu"),
        ('я', "ya"),
    ];
    let mut s = String::new();
    for ch in name.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            s.push(ch);
        } else if let Some((_, t)) = MAP.iter().find(|(c, _)| *c == ch) {
            s.push_str(t);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s = s.trim_matches('-');
    let mut s: String = s.chars().take(40).collect();
    if s.is_empty() {
        s = "group".into();
    }
    format!("{TAG_PREFIX}{}", s.trim_end_matches('-'))
}

pub fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 64
        && tag.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Имя прокси/участника: без переводов строк, запятых-обратных апострофов и т.п. управляющих.
pub fn valid_member_name(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= 256 && !name.chars().any(|c| c.is_control())
}

/// Префиксные коллизии: участник `m` группы — префикс чужого тега `o` (не из группы),
/// значит селектор `m` захватит и `o`.
pub fn prefix_collisions(members: &[String], all_tags: &[String]) -> Vec<(String, Vec<String>)> {
    let set: BTreeSet<&str> = members.iter().map(String::as_str).collect();
    let mut out = vec![];
    for m in members {
        let others: Vec<String> = all_tags
            .iter()
            .filter(|t| t.as_str() != m && t.starts_with(m.as_str()) && !set.contains(t.as_str()))
            .cloned()
            .collect();
        if !others.is_empty() {
            out.push((m.clone(), others));
        }
    }
    out
}

pub fn captured(selectors: &[String], tags: &[String]) -> Vec<String> {
    tags.iter().filter(|t| selectors.iter().any(|s| t.starts_with(s.as_str()))).cloned().collect()
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SelectorFix {
    pub balancer: String,
    pub old: Vec<String>,
    pub new: Vec<String>,
    /// Эксклюзивные участники, которых не удаётся исключить: оставшийся тег — их префикс.
    pub unresolved: Vec<String>,
}

/// Чужой балансировщик захватывает эксклюзивных участников → сужаем его селектор до явного
/// списка остальных тегов, которые он захватывает сейчас.
pub fn selector_fix(balancer: &str, selectors: &[String], all_tags: &[String], exclusive: &BTreeSet<String>) -> Option<SelectorFix> {
    let cap = captured(selectors, all_tags);
    if !cap.iter().any(|t| exclusive.contains(t)) {
        return None;
    }
    let new: Vec<String> = cap.iter().filter(|t| !exclusive.contains(*t)).cloned().collect();
    let unresolved: Vec<String> = exclusive
        .iter()
        .filter(|m| new.iter().any(|t| m.starts_with(t.as_str())))
        .cloned()
        .collect();
    Some(SelectorFix { balancer: balancer.into(), old: selectors.to_vec(), new, unresolved })
}

/// Экранирование для regexp2 (синтаксис .NET) + точное совпадение имени. Обратный апостроф —
/// разделитель фильтров в mihomo, поэтому кодируется как `\x60`.
pub fn regex_escape(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        match c {
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '#' => {
                s.push('\\');
                s.push(c);
            }
            '`' => s.push_str("\\x60"),
            c => s.push(c),
        }
    }
    s
}

pub fn exact_names_regex(names: &[String]) -> String {
    let parts: Vec<String> = names.iter().map(|n| regex_escape(n)).collect();
    format!("^(?:{})$", parts.join("|"))
}

pub fn split_filters(value: &str) -> Vec<String> {
    value.split('`').map(str::to_string).filter(|s| !s.is_empty()).collect()
}

fn dur_str(s: &Option<String>, default: &str) -> String {
    match s.as_deref().map(str::trim) {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => default.to_string(),
    }
}

/// Xray: объект балансировщика группы.
pub fn xray_balancer(g: &ProxyGroup) -> Value {
    let selector: Vec<&str> = g.members.iter().map(|m| m.name.as_str()).collect();
    let mut b = json!({ "tag": g.tag, "selector": selector });
    let strategy = match g.strategy.as_str() {
        "smart" => {
            // «Умная»: leastLoad с гистерезисом. Держим пул «достаточно хороших» узлов (baselines по
            // стандартному отклонению RTT), а не один самый быстрый: случайный выбор внутри пула не
            // дёргает соединения от мелких колебаний пинга. Узлы с >25% потерь за окно и RTT > 1.5 с
            // отбрасываются. Порядок сортировки leastLoad: отклонение → среднее → отказы.
            let mut s = json!({
                "expected": g.settings.expected.unwrap_or(2),
                "maxRTT": dur_str(&g.settings.max_rtt, "1500ms"),
                "tolerance": g.settings.tolerance.unwrap_or(0.25),
                "baselines": if g.settings.baselines.is_empty() { vec!["150ms".to_string(), "400ms".to_string()] } else { g.settings.baselines.clone() },
            });
            add_costs(&mut s, g);
            json!({ "type": "leastLoad", "settings": s })
        }
        "leastLoad" => {
            let mut s = serde_json::Map::new();
            if let Some(e) = g.settings.expected {
                s.insert("expected".into(), json!(e));
            }
            if let Some(m) = g.settings.max_rtt.as_deref().filter(|v| !v.trim().is_empty()) {
                s.insert("maxRTT".into(), json!(m.trim()));
            }
            if let Some(t) = g.settings.tolerance {
                s.insert("tolerance".into(), json!(t));
            }
            if !g.settings.baselines.is_empty() {
                s.insert("baselines".into(), json!(g.settings.baselines));
            }
            let mut v = Value::Object(s);
            add_costs(&mut v, g);
            json!({ "type": "leastLoad", "settings": v })
        }
        "leastPing" => json!({ "type": "leastPing" }),
        "roundRobin" => json!({ "type": "roundRobin" }),
        _ => json!({ "type": "random" }),
    };
    b["strategy"] = strategy;
    if !g.fallback.trim().is_empty() {
        b["fallbackTag"] = json!(g.fallback.trim());
    }
    b
}

fn add_costs(settings: &mut Value, g: &ProxyGroup) {
    if g.settings.costs.is_empty() {
        return;
    }
    let costs: Vec<Value> = g
        .settings
        .costs
        .iter()
        .filter(|(_, v)| **v > 0.0)
        .map(|(tag, v)| json!({ "regexp": true, "match": format!("^{}$", regex_escape(tag)), "value": v }))
        .collect();
    if !costs.is_empty() {
        settings["costs"] = json!(costs);
    }
}

/// Нужен ли группе наблюдатель (без него leastPing/leastLoad не выбирают ничего, а random/
/// roundRobin с fallbackTag не умеют исключать мёртвые узлы).
pub fn needs_observer(g: &ProxyGroup) -> bool {
    g.enabled && (matches!(g.strategy.as_str(), "smart" | "leastLoad" | "leastPing") || !g.fallback.trim().is_empty())
}

pub fn burst_observatory(selectors: &[String], obs: &Observer, ping_url: &str) -> Value {
    let dest = if obs.destination.trim().is_empty() { ping_url } else { obs.destination.trim() };
    json!({
        "subjectSelector": selectors,
        "pingConfig": {
            "destination": dest,
            "connectivity": "",
            "interval": if obs.interval.trim().is_empty() { "1m" } else { obs.interval.trim() },
            "sampling": obs.sampling.clamp(2, 20),
            "timeout": if obs.timeout.trim().is_empty() { "5s" } else { obs.timeout.trim() },
        }
    })
}

/// Mihomo: объект proxy-group.
pub fn mihomo_group(g: &ProxyGroup, smart_supported: bool, ping_url: &str) -> Value {
    let direct: Vec<&str> = g.members.iter().filter(|m| m.provider.is_none()).map(|m| m.name.as_str()).collect();
    let providers: BTreeSet<&str> = g.members.iter().filter_map(|m| m.provider.as_deref()).collect();
    let provider_members: Vec<String> = g.members.iter().filter(|m| m.provider.is_some()).map(|m| m.name.clone()).collect();

    let url = g.settings.url.clone().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| ping_url.to_string());
    let ty = match g.strategy.as_str() {
        "smart" if smart_supported => "smart",
        "fallback" => "fallback",
        "load-balance" => "load-balance",
        "select" => "select",
        _ => "url-test",
    };
    let mut o = serde_json::Map::new();
    o.insert("name".into(), json!(g.tag));
    o.insert("type".into(), json!(ty));
    if !direct.is_empty() {
        o.insert("proxies".into(), json!(direct));
    }
    if !providers.is_empty() {
        o.insert("use".into(), json!(providers));
        o.insert("filter".into(), json!(exact_names_regex(&provider_members)));
    }
    if ty != "select" {
        o.insert("url".into(), json!(url));
        // «Умная» (url-test): проверка раз в 5 мин и только когда группа используется (lazy),
        // переключение лишь при выигрыше > 50 мс — без «дребезга» между близкими узлами.
        o.insert("interval".into(), json!(g.settings.interval.unwrap_or(300)));
        o.insert("lazy".into(), json!(g.settings.lazy.unwrap_or(true)));
        o.insert("timeout".into(), json!(g.settings.timeout.unwrap_or(5000)));
        o.insert("max-failed-times".into(), json!(g.settings.max_failed_times.unwrap_or(3)));
    }
    if ty == "url-test" {
        o.insert("tolerance".into(), json!(g.settings.mihomo_tolerance.unwrap_or(50)));
    }
    if ty == "load-balance" {
        let s = g.settings.lb_strategy.clone().unwrap_or_else(|| "consistent-hashing".into());
        o.insert("strategy".into(), json!(s));
    }
    Value::Object(o)
}

// ─── Инвентарь конфигов ──────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Default)]
pub struct XrayOutbound {
    pub tag: String,
    pub protocol: String,
    pub file: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct XrayBalancer {
    pub tag: String,
    pub selector: Vec<String>,
    pub strategy: String,
    pub fallback: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct XrayInventory {
    pub outbounds: Vec<XrayOutbound>,
    /// Файл, чей `routing` действует (последний по имени с ключом `routing`).
    pub routing_file: Option<String>,
    pub balancers: Vec<XrayBalancer>,
    /// Теги, на которые ссылаются правила через balancerTag.
    pub rule_balancer_refs: Vec<String>,
    pub burst_observatory_file: Option<String>,
    pub observatory_file: Option<String>,
    pub observer_selectors: Vec<String>,
    pub api_addr: Option<String>,
    pub freedom_tags: Vec<String>,
    pub parse_errors: Vec<String>,
}

pub fn xray_inventory(files: &[(String, String)]) -> XrayInventory {
    let mut inv = XrayInventory::default();
    let mut outbounds: BTreeMap<String, XrayOutbound> = BTreeMap::new();
    let mut routing: Option<(String, Value)> = None;
    let mut api: Option<Value> = None;
    let mut inbounds: Vec<Value> = vec![];
    let mut sorted: Vec<&(String, String)> = files.iter().collect();
    sorted.sort_by(|a, b| Path::new(&a.0).file_name().cmp(&Path::new(&b.0).file_name()));
    for (file, content) in sorted {
        if file == OWN_XRAY_FILE {
            continue;
        }
        let v: Value = match serde_json::from_str(&strip_jsonc(content)) {
            Ok(v) => v,
            Err(e) => {
                inv.parse_errors.push(format!("{file}: {e}"));
                continue;
            }
        };
        if let Some(arr) = v.get("outbounds").and_then(Value::as_array) {
            for o in arr {
                let tag = o.get("tag").and_then(Value::as_str).unwrap_or_default();
                if tag.is_empty() {
                    continue;
                }
                outbounds.insert(
                    tag.into(),
                    XrayOutbound {
                        tag: tag.into(),
                        protocol: o.get("protocol").and_then(Value::as_str).unwrap_or_default().into(),
                        file: file.clone(),
                    },
                );
            }
        }
        if let Some(arr) = v.get("inbounds").and_then(Value::as_array) {
            inbounds.extend(arr.iter().cloned());
        }
        if let Some(r) = v.get("routing") {
            routing = Some((file.clone(), r.clone()));
        }
        if let Some(o) = v.get("burstObservatory") {
            inv.burst_observatory_file = Some(file.clone());
            inv.observer_selectors = str_list(o.get("subjectSelector"));
        }
        if let Some(o) = v.get("observatory") {
            inv.observatory_file = Some(file.clone());
            if inv.burst_observatory_file.is_none() {
                inv.observer_selectors = str_list(o.get("subjectSelector"));
            }
        }
        if let Some(a) = v.get("api") {
            api = Some(a.clone());
        }
    }
    inv.freedom_tags = outbounds.values().filter(|o| o.protocol == "freedom").map(|o| o.tag.clone()).collect();
    inv.outbounds = outbounds.into_values().collect();
    if let Some((file, r)) = routing {
        inv.routing_file = Some(file);
        if let Some(arr) = r.get("balancers").and_then(Value::as_array) {
            for b in arr {
                inv.balancers.push(XrayBalancer {
                    tag: b.get("tag").and_then(Value::as_str).unwrap_or_default().into(),
                    selector: str_list(b.get("selector")),
                    strategy: b.pointer("/strategy/type").and_then(Value::as_str).unwrap_or("random").into(),
                    fallback: b.get("fallbackTag").and_then(Value::as_str).unwrap_or_default().into(),
                });
            }
        }
        if let Some(arr) = r.get("rules").and_then(Value::as_array) {
            for rule in arr {
                if let Some(t) = rule.get("balancerTag").and_then(Value::as_str) {
                    inv.rule_balancer_refs.push(t.into());
                }
            }
        }
    }
    inv.api_addr = api.and_then(|a| api_address(&a, &inbounds));
    inv
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => vec![],
    }
}

/// Адрес gRPC API Xray с включённым RoutingService (нужен для статуса балансировщиков).
fn api_address(api: &Value, inbounds: &[Value]) -> Option<String> {
    let services = str_list(api.get("services"));
    if !services.iter().any(|s| s == "RoutingService") {
        return None;
    }
    if let Some(listen) = api.get("listen").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Some(listen.to_string());
    }
    let tag = api.get("tag").and_then(Value::as_str)?;
    let ib = inbounds.iter().find(|i| i.get("tag").and_then(Value::as_str) == Some(tag))?;
    let port = ib.get("port").and_then(|p| p.as_u64().or_else(|| p.as_str().and_then(|s| s.parse().ok())))?;
    let host = ib.get("listen").and_then(Value::as_str).unwrap_or("127.0.0.1");
    let host = if host == "0.0.0.0" || host.is_empty() { "127.0.0.1" } else { host };
    Some(format!("{host}:{port}"))
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct MihomoGroupInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub proxies: Vec<String>,
    #[serde(rename = "use")]
    pub uses: Vec<String>,
    pub include_all: bool,
    pub include_all_proxies: bool,
    pub include_all_providers: bool,
    pub filter: String,
    pub exclude_filter: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct MihomoInventory {
    pub proxies: Vec<String>,
    pub providers: Vec<String>,
    pub groups: Vec<MihomoGroupInfo>,
    /// Цели правил (последнее/предпоследнее поле правила).
    pub rule_targets: Vec<String>,
    pub parse_error: Option<String>,
}

pub fn mihomo_inventory(content: &str) -> MihomoInventory {
    use yaml_rust2::{Yaml, YamlLoader};
    let mut inv = MihomoInventory::default();
    let docs = match YamlLoader::load_from_str(content) {
        Ok(d) => d,
        Err(e) => {
            inv.parse_error = Some(e.to_string());
            return inv;
        }
    };
    let Some(doc) = docs.first() else { return inv };
    let s = |y: &Yaml| -> Option<String> {
        match y {
            Yaml::String(s) => Some(s.clone()),
            Yaml::Integer(i) => Some(i.to_string()),
            Yaml::Real(r) => Some(r.clone()),
            Yaml::Boolean(b) => Some(b.to_string()),
            _ => None,
        }
    };
    let list = |y: &Yaml| -> Vec<String> { y.as_vec().map(|v| v.iter().filter_map(s).collect()).unwrap_or_default() };
    if let Some(arr) = doc["proxies"].as_vec() {
        inv.proxies = arr.iter().filter_map(|p| s(&p["name"])).collect();
    }
    if let Some(h) = doc["proxy-providers"].as_hash() {
        inv.providers = h.keys().filter_map(s).collect();
    }
    if let Some(arr) = doc["proxy-groups"].as_vec() {
        for g in arr {
            let Some(name) = s(&g["name"]) else { continue };
            inv.groups.push(MihomoGroupInfo {
                name,
                kind: s(&g["type"]).unwrap_or_default(),
                proxies: list(&g["proxies"]),
                uses: list(&g["use"]),
                include_all: g["include-all"].as_bool().unwrap_or(false),
                include_all_proxies: g["include-all-proxies"].as_bool().unwrap_or(false),
                include_all_providers: g["include-all-providers"].as_bool().unwrap_or(false),
                filter: s(&g["filter"]).unwrap_or_default(),
                exclude_filter: s(&g["exclude-filter"]).unwrap_or_default(),
            });
        }
    }
    if let Some(arr) = doc["rules"].as_vec() {
        for r in arr.iter().filter_map(s) {
            let parts: Vec<&str> = r.split(',').map(str::trim).collect();
            if let Some(last) = parts.last() {
                let target = if matches!(*last, "no-resolve" | "src") && parts.len() >= 2 { parts[parts.len() - 2] } else { last };
                inv.rule_targets.push(target.to_string());
            }
        }
    }
    inv
}

// ─── План ────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Default)]
pub struct Collision {
    pub group: String,
    pub member: String,
    pub others: Vec<String>,
    /// Предлагаемое новое имя участника (не префикс ни одного другого тега).
    pub suggested: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct XrayPlan {
    pub routing_file: Option<String>,
    /// Балансировщики групп (включённых) — вставить в routing.balancers.
    pub balancers: Vec<Value>,
    /// Теги, которые панель считает своими: убрать из routing.balancers перед вставкой.
    pub strip_tags: Vec<String>,
    pub selector_fixes: Vec<SelectorFix>,
    /// none | own | extend
    pub observer_mode: String,
    pub observer_file: Option<String>,
    /// burstObservatory | observatory
    pub observer_key: String,
    /// Для extend: итоговый subjectSelector (старый ∪ участники).
    pub observer_selectors: Vec<String>,
    pub own_file: String,
    /// Содержимое собственного файла (None — удалить, если существует).
    pub own_file_content: Option<Value>,
    pub collisions: Vec<Collision>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct MihomoFix {
    pub group: String,
    pub remove_proxies: Vec<String>,
    pub exclude_remove: Option<String>,
    pub exclude_add: Option<String>,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct MihomoPlan {
    pub file: String,
    pub groups: Vec<Value>,
    pub strip_names: Vec<String>,
    pub fixes: Vec<MihomoFix>,
    pub managed: Managed,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

/// Пустой тег → `grp-<slug(name)>` (уникальный), пустой id → тег.
pub fn normalize(groups: &mut [ProxyGroup]) {
    let mut used: BTreeSet<String> = groups.iter().filter(|g| !g.tag.is_empty()).map(|g| g.tag.clone()).collect();
    for g in groups.iter_mut() {
        g.name = g.name.trim().to_string();
        if g.tag.trim().is_empty() {
            let base = slugify(&g.name);
            let mut tag = base.clone();
            let mut i = 2;
            while used.contains(&tag) {
                tag = format!("{base}-{i}");
                i += 1;
            }
            used.insert(tag.clone());
            g.tag = tag;
        }
        if g.id.is_empty() {
            g.id = g.tag.clone();
        }
        g.members.dedup_by(|a, b| a == b);
    }
}

fn common_checks(groups: &[ProxyGroup], errors: &mut Vec<String>) {
    let mut tags = BTreeSet::new();
    for g in groups {
        if !valid_tag(&g.tag) {
            errors.push(format!("Некорректный тег группы «{}»: только латиница, цифры, «-», «_», «.»", g.tag));
        }
        if !tags.insert(g.tag.clone()) {
            errors.push(format!("Тег «{}» повторяется", g.tag));
        }
        if g.name.trim().is_empty() {
            errors.push(format!("У группы «{}» нет названия", g.tag));
        }
        if g.enabled && g.members.is_empty() {
            errors.push(format!("В группе «{}» нет серверов", g.name));
        }
        for m in &g.members {
            if !valid_member_name(&m.name) {
                errors.push(format!("Некорректное имя сервера в группе «{}»", g.name));
            }
        }
    }
    // Участник эксклюзивной группы не может состоять в другой группе панели.
    for (i, a) in groups.iter().enumerate() {
        for b in groups.iter().skip(i + 1) {
            if !(a.exclusive || b.exclusive) {
                continue;
            }
            for m in &a.members {
                if b.members.iter().any(|x| x.name == m.name) {
                    errors.push(format!("«{}» входит в «{}» и «{}», а одна из групп эксклюзивная", m.name, a.name, b.name));
                }
            }
        }
    }
}

/// Новое имя для участника-«префикса»: такое, что ни один другой тег с него не начинается.
fn suggest_name(member: &str, all: &[String]) -> String {
    let base: String = member.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' }).collect();
    for i in 0..100 {
        let cand = if i == 0 { format!("{base}.") } else { format!("{base}.{i}.") };
        if !all.iter().any(|t| t != member && t.starts_with(&cand)) {
            return cand;
        }
    }
    format!("{base}.x.")
}

pub fn plan_xray(groups: &[ProxyGroup], old: &[ProxyGroup], observer: &Observer, inv: &XrayInventory, ping_url: &str) -> XrayPlan {
    let mut p = XrayPlan {
        own_file: OWN_XRAY_FILE.into(),
        routing_file: inv.routing_file.clone(),
        observer_mode: "none".into(),
        ..Default::default()
    };
    let groups: Vec<&ProxyGroup> = groups.iter().filter(|g| g.core == "xray").collect();
    let owned: Vec<ProxyGroup> = groups.iter().map(|g| (*g).clone()).collect();
    common_checks(&owned, &mut p.errors);

    let all_tags: Vec<String> = inv.outbounds.iter().map(|o| o.tag.clone()).collect();
    let managed_tags: BTreeSet<String> = old
        .iter()
        .chain(owned.iter())
        .filter(|g| g.core == "xray")
        .map(|g| g.tag.clone())
        .collect();
    p.strip_tags = managed_tags.iter().cloned().collect();
    let user_balancers: Vec<&XrayBalancer> = inv.balancers.iter().filter(|b| !managed_tags.contains(&b.tag)).collect();

    for g in &groups {
        if all_tags.contains(&g.tag) || user_balancers.iter().any(|b| b.tag == g.tag) {
            p.errors.push(format!("Тег «{}» уже занят outbound'ом или балансировщиком", g.tag));
        }
        for m in &g.members {
            if !all_tags.contains(&m.name) {
                p.warnings.push(format!("Сервер «{}» из группы «{}» не найден в конфигах", m.name, g.name));
            }
        }
        if !g.fallback.is_empty() && !all_tags.contains(&g.fallback) {
            p.errors.push(format!("Резерв «{}» группы «{}» не найден среди outbound'ов", g.fallback, g.name));
        }
        let members: Vec<String> = g.members.iter().map(|m| m.name.clone()).collect();
        for (member, others) in prefix_collisions(&members, &all_tags) {
            p.collisions.push(Collision { group: g.tag.clone(), suggested: suggest_name(&member, &all_tags), member, others });
        }
    }

    // Эксклюзивность относительно чужих балансировщиков.
    let exclusive: BTreeSet<String> = groups
        .iter()
        .filter(|g| g.enabled && g.exclusive)
        .flat_map(|g| g.members.iter().map(|m| m.name.clone()))
        .collect();
    if !exclusive.is_empty() {
        for b in &user_balancers {
            if let Some(fix) = selector_fix(&b.tag, &b.selector, &all_tags, &exclusive) {
                if !fix.unresolved.is_empty() {
                    p.warnings.push(format!(
                        "Балансировщик «{}» всё равно захватит {} — его тег-префикс совпадает; переименуйте сервер",
                        b.tag,
                        fix.unresolved.join(", ")
                    ));
                }
                if fix.new.is_empty() {
                    p.warnings.push(format!("У балансировщика «{}» не останется серверов после исключения", b.tag));
                }
                p.selector_fixes.push(fix);
            }
        }
    }

    // Удалённые/выключенные группы, на которые ещё ссылаются правила.
    let active: BTreeSet<&str> = groups.iter().filter(|g| g.enabled).map(|g| g.tag.as_str()).collect();
    for t in &managed_tags {
        if !active.contains(t.as_str()) && inv.rule_balancer_refs.contains(t) {
            p.errors.push(format!("На группу «{t}» ссылаются правила маршрутизации (balancerTag) — сначала уберите их"));
        }
    }

    p.balancers = groups.iter().filter(|g| g.enabled).map(|g| xray_balancer(g)).collect();

    // Наблюдатель.
    let mut obs_sel: BTreeSet<String> = BTreeSet::new();
    for g in groups.iter().filter(|g| needs_observer(g)) {
        obs_sel.extend(g.members.iter().map(|m| m.name.clone()));
    }
    let mut own = serde_json::Map::new();
    if !obs_sel.is_empty() {
        let user_file = inv.burst_observatory_file.clone().map(|f| (f, "burstObservatory")).or_else(|| inv.observatory_file.clone().map(|f| (f, "observatory")));
        match user_file {
            Some((file, key)) => {
                let mut all: Vec<String> = inv.observer_selectors.clone();
                for s in &obs_sel {
                    if !all.iter().any(|x| s.starts_with(x.as_str())) {
                        all.push(s.clone());
                    }
                }
                p.observer_mode = "extend".into();
                p.observer_file = Some(file);
                p.observer_key = key.into();
                p.observer_selectors = all;
                if inv.burst_observatory_file.is_some() && inv.observatory_file.is_some() {
                    p.warnings.push("В конфиге одновременно observatory и burstObservatory — оставьте один".into());
                }
            }
            None => {
                let sel: Vec<String> = obs_sel.into_iter().collect();
                own.insert("burstObservatory".into(), burst_observatory(&sel, observer, ping_url));
                p.observer_mode = "own".into();
                p.observer_file = Some(OWN_XRAY_FILE.into());
                p.observer_key = "burstObservatory".into();
                p.observer_selectors = sel;
            }
        }
    }
    if inv.routing_file.is_none() && !p.balancers.is_empty() {
        own.insert("routing".into(), json!({ "balancers": p.balancers }));
        p.warnings.push("В конфигах нет секции routing — балансировщики будут в собственном файле панели".into());
    }
    p.own_file_content = if own.is_empty() { None } else { Some(Value::Object(own)) };
    p
}

pub fn plan_mihomo(groups: &[ProxyGroup], old: &[ProxyGroup], managed: &Managed, inv: &MihomoInventory, smart: bool, ping_url: &str) -> MihomoPlan {
    let mut p = MihomoPlan { file: format!("{MIHOMO_CONF_DIR}/config.yaml"), ..Default::default() };
    if let Some(e) = &inv.parse_error {
        p.errors.push(format!("config.yaml не разбирается: {e}"));
        return p;
    }
    let groups: Vec<ProxyGroup> = groups.iter().filter(|g| g.core == "mihomo").cloned().collect();
    common_checks(&groups, &mut p.errors);
    let managed_names: BTreeSet<String> = old.iter().chain(groups.iter()).filter(|g| g.core == "mihomo").map(|g| g.tag.clone()).collect();
    p.strip_names = managed_names.iter().cloned().collect();

    for g in &groups {
        if inv.proxies.contains(&g.tag) || inv.groups.iter().any(|x| x.name == g.tag && !managed_names.contains(&x.name)) {
            p.errors.push(format!("Имя «{}» уже занято прокси или группой", g.tag));
        }
        for m in &g.members {
            match &m.provider {
                None if !inv.proxies.contains(&m.name) && !inv.groups.iter().any(|x| x.name == m.name) => {
                    p.warnings.push(format!("Прокси «{}» не найден в config.yaml", m.name));
                }
                Some(pr) if !inv.providers.contains(pr) => {
                    p.errors.push(format!("Провайдер «{pr}» не найден в config.yaml"));
                }
                _ => {}
            }
        }
        if g.strategy == "smart" && !smart {
            p.warnings.push(format!("Ядро без поддержки smart — «{}» будет url-test с гистерезисом", g.name));
        }
    }

    // Эксклюзивность.
    let excl: Vec<&Member> = groups.iter().filter(|g| g.enabled && g.exclusive).flat_map(|g| g.members.iter()).collect();
    for og in inv.groups.iter().filter(|g| !managed_names.contains(&g.name)) {
        let mut fix = MihomoFix { group: og.name.clone(), ..Default::default() };
        fix.remove_proxies = og.proxies.iter().filter(|n| excl.iter().any(|m| m.provider.is_none() && &m.name == *n)).cloned().collect();
        let takes_all_proxies = og.include_all || og.include_all_proxies;
        let uses = |pr: &str| og.include_all || og.include_all_providers || og.uses.iter().any(|u| u == pr);
        let filter_ok = |name: &str| -> bool {
            if og.filter.is_empty() {
                return true;
            }
            split_filters(&og.filter).iter().any(|f| regex_lite::Regex::new(f).map(|r| r.is_match(name)).unwrap_or(true))
        };
        let mut captured: Vec<String> = excl
            .iter()
            .filter(|m| match &m.provider {
                None => takes_all_proxies && filter_ok(&m.name),
                Some(pr) => uses(pr) && filter_ok(&m.name),
            })
            .map(|m| m.name.clone())
            .collect();
        captured.sort();
        captured.dedup();
        let old_re = managed.mihomo_excludes.get(&og.name).cloned();
        let new_re = (!captured.is_empty()).then(|| exact_names_regex(&captured));
        if old_re != new_re {
            fix.exclude_remove = old_re;
            fix.exclude_add = new_re.clone();
        }
        if let Some(re) = new_re {
            p.managed.mihomo_excludes.insert(og.name.clone(), re);
        }
        if !fix.remove_proxies.is_empty() || fix.exclude_add.is_some() || fix.exclude_remove.is_some() {
            if fix.remove_proxies.len() == og.proxies.len() && !og.proxies.is_empty() && og.uses.is_empty() && !takes_all_proxies && !og.include_all_providers {
                p.warnings.push(format!("В группе «{}» не останется прокси", og.name));
            }
            p.fixes.push(fix);
        }
    }

    let active: BTreeSet<&str> = groups.iter().filter(|g| g.enabled).map(|g| g.tag.as_str()).collect();
    for n in &managed_names {
        if !active.contains(n.as_str()) {
            if inv.rule_targets.iter().any(|t| t == n) {
                p.errors.push(format!("На группу «{n}» ссылаются правила (rules) — сначала уберите их"));
            }
            if inv.groups.iter().any(|g| !managed_names.contains(&g.name) && g.proxies.contains(n)) {
                p.errors.push(format!("Группа «{n}» используется в других группах — сначала уберите её оттуда"));
            }
        }
    }
    p.groups = groups.iter().filter(|g| g.enabled).map(|g| mihomo_group(g, smart, ping_url)).collect();
    p
}

// ─── Ввод-вывод ──────────────────────────────────────────────────────────────────────────────

async fn load_groups() -> GroupsFile {
    match tokio::fs::read_to_string(GROUPS_FILE).await {
        Ok(c) => serde_json::from_str(&c).unwrap_or_else(|e| {
            log("ERROR", format!("Ошибка разбора {GROUPS_FILE}: {e}"));
            GroupsFile::default()
        }),
        Err(_) => GroupsFile::default(),
    }
}

async fn write_atomic(path: &str, content: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = Path::new(path).parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let tmp = format!("{path}.tmp");
    tokio::fs::write(&tmp, content).await?;
    tokio::fs::rename(&tmp, path).await
}

async fn read_xray_files() -> Vec<(String, String)> {
    let mut out = vec![];
    if let Ok(mut rd) = tokio::fs::read_dir(XRAY_CONF_DIR).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let path = e.path();
            if path.extension().is_some_and(|x| x == "json" || x == "jsonc")
                && let Ok(c) = tokio::fs::read_to_string(&path).await
            {
                out.push((path.to_string_lossy().into_owned(), c));
            }
        }
    }
    out.sort();
    out
}

async fn read_mihomo() -> String {
    tokio::fs::read_to_string(format!("{MIHOMO_CONF_DIR}/config.yaml")).await.unwrap_or_default()
}

fn current_core(state: &AppState) -> String {
    state.core.read().unwrap().name.clone()
}

fn ping_url(state: &AppState) -> String {
    state.settings.read().unwrap().clash_api.ping_url.clone()
}

fn err(msg: impl Into<String>) -> Json<Value> {
    Json(json!({ "success": false, "error": msg.into() }))
}

// ─── HTTP ────────────────────────────────────────────────────────────────────────────────────

pub async fn get_groups(State(state): State<AppState>) -> impl IntoResponse {
    let data = load_groups().await;
    let core = current_core(&state);
    let inventory = if core == "mihomo" {
        serde_json::to_value(mihomo_inventory(&read_mihomo().await)).unwrap_or_default()
    } else {
        serde_json::to_value(xray_inventory(&read_xray_files().await)).unwrap_or_default()
    };
    Json(json!({
        "success": true,
        "core": core,
        "groups": data.groups,
        "observer": data.observer,
        "managed": data.managed,
        "inventory": inventory,
        "pingUrl": ping_url(&state),
    }))
}

#[derive(Deserialize)]
pub struct PreviewReq {
    pub groups: Vec<ProxyGroup>,
    #[serde(default)]
    pub observer: Option<Observer>,
    /// Переименования серверов (старый тег → новый), которые фронт применит к файлам.
    #[serde(default)]
    pub renames: BTreeMap<String, String>,
    #[serde(default)]
    pub mihomo_smart: bool,
}

fn apply_renames_inventory(inv: &mut XrayInventory, renames: &BTreeMap<String, String>) {
    for o in inv.outbounds.iter_mut() {
        if let Some(n) = renames.get(&o.tag) {
            o.tag = n.clone();
        }
    }
    for t in inv.freedom_tags.iter_mut() {
        if let Some(n) = renames.get(t) {
            *t = n.clone();
        }
    }
}

pub async fn post_preview(State(state): State<AppState>, Json(mut req): Json<PreviewReq>) -> impl IntoResponse {
    normalize(&mut req.groups);
    let stored = load_groups().await;
    let observer = req.observer.clone().unwrap_or(stored.observer.clone());
    let core = current_core(&state);
    for (a, b) in &req.renames {
        if !valid_member_name(a) || !valid_tag(b) {
            return err("Некорректное переименование");
        }
    }
    if core == "mihomo" {
        let inv = mihomo_inventory(&read_mihomo().await);
        let plan = plan_mihomo(&req.groups, &stored.groups, &stored.managed, &inv, req.mihomo_smart, &ping_url(&state));
        Json(json!({ "success": true, "core": core, "plan": plan, "groups": req.groups }))
    } else {
        let mut inv = xray_inventory(&read_xray_files().await);
        apply_renames_inventory(&mut inv, &req.renames);
        let plan = plan_xray(&req.groups, &stored.groups, &observer, &inv, &ping_url(&state));
        Json(json!({ "success": true, "core": core, "plan": plan, "groups": req.groups }))
    }
}

#[derive(Deserialize)]
pub struct FileContent {
    pub file: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct ApplyReq {
    pub groups: Vec<ProxyGroup>,
    #[serde(default)]
    pub observer: Option<Observer>,
    #[serde(default)]
    pub managed: Option<Managed>,
    #[serde(default)]
    pub files: Vec<FileContent>,
    #[serde(default)]
    pub delete: Vec<String>,
    /// Только проверить (xray -test), ничего не записывая.
    #[serde(default)]
    pub dry_run: bool,
}

fn xray_path_ok(file: &str) -> bool {
    !file.contains("..")
        && Path::new(file).parent() == Some(Path::new(XRAY_CONF_DIR))
        && (file.ends_with(".json") || file.ends_with(".jsonc"))
}

pub async fn put_groups(State(state): State<AppState>, Json(mut req): Json<ApplyReq>) -> impl IntoResponse {
    normalize(&mut req.groups);
    let _guard = LOCK.lock().await;
    let stored = load_groups().await;
    let core = current_core(&state);
    let mut errors = vec![];
    common_checks(&req.groups, &mut errors);
    if !errors.is_empty() {
        return err(errors.join("; "));
    }
    let new_file = GroupsFile {
        version: 1,
        groups: req.groups.clone(),
        observer: req.observer.clone().unwrap_or(stored.observer.clone()),
        managed: req.managed.clone().unwrap_or(stored.managed.clone()),
    };
    let serialized = serde_json::to_string_pretty(&new_file).unwrap_or_default();

    if core == "mihomo" {
        let main = format!("{MIHOMO_CONF_DIR}/config.yaml");
        if !req.delete.is_empty() || req.files.iter().any(|f| f.file != main) {
            return err("Для Mihomo изменяется только config.yaml");
        }
        if req.dry_run {
            return Json(json!({ "success": true }));
        }
        let mut need_restart = false;
        if let Some(f) = req.files.first() {
            let Json(res) = apply_mihomo_hot_reload(&state, &f.file, &f.content, false).await;
            if !res.success {
                if res.error.as_deref() == Some(HOT_RELOAD_UNAVAILABLE) {
                    need_restart = true; // файл записан, Clash API недоступен
                } else {
                    return err("Mihomo отклонил конфиг: проверьте журнал");
                }
            }
        }
        if let Err(e) = write_atomic(GROUPS_FILE, serialized.as_bytes()).await {
            return err(format!("Не удалось сохранить группы: {e}"));
        }
        log("INFO", format!("Группы прокси сохранены ({})", new_file.groups.len()));
        return Json(json!({ "success": true, "needRestart": need_restart }));
    }

    // Xray
    for f in req.files.iter().map(|f| &f.file).chain(req.delete.iter()) {
        if !xray_path_ok(f) {
            return err(format!("Недопустимый путь: {f}"));
        }
    }
    let mut set: BTreeMap<String, String> = read_xray_files().await.into_iter().collect();
    let originals = set.clone();
    for f in &req.files {
        set.insert(f.file.clone(), f.content.clone());
    }
    for d in &req.delete {
        set.remove(d);
    }
    let to_validate: Vec<ConfigReq> = set.iter().map(|(f, c)| ConfigReq::new(f.clone(), strip_jsonc(c))).collect();
    if let Err(e) = validate_core(&to_validate).await {
        log("ERROR", format!("Группы прокси: ошибка валидации Xray: {e}"));
        let short: String = e.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("").chars().take(400).collect();
        return err(format!("Xray отклонил конфиг: {short}"));
    }
    if req.dry_run {
        return Json(json!({ "success": true }));
    }

    let rollback = |written: Vec<String>| {
        let originals = originals.clone();
        async move {
            for f in written {
                match originals.get(&f) {
                    Some(c) => _ = write_atomic(&f, c.as_bytes()).await,
                    None => _ = tokio::fs::remove_file(&f).await,
                }
            }
        }
    };
    let mut written = vec![];
    for f in &req.files {
        if let Err(e) = write_atomic(&f.file, f.content.as_bytes()).await {
            rollback(written).await;
            return err(format!("Ошибка записи {}: {e}", f.file));
        }
        written.push(f.file.clone());
    }
    for d in &req.delete {
        if Path::new(d).exists() {
            if let Err(e) = tokio::fs::remove_file(d).await {
                rollback(written).await;
                return err(format!("Ошибка удаления {d}: {e}"));
            }
            written.push(d.clone());
        }
    }
    if let Err(e) = write_atomic(GROUPS_FILE, serialized.as_bytes()).await {
        rollback(written).await;
        return err(format!("Не удалось сохранить группы: {e}"));
    }

    let running = !tokio::task::spawn_blocking(|| get_pid("xray")).await.unwrap_or_default().is_empty();
    if running && let Err(e) = soft_restart("xray").await {
        log("ERROR", format!("Группы прокси: перезапуск Xray не удался: {e}"));
        rollback(written).await;
        let old = serde_json::to_string_pretty(&stored).unwrap_or_default();
        _ = write_atomic(GROUPS_FILE, old.as_bytes()).await;
        _ = soft_restart("xray").await;
        return err(format!("Не удалось перезапустить Xray, изменения откатены: {e}"));
    }
    log("INFO", format!("Группы прокси применены ({})", new_file.groups.len()));
    Json(json!({ "success": true, "restarted": running }))
}

/// Статус балансировщиков Xray через `xray api bi` (нужен api с RoutingService).
pub async fn get_status(State(state): State<AppState>) -> impl IntoResponse {
    if current_core(&state) != "xray" {
        return Json(json!({ "success": true, "available": false }));
    }
    let inv = xray_inventory(&read_xray_files().await);
    let Some(addr) = inv.api_addr else {
        return Json(json!({ "success": true, "available": false, "reason": "В конфиге нет api с RoutingService" }));
    };
    let data = load_groups().await;
    let mut out = serde_json::Map::new();
    for g in data.groups.iter().filter(|g| g.core == "xray" && g.enabled) {
        let mut cmd = tokio::process::Command::new("xray");
        cmd.args(["api", "bi", "-s", &addr, "-t", "3", "-json", &g.tag]).kill_on_drop(true);
        let Ok(Ok(o)) = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await else { continue };
        let text = String::from_utf8_lossy(&o.stdout);
        let Ok(v) = serde_json::from_str::<Value>(text.trim()) else { continue };
        let b = v.get("balancer").unwrap_or(&v);
        let selected = str_list(b.pointer("/principleTarget/tag"));
        let override_ = b.pointer("/override/target").and_then(Value::as_str).unwrap_or_default();
        out.insert(g.tag.clone(), json!({ "selected": selected, "override": override_ }));
    }
    Json(json!({ "success": true, "available": true, "groups": out }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(tag: &str, members: &[&str]) -> ProxyGroup {
        ProxyGroup {
            id: tag.into(),
            name: tag.into(),
            tag: tag.into(),
            members: members.iter().map(|m| Member { name: (*m).into(), provider: None }).collect(),
            ..Default::default()
        }
    }

    /// Прогон на реальном config.yaml: `XK_REAL_MIHOMO=/path cargo test real_mihomo -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_mihomo_groups_plan() {
        let path = std::env::var("XK_REAL_MIHOMO").expect("XK_REAL_MIHOMO");
        let inv = mihomo_inventory(&std::fs::read_to_string(&path).unwrap());
        println!("parse_error: {:?}", inv.parse_error);
        println!("proxies: {:?}", inv.proxies);
        println!("providers: {:?}", inv.providers);
        println!("groups: {:?}", inv.groups.iter().map(|g| &g.name).collect::<Vec<_>>());
        let member = inv.proxies.first().cloned().expect("есть хотя бы один прокси");
        let mut grp = g("grp-yt-fast", &[&member]);
        grp.core = "mihomo".into();
        grp.name = "YouTube быстрые".into();
        let p = plan_mihomo(&[grp], &[], &Managed::default(), &inv, false, "http://cp.cloudflare.com/generate_204");
        println!("errors: {:?}\nwarnings: {:?}", p.errors, p.warnings);
        for f in &p.fixes {
            println!("fix {}: remove={:?} exclude_add={:?}", f.group, f.remove_proxies, f.exclude_add);
        }
        println!("group: {}", serde_json::to_string(&p.groups).unwrap());
        assert!(p.errors.is_empty());
        // Все группы с include-all должны получить exclude-filter, иначе сервер останется в них.
        let with_all = inv.groups.iter().filter(|g| g.include_all || g.include_all_proxies).count();
        assert_eq!(p.fixes.iter().filter(|f| f.exclude_add.is_some()).count(), with_all);
    }

    fn inv(tags: &[&str]) -> XrayInventory {
        XrayInventory {
            outbounds: tags.iter().map(|t| XrayOutbound { tag: (*t).into(), protocol: "vless".into(), file: "x".into() }).collect(),
            routing_file: Some("/opt/etc/xray/configs/05_routing.json".into()),
            ..Default::default()
        }
    }

    #[test]
    fn strips_comments_and_trailing_commas() {
        let src = "{\n // c\n \"a\": \"x//y\", /* b */ \"b\": [1,2,],\n}";
        let v: Value = serde_json::from_str(&strip_jsonc(src)).unwrap();
        assert_eq!(v["a"], "x//y");
        assert_eq!(v["b"], json!([1, 2]));
        let s = strip_jsonc("{\"k\":\"a\\\"//b\"}");
        assert_eq!(serde_json::from_str::<Value>(&s).unwrap()["k"], "a\"//b");
        let s = strip_jsonc("{\"k\":\"Привет\" // ю\n}");
        assert_eq!(serde_json::from_str::<Value>(&s).unwrap()["k"], "Привет");
    }

    #[test]
    fn normalizes_tags() {
        let mut gs = vec![
            ProxyGroup { name: " YouTube ".into(), ..Default::default() },
            ProxyGroup { name: "youtube".into(), ..Default::default() },
            ProxyGroup { name: "x".into(), tag: "grp-mine".into(), ..Default::default() },
        ];
        normalize(&mut gs);
        assert_eq!(gs[0].tag, "grp-youtube");
        assert_eq!(gs[1].tag, "grp-youtube-2");
        assert_eq!(gs[2].tag, "grp-mine");
        assert_eq!(gs[0].name, "YouTube");
        assert!(gs[0].tag.starts_with(TAG_PREFIX));
    }

    #[test]
    fn slug_and_tags() {
        assert_eq!(slugify("Быстрые YouTube"), "grp-bystrye-youtube");
        assert_eq!(slugify("  !!! "), "grp-group");
        assert!(valid_tag("grp-yt_1.a"));
        assert!(!valid_tag("grp yt"));
        assert!(!valid_tag(""));
        assert!(!valid_member_name("a\nb"));
    }

    #[test]
    fn detects_prefix_collisions() {
        let all: Vec<String> = ["sub-1", "sub-10", "sub-2", "direct"].iter().map(|s| s.to_string()).collect();
        let c = prefix_collisions(&["sub-1".into(), "sub-2".into()], &all);
        assert_eq!(c, vec![("sub-1".to_string(), vec!["sub-10".to_string()])]);
        // если оба в группе — не коллизия
        assert!(prefix_collisions(&["sub-1".into(), "sub-10".into()], &all).is_empty());
        let s = suggest_name("sub-1", &all);
        assert!(!all.iter().any(|t| t != "sub-1" && t.starts_with(&s)));
    }

    #[test]
    fn narrows_foreign_selector() {
        let all: Vec<String> = ["proxy-a", "proxy-b", "proxy-c", "direct"].iter().map(|s| s.to_string()).collect();
        let excl: BTreeSet<String> = ["proxy-b".to_string()].into();
        let fix = selector_fix("bal", &["proxy".into()], &all, &excl).unwrap();
        assert_eq!(fix.new, vec!["proxy-a".to_string(), "proxy-c".to_string()]);
        assert!(fix.unresolved.is_empty());
        assert!(selector_fix("bal", &["direct".into()], &all, &excl).is_none());
        // оставшийся тег — префикс эксклюзивного
        let all2: Vec<String> = ["p1", "p10"].iter().map(|s| s.to_string()).collect();
        let excl2: BTreeSet<String> = ["p10".to_string()].into();
        let fix2 = selector_fix("bal", &["p".into()], &all2, &excl2).unwrap();
        assert_eq!(fix2.unresolved, vec!["p10".to_string()]);
    }

    #[test]
    fn builds_smart_balancer_and_observer() {
        let mut grp = g("grp-yt", &["fast-1", "fast-2"]);
        grp.fallback = "direct".into();
        let b = xray_balancer(&grp);
        assert_eq!(b["selector"], json!(["fast-1", "fast-2"]));
        assert_eq!(b["strategy"]["type"], "leastLoad");
        assert_eq!(b["strategy"]["settings"]["expected"], 2);
        assert_eq!(b["fallbackTag"], "direct");
        let mut i = inv(&["fast-1", "fast-2", "direct", "other"]);
        i.freedom_tags = vec!["direct".into()];
        let p = plan_xray(&[grp.clone()], &[], &Observer::default(), &i, "http://cp.cloudflare.com/generate_204");
        assert!(p.errors.is_empty(), "{:?}", p.errors);
        assert_eq!(p.observer_mode, "own");
        let own = p.own_file_content.unwrap();
        assert_eq!(own["burstObservatory"]["subjectSelector"], json!(["fast-1", "fast-2"]));
        assert_eq!(own["burstObservatory"]["pingConfig"]["destination"], "http://cp.cloudflare.com/generate_204");
        assert!(own.get("routing").is_none());

        // у пользователя уже есть observatory — расширяем
        i.observatory_file = Some("/opt/etc/xray/configs/07_obs.json".into());
        i.observer_selectors = vec!["fast".into(), "x".into()];
        let p2 = plan_xray(&[grp], &[], &Observer::default(), &i, "u");
        assert_eq!(p2.observer_mode, "extend");
        assert_eq!(p2.observer_key, "observatory");
        assert_eq!(p2.observer_selectors, vec!["fast".to_string(), "x".to_string()]);
    }

    #[test]
    fn plan_validates_exclusivity_and_refs() {
        let a = g("grp-a", &["s1"]);
        let mut b = g("grp-b", &["s1"]);
        b.exclusive = false;
        let i = inv(&["s1", "s2"]);
        let p = plan_xray(&[a.clone(), b], &[], &Observer::default(), &i, "u");
        assert!(p.errors.iter().any(|e| e.contains("эксклюзив")));

        let mut i2 = inv(&["s1"]);
        i2.rule_balancer_refs = vec!["grp-old".into()];
        let p2 = plan_xray(&[], &[g("grp-old", &["s1"])], &Observer::default(), &i2, "u");
        assert!(p2.errors.iter().any(|e| e.contains("grp-old")));
        assert_eq!(p2.strip_tags, vec!["grp-old".to_string()]);
    }

    #[test]
    fn exclude_filter_escaping() {
        let re = exact_names_regex(&["🇩🇪 DE (fast)".into(), "a.b|c".into(), "x`y".into()]);
        assert_eq!(re, "^(?:🇩🇪 DE \\(fast\\)|a\\.b\\|c|x\\x60y)$");
        assert_eq!(split_filters("a`b``c"), vec!["a", "b", "c"]);
        let r = regex_lite::Regex::new(&exact_names_regex(&["a.b".into()])).unwrap();
        assert!(r.is_match("a.b"));
        assert!(!r.is_match("axb"));
    }

    #[test]
    fn mihomo_plan_excludes() {
        let yaml = r#"
proxies:
  - { name: fast1, type: ss, server: a, port: 1, cipher: aes-128-gcm, password: x }
  - { name: slow1, type: ss, server: b, port: 1, cipher: aes-128-gcm, password: x }
proxy-providers:
  sub: { type: http, url: http://x, path: ./sub.yaml }
proxy-groups:
  - { name: PROXY, type: select, proxies: [fast1, slow1, DIRECT] }
  - { name: AUTO, type: url-test, include-all: true }
  - { name: SUB, type: select, use: [sub] }
rules:
  - DOMAIN-SUFFIX,youtube.com,PROXY
  - MATCH,DIRECT
"#;
        let inv = mihomo_inventory(yaml);
        assert_eq!(inv.proxies, vec!["fast1", "slow1"]);
        assert_eq!(inv.rule_targets, vec!["PROXY", "DIRECT"]);
        let mut grp = g("grp-yt", &["fast1"]);
        grp.core = "mihomo".into();
        grp.members.push(Member { name: "DE 1".into(), provider: Some("sub".into()) });
        let p = plan_mihomo(&[grp.clone()], &[], &Managed::default(), &inv, false, "http://u");
        assert!(p.errors.is_empty(), "{:?}", p.errors);
        let proxy_fix = p.fixes.iter().find(|f| f.group == "PROXY").unwrap();
        assert_eq!(proxy_fix.remove_proxies, vec!["fast1"]);
        let auto_fix = p.fixes.iter().find(|f| f.group == "AUTO").unwrap();
        assert_eq!(auto_fix.exclude_add.as_deref(), Some("^(?:DE 1|fast1)$"));
        let sub_fix = p.fixes.iter().find(|f| f.group == "SUB").unwrap();
        assert_eq!(sub_fix.exclude_add.as_deref(), Some("^(?:DE 1)$"));
        let obj = &p.groups[0];
        assert_eq!(obj["type"], "url-test");
        assert_eq!(obj["proxies"], json!(["fast1"]));
        assert_eq!(obj["use"], json!(["sub"]));
        assert_eq!(obj["filter"], "^(?:DE 1)$");
        assert_eq!(obj["lazy"], true);

        // повторный план с тем же managed — exclude не меняется
        let p2 = plan_mihomo(&[grp], &[], &p.managed, &inv, true, "http://u");
        assert!(p2.fixes.iter().all(|f| f.exclude_add.is_none() || f.group == "PROXY"));
        assert_eq!(p2.groups[0]["type"], "smart");

        // удаление группы снимает exclude
        let p3 = plan_mihomo(&[], &[g("grp-yt", &[])].into_iter().map(|mut x| { x.core = "mihomo".into(); x }).collect::<Vec<_>>(), &p.managed, &inv, false, "u");
        let auto3 = p3.fixes.iter().find(|f| f.group == "AUTO").unwrap();
        assert_eq!(auto3.exclude_remove.as_deref(), Some("^(?:DE 1|fast1)$"));
        assert!(auto3.exclude_add.is_none());
    }

    #[test]
    fn xray_inventory_parses_effective_routing_and_api() {
        let files = vec![
            ("/opt/etc/xray/configs/03_inbounds.json".to_string(), r#"{"inbounds":[{"tag":"api-in","port":10085,"listen":"127.0.0.1","protocol":"dokodemo-door"}]}"#.to_string()),
            ("/opt/etc/xray/configs/04_outbounds.json".to_string(), r#"{"outbounds":[{"tag":"vless-1","protocol":"vless"},{"tag":"direct","protocol":"freedom"}], // c
            "api":{"tag":"api-in","services":["RoutingService"]}}"#.to_string()),
            ("/opt/etc/xray/configs/05_routing.json".to_string(), r#"{"routing":{"balancers":[{"tag":"b1","selector":["vless"]}],"rules":[{"balancerTag":"b1"}]}}"#.to_string()),
            ("/opt/etc/xray/configs/01_old.json".to_string(), r#"{"routing":{"rules":[]}}"#.to_string()),
        ];
        let i = xray_inventory(&files);
        assert_eq!(i.routing_file.as_deref(), Some("/opt/etc/xray/configs/05_routing.json"));
        assert_eq!(i.balancers.len(), 1);
        assert_eq!(i.rule_balancer_refs, vec!["b1"]);
        assert_eq!(i.freedom_tags, vec!["direct"]);
        assert_eq!(i.api_addr.as_deref(), Some("127.0.0.1:10085"));
    }
}
