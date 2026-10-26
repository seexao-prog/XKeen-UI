//! «Быстрые правила» маршрутизации: пользователь в UI указывает домен/IP и куда его
//! направить (напрямую / блокировать / в конкретный outbound или группу), а панель
//! сама хранит список и генерирует из него конфигурацию ядра.
//!
//! Список хранится отдельно: `/opt/etc/xkeen/quick-rules.json` (раздельно для xray и mihomo).
//!
//! Xray
//! ----
//! При нескольких файлах в confdir Xray мержит конфиги через `conf.Config.Override`
//! (infra/conf/xray.go): `routing` из более позднего файла ЗАМЕНЯЕТ `routing` целиком,
//! а не дописывает правила. Поэтому отдельный файл с `routing` сломал бы правила
//! пользователя. Вместо этого панель вставляет свой блок в НАЧАЛО `routing.rules`
//! того файла, чей `routing` реально действует (последний по алфавиту файл с ключом
//! `routing`). Свои правила помечаются `"ruleTag": "xkeen-ui-quick"` — при каждом
//! применении панель удаляет только их и вставляет актуальные; остальной текст файла
//! (включая комментарии) не трогается.
//! Если для «Напрямую»/«Блокировать» в конфиге нет freedom/blackhole-outbound, панель
//! создаёт `99_xkeen-ui-quick_tail.json` с собственным outbound. «tail» в имени файла
//! важен: новые outbounds из файла без «tail» Xray ДОБАВЛЯЕТ В НАЧАЛО списка (а первый
//! outbound — маршрут по умолчанию), из файла с «tail» — в конец.
//!
//! Mihomo
//! ------
//! Для каждой цели (и уровня приоритета) создаётся локальный rule-provider
//! (`type: file`, `behavior: classical`, `format: text`) в `/opt/etc/mihomo/quick-rules/`,
//! а в начало `rules` config.yaml — строка `RULE-SET,xkeen-ui-quick-…,<цель>`. В YAML
//! меняются только свои строки (помечены префиксом имени провайдера), остальное
//! форматирование и комментарии сохраняются. Применение — горячая перезагрузка
//! через Clash API (`PUT /configs?force=true`) с откатом при ошибке.

use crate::configs;
use crate::controller;
use crate::logger::log;
use crate::types::*;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::net::IpAddr;
use std::path::Path;
use std::sync::LazyLock;
use tokio::sync::Mutex;

pub const QUICK_RULES_FILE: &str = "/opt/etc/xkeen/quick-rules.json";
const RULE_TAG: &str = "xkeen-ui-quick";
const XRAY_TAIL_FILE: &str = "99_xkeen-ui-quick_tail.json";
const XRAY_DEFAULT_ROUTING_FILE: &str = "05_routing.json";
const XRAY_DIRECT_TAG: &str = "xkeen-ui-direct";
const XRAY_BLOCK_TAG: &str = "xkeen-ui-block";
const MIHOMO_PROVIDER_PREFIX: &str = "xkeen-ui-quick-";
const MIHOMO_PROVIDER_DIR: &str = "quick-rules";
const MAX_RULES: usize = 2000;

static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

// ─── Модель ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleKind {
    Domain,
    Full,
    Keyword,
    Regexp,
    Geosite,
    Ip,
    Cidr,
    Geoip,
}

impl RuleKind {
    fn is_ip(self) -> bool {
        matches!(self, RuleKind::Ip | RuleKind::Cidr | RuleKind::Geoip)
    }

    /// Порядок вставки: более точные правила раньше, чтобы `full:a.example.com → прокси`
    /// перекрывал `domain:example.com → напрямую`.
    fn level(self) -> u8 {
        match self {
            RuleKind::Full | RuleKind::Ip => 0,
            RuleKind::Domain | RuleKind::Cidr => 1,
            RuleKind::Keyword | RuleKind::Regexp => 2,
            RuleKind::Geosite | RuleKind::Geoip => 3,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Direct,
    Block,
    Proxy,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Target {
    #[serde(rename = "type")]
    pub kind: TargetKind,
    #[serde(default)]
    pub tag: String,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuickRule {
    #[serde(default)]
    pub id: String,
    pub value: String,
    pub kind: RuleKind,
    pub target: Target,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub created: i64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Store {
    xray: Vec<QuickRule>,
    mihomo: Vec<QuickRule>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Core {
    Xray,
    Mihomo,
}

impl Core {
    fn name(self) -> &'static str {
        match self {
            Core::Xray => "xray",
            Core::Mihomo => "mihomo",
        }
    }
}

// ─── Валидация ввода ─────────────────────────────────────────────────────────

fn has_control(s: &str) -> bool {
    s.chars().any(|c| c.is_control())
}

fn is_valid_domain(s: &str) -> bool {
    if s.is_empty() || s.len() > 253 {
        return false;
    }
    s.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

fn is_valid_geo(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'!' | b'@'))
}

fn normalize_value(kind: RuleKind, raw: &str) -> Result<String, String> {
    let v = raw.trim();
    if v.is_empty() {
        return Err("Пустое значение".into());
    }
    if has_control(v) || v.contains(',') {
        return Err(format!("Недопустимые символы в «{}»", v.chars().take(80).collect::<String>()));
    }
    let strip = |prefix: &str| v.strip_prefix(prefix).unwrap_or(v).trim().to_string();
    match kind {
        RuleKind::Domain | RuleKind::Full => {
            let d = strip(if kind == RuleKind::Domain { "domain:" } else { "full:" })
                .to_ascii_lowercase()
                .trim_start_matches("*.")
                .trim_start_matches('.')
                .trim_end_matches('.')
                .to_string();
            if !is_valid_domain(&d) {
                return Err(format!("Некорректный домен «{d}» (кириллические домены укажите в punycode: xn--…)"));
            }
            Ok(d)
        }
        RuleKind::Keyword => {
            let k = strip("keyword:").to_ascii_lowercase();
            if k.is_empty() || k.len() > 100 || !k.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
                return Err(format!("Некорректное ключевое слово «{k}»: допустимы латиница, цифры, «.», «-», «_»"));
            }
            Ok(k)
        }
        RuleKind::Regexp => {
            let r = strip("regexp:");
            if r.is_empty() || r.len() > 500 || r.starts_with('#') {
                return Err("Некорректное регулярное выражение".into());
            }
            regex_lite::Regex::new(&r).map_err(|e| format!("Ошибка в регулярном выражении: {e}"))?;
            Ok(r)
        }
        RuleKind::Geosite | RuleKind::Geoip => {
            let g = strip(if kind == RuleKind::Geosite { "geosite:" } else { "geoip:" }).to_ascii_lowercase();
            if !is_valid_geo(&g) {
                return Err(format!("Некорректная категория «{g}»"));
            }
            Ok(g)
        }
        RuleKind::Ip => v
            .parse::<IpAddr>()
            .map(|ip| ip.to_string())
            .map_err(|_| format!("Некорректный IP-адрес «{v}»")),
        RuleKind::Cidr => {
            let (ip, prefix) = v.split_once('/').ok_or_else(|| format!("Некорректная подсеть «{v}»"))?;
            let ip: IpAddr = ip.trim().parse().map_err(|_| format!("Некорректная подсеть «{v}»"))?;
            let prefix: u8 = prefix.trim().parse().map_err(|_| format!("Некорректная маска в «{v}»"))?;
            let max = if ip.is_ipv4() { 32 } else { 128 };
            if prefix > max {
                return Err(format!("Некорректная маска в «{v}»"));
            }
            Ok(format!("{ip}/{prefix}"))
        }
    }
}

fn normalize_rule(mut rule: QuickRule) -> Result<QuickRule, String> {
    rule.value = normalize_value(rule.kind, &rule.value)?;
    rule.comment = rule.comment.chars().filter(|c| !c.is_control()).take(200).collect::<String>().trim().to_string();
    match rule.target.kind {
        TargetKind::Direct | TargetKind::Block => rule.target.tag.clear(),
        TargetKind::Proxy => {
            let tag = rule.target.tag.trim().to_string();
            if tag.is_empty() {
                return Err(format!("Для «{}» не выбрано подключение", rule.value));
            }
            if tag.len() > 200 || has_control(&tag) || tag.contains(',') {
                return Err(format!("Недопустимое имя подключения «{tag}»"));
            }
            rule.target.tag = tag;
        }
    }
    if rule.id.is_empty() || rule.id.len() > 64 || !rule.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        rule.id = uuid::Uuid::new_v4().to_string();
    }
    if rule.created <= 0 {
        rule.created = chrono::Utc::now().timestamp();
    }
    Ok(rule)
}

fn normalize_all(rules: Vec<QuickRule>) -> Result<Vec<QuickRule>, String> {
    if rules.len() > MAX_RULES {
        return Err(format!("Слишком много правил (максимум {MAX_RULES})"));
    }
    let mut seen = HashSet::new();
    let mut ids = HashSet::new();
    let mut out = Vec::with_capacity(rules.len());
    for rule in rules {
        let mut rule = normalize_rule(rule)?;
        if !seen.insert((rule.kind, rule.value.clone())) {
            return Err(format!("Правило для «{}» указано дважды", rule.value));
        }
        if !ids.insert(rule.id.clone()) {
            rule.id = uuid::Uuid::new_v4().to_string();
            ids.insert(rule.id.clone());
        }
        out.push(rule);
    }
    Ok(out)
}

fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in bytes {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

// ─── JSONC: разбор с позициями, чтобы править текст точечно ──────────────────

mod jsonc {
    #[derive(Debug)]
    pub enum Node {
        Obj { start: usize, end: usize, members: Vec<Member> },
        Arr { start: usize, end: usize, items: Vec<Node> },
        Str { start: usize, end: usize, value: String },
        Other { start: usize, end: usize },
    }

    #[derive(Debug)]
    pub struct Member {
        pub key: String,
        pub key_start: usize,
        pub value: Node,
    }

    impl Node {
        pub fn start(&self) -> usize {
            match self {
                Node::Obj { start, .. } | Node::Arr { start, .. } | Node::Str { start, .. } | Node::Other { start, .. } => *start,
            }
        }

        pub fn end(&self) -> usize {
            match self {
                Node::Obj { end, .. } | Node::Arr { end, .. } | Node::Str { end, .. } | Node::Other { end, .. } => *end,
            }
        }

        /// Как и Go encoding/json, при дублях ключа действует последний.
        pub fn get(&self, key: &str) -> Option<&Node> {
            match self {
                Node::Obj { members, .. } => members.iter().rev().find(|m| m.key == key).map(|m| &m.value),
                _ => None,
            }
        }

        pub fn as_str(&self) -> Option<&str> {
            match self {
                Node::Str { value, .. } => Some(value),
                _ => None,
            }
        }
    }

    fn line_of(b: &[u8], pos: usize) -> usize {
        b[..pos.min(b.len())].iter().filter(|c| **c == b'\n').count() + 1
    }

    fn err(b: &[u8], pos: usize, msg: &str) -> String {
        format!("{msg} (строка {})", line_of(b, pos))
    }

    /// Пропускает пробелы и комментарии (`//`, `/* */`, `#` — как json_reader Xray).
    pub fn skip_ws(b: &[u8], mut i: usize) -> Result<usize, String> {
        loop {
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'#' || (b[i] == b'/' && b.get(i + 1) == Some(&b'/'))) {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            } else if i < b.len() && b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                let from = i;
                i += 2;
                loop {
                    if i + 1 >= b.len() {
                        return Err(err(b, from, "Незакрытый комментарий"));
                    }
                    if b[i] == b'*' && b[i + 1] == b'/' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            } else {
                return Ok(i);
            }
        }
    }

    fn string_end(b: &[u8], i: usize) -> Result<usize, String> {
        let mut j = i + 1;
        while j < b.len() {
            match b[j] {
                b'\\' => j += 2,
                b'"' => return Ok(j + 1),
                _ => j += 1,
            }
        }
        Err(err(b, i, "Незакрытая строка"))
    }

    fn parse_string(s: &str, i: usize) -> Result<(String, usize), String> {
        let end = string_end(s.as_bytes(), i)?;
        let raw = &s[i..end];
        let value = serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw[1..raw.len() - 1].to_string());
        Ok((value, end))
    }

    fn parse_value(s: &str, i: usize, depth: usize) -> Result<(Node, usize), String> {
        let b = s.as_bytes();
        if depth > 128 {
            return Err(err(b, i, "Слишком глубокая вложенность"));
        }
        let i = skip_ws(b, i)?;
        if i >= b.len() {
            return Err(err(b, i, "Неожиданный конец файла"));
        }
        match b[i] {
            b'{' => {
                let start = i;
                let mut members = Vec::new();
                let mut j = skip_ws(b, i + 1)?;
                loop {
                    if j >= b.len() {
                        return Err(err(b, start, "Незакрытый объект"));
                    }
                    if b[j] == b'}' {
                        return Ok((Node::Obj { start, end: j + 1, members }, j + 1));
                    }
                    if b[j] != b'"' {
                        return Err(err(b, j, "Ожидался ключ в кавычках"));
                    }
                    let key_start = j;
                    let (key, after) = parse_string(s, j)?;
                    j = skip_ws(b, after)?;
                    if b.get(j) != Some(&b':') {
                        return Err(err(b, j, "Ожидалось «:»"));
                    }
                    let (value, after) = parse_value(s, j + 1, depth + 1)?;
                    members.push(Member { key, key_start, value });
                    j = skip_ws(b, after)?;
                    match b.get(j) {
                        Some(b',') => j = skip_ws(b, j + 1)?,
                        Some(b'}') => {}
                        _ => return Err(err(b, j, "Ожидалось «,» или «}»")),
                    }
                }
            }
            b'[' => {
                let start = i;
                let mut items = Vec::new();
                let mut j = skip_ws(b, i + 1)?;
                loop {
                    if j >= b.len() {
                        return Err(err(b, start, "Незакрытый массив"));
                    }
                    if b[j] == b']' {
                        return Ok((Node::Arr { start, end: j + 1, items }, j + 1));
                    }
                    let (value, after) = parse_value(s, j, depth + 1)?;
                    items.push(value);
                    j = skip_ws(b, after)?;
                    match b.get(j) {
                        Some(b',') => j = skip_ws(b, j + 1)?,
                        Some(b']') => {}
                        _ => return Err(err(b, j, "Ожидалось «,» или «]»")),
                    }
                }
            }
            b'"' => {
                let (value, end) = parse_string(s, i)?;
                Ok((Node::Str { start: i, end, value }, end))
            }
            _ => {
                let mut j = i;
                while j < b.len() && !b[j].is_ascii_whitespace() && !matches!(b[j], b',' | b']' | b'}' | b'/' | b'#') {
                    j += 1;
                }
                if j == i {
                    return Err(err(b, i, "Неожиданный символ"));
                }
                Ok((Node::Other { start: i, end: j }, j))
            }
        }
    }

    pub fn parse(s: &str) -> Result<Node, String> {
        let (node, end) = parse_value(s, 0, 0)?;
        let end = skip_ws(s.as_bytes(), end)?;
        if end != s.len() {
            return Err(err(s.as_bytes(), end, "Лишние данные после JSON"));
        }
        Ok(node)
    }

    /// Убирает комментарии (строки не трогает) — для строгого JSON-парсера.
    pub fn strip_comments(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'"' => {
                    let end = string_end(b, i).unwrap_or(b.len());
                    out.extend_from_slice(&b[i..end]);
                    i = end;
                }
                b'#' => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                }
                b'/' if b.get(i + 1) == Some(&b'/') => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                }
                b'/' if b.get(i + 1) == Some(&b'*') => {
                    i += 2;
                    while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                        if b[i] == b'\n' {
                            out.push(b'\n');
                        }
                        i += 1;
                    }
                    i = (i + 2).min(b.len());
                    out.push(b' ');
                }
                c => {
                    out.push(c);
                    i += 1;
                }
            }
        }
        // Вырезаются только ASCII-ограниченные куски, UTF-8 остаётся корректным.
        String::from_utf8(out).unwrap_or_default()
    }
}

use jsonc::Node;

fn line_start(b: &[u8], pos: usize) -> usize {
    b[..pos].iter().rposition(|c| *c == b'\n').map_or(0, |p| p + 1)
}

fn line_indent(s: &str, pos: usize) -> String {
    let b = s.as_bytes();
    let ls = line_start(b, pos);
    b[ls..pos].iter().take_while(|c| **c == b' ' || **c == b'\t').map(|c| *c as char).collect()
}

/// Отступ строки, если до `pos` на ней только пробелы.
fn indent_if_alone(s: &str, pos: usize) -> Option<String> {
    let b = s.as_bytes();
    let ls = line_start(b, pos);
    b[ls..pos].iter().all(|c| *c == b' ' || *c == b'\t').then(|| s[ls..pos].to_string())
}

fn reindent(value: &Value, indent: &str, nl: &str) -> String {
    serde_json::to_string_pretty(value)
        .unwrap_or_default()
        .lines()
        .collect::<Vec<_>>()
        .join(&format!("{nl}{indent}"))
}

fn is_quick_rule(node: &Node) -> bool {
    node.get("ruleTag").and_then(Node::as_str) == Some(RULE_TAG)
}

fn comma_after(b: &[u8], pos: usize) -> Result<usize, String> {
    let p = jsonc::skip_ws(b, pos)?;
    if b.get(p) == Some(&b',') { Ok(p) } else { Err("Не удалось разобрать routing.rules".into()) }
}

/// Диапазоны текста, занятые нашими правилами (с разделителями).
fn removal_ranges(b: &[u8], arr_start: usize, arr_end: usize, items: &[Node]) -> Result<Vec<(usize, usize)>, String> {
    let ours: Vec<bool> = items.iter().map(is_quick_rule).collect();
    let n = items.len();
    let mut ranges = Vec::new();
    let mut k = 0;
    while k < n {
        if !ours[k] {
            k += 1;
            continue;
        }
        let i = k;
        while k < n && ours[k] {
            k += 1;
        }
        let j = k - 1;
        if k < n {
            let comma = comma_after(b, items[j].end())?;
            let mut end = comma + 1;
            let mut e = end;
            while e < b.len() && matches!(b[e], b' ' | b'\t' | b'\r') {
                e += 1;
            }
            let mut start = items[i].start();
            if e < b.len() && b[e] == b'\n' {
                end = e + 1;
                let ls = line_start(b, start);
                if b[ls..start].iter().all(|c| *c == b' ' || *c == b'\t') {
                    start = ls;
                }
            }
            ranges.push((start, end));
        } else if i > 0 {
            ranges.push((items[i - 1].end(), items[j].end()));
        } else {
            ranges.push((arr_start + 1, arr_end - 1));
        }
    }
    Ok(ranges)
}

/// Вставка `"key": value` первым членом объекта. Возвращает (from, to, текст) для замены.
fn object_insert(text: &str, obj: &Node, key: &str, value: &Value, nl: &str) -> (usize, usize, String) {
    let Node::Obj { start, end, members } = obj else { unreachable!() };
    let base = line_indent(text, *start);
    let indent = members
        .first()
        .and_then(|m| indent_if_alone(text, m.key_start))
        .unwrap_or_else(|| format!("{base}  "));
    let mut s = format!("{nl}{indent}{}: {}", serde_json::to_string(key).unwrap_or_default(), reindent(value, &indent, nl));
    if members.is_empty() {
        s.push_str(nl);
        s.push_str(&base);
        let inner = &text[start + 1..end - 1];
        let to = if inner.trim().is_empty() { end - 1 } else { start + 1 };
        (start + 1, to, s)
    } else {
        s.push(',');
        (start + 1, start + 1, s)
    }
}

fn array_insert(text: &str, arr: &Node, rules: &[Value], nl: &str) -> (usize, usize, String) {
    let Node::Arr { start, end, items } = arr else { unreachable!() };
    let base = line_indent(text, *start);
    let indent = items
        .first()
        .and_then(|f| indent_if_alone(text, f.start()))
        .unwrap_or_else(|| format!("{base}  "));
    let mut s = String::new();
    for (i, rule) in rules.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(nl);
        s.push_str(&indent);
        s.push_str(&reindent(rule, &indent, nl));
    }
    if items.is_empty() {
        s.push_str(nl);
        s.push_str(&base);
        let inner = &text[start + 1..end - 1];
        let to = if inner.trim().is_empty() { end - 1 } else { start + 1 };
        (start + 1, to, s)
    } else {
        s.push(',');
        (start + 1, start + 1, s)
    }
}

/// Заменяет наш блок в начале `routing.rules` (создавая routing/rules при необходимости).
fn set_xray_quick_rules(text: &str, rules: &[Value]) -> Result<String, String> {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = if text.trim().is_empty() { format!("{{}}{nl}") } else { text.to_string() };

    {
        let root = jsonc::parse(&out)?;
        if !matches!(root, Node::Obj { .. }) {
            return Err("Корень конфигурации должен быть объектом".into());
        }
        if let Some(Node::Arr { start, end, items }) = root.get("routing").and_then(|r| r.get("rules")) {
            let ranges = removal_ranges(out.as_bytes(), *start, *end, items)?;
            for (a, b) in ranges.into_iter().rev() {
                out.replace_range(a..b, "");
            }
        }
    }
    if rules.is_empty() {
        return Ok(out);
    }

    let root = jsonc::parse(&out)?;
    let (from, to, insert) = match root.get("routing") {
        None => object_insert(&out, &root, "routing", &json!({ "rules": rules }), nl),
        Some(routing @ Node::Obj { .. }) => match routing.get("rules") {
            None => object_insert(&out, routing, "rules", &Value::Array(rules.to_vec()), nl),
            Some(arr @ Node::Arr { .. }) => array_insert(&out, arr, rules, nl),
            Some(_) => return Err("routing.rules должен быть массивом".into()),
        },
        Some(_) => return Err("routing должен быть объектом".into()),
    };
    out.replace_range(from..to, &insert);
    Ok(out)
}

// ─── Xray: инвентаризация и план изменений ───────────────────────────────────

#[derive(Default, Debug)]
struct XrayInventory {
    /// (tag, protocol) в порядке итогового мержа
    outbounds: Vec<(String, String)>,
    balancers: Vec<String>,
    routing_file: Option<String>,
}

fn xray_inventory(files: &[(String, String)]) -> Result<XrayInventory, String> {
    let mut inv = XrayInventory::default();
    for (name, content) in files {
        if name == XRAY_TAIL_FILE {
            continue;
        }
        let value: Value = serde_json::from_str(&jsonc::strip_comments(content)).map_err(|e| format!("Не удалось разобрать {name}: {e}"))?;
        if let Some(outbounds) = value.get("outbounds").and_then(Value::as_array) {
            for ob in outbounds {
                let tag = ob.get("tag").and_then(Value::as_str).unwrap_or("").to_string();
                let protocol = ob.get("protocol").and_then(Value::as_str).unwrap_or("").to_string();
                if tag.is_empty() {
                    continue;
                }
                inv.outbounds.retain(|(t, _)| *t != tag);
                inv.outbounds.push((tag, protocol));
            }
        }
        if let Some(routing) = value.get("routing") {
            inv.routing_file = Some(name.clone());
            inv.balancers = routing
                .get("balancers")
                .and_then(Value::as_array)
                .map(|bs| bs.iter().filter_map(|b| b.get("tag")?.as_str().map(String::from)).collect())
                .unwrap_or_default();
        }
    }
    Ok(inv)
}

fn find_outbound(inv: &XrayInventory, protocol: &str, preferred: &str) -> Option<String> {
    inv.outbounds
        .iter()
        .find(|(t, p)| p == protocol && t == preferred)
        .or_else(|| inv.outbounds.iter().find(|(_, p)| p == protocol))
        .map(|(t, _)| t.clone())
}

fn xray_value(rule: &QuickRule) -> String {
    let v = &rule.value;
    match rule.kind {
        RuleKind::Domain => format!("domain:{v}"),
        RuleKind::Full => format!("full:{v}"),
        RuleKind::Keyword => v.clone(),
        RuleKind::Regexp => format!("regexp:{v}"),
        RuleKind::Geosite => format!("geosite:{v}"),
        RuleKind::Ip | RuleKind::Cidr => v.clone(),
        RuleKind::Geoip => format!("geoip:{v}"),
    }
}

fn build_xray_rules(
    enabled: &[&QuickRule], direct: Option<&str>, block: Option<&str>, outbounds: &HashSet<String>, balancers: &HashSet<String>,
) -> Vec<Value> {
    let mut groups: Vec<((u8, bool, String), Vec<String>)> = Vec::new();
    for rule in enabled {
        let tag = match rule.target.kind {
            TargetKind::Direct => direct.unwrap_or(XRAY_DIRECT_TAG).to_string(),
            TargetKind::Block => block.unwrap_or(XRAY_BLOCK_TAG).to_string(),
            TargetKind::Proxy => rule.target.tag.clone(),
        };
        let key = (rule.kind.level(), rule.kind.is_ip(), tag);
        let value = xray_value(rule);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, values)) => values.push(value),
            None => groups.push((key, vec![value])),
        }
    }
    groups.sort_by_key(|((level, ..), _)| *level);
    groups
        .into_iter()
        .map(|((_, is_ip, tag), values)| {
            let mut rule = serde_json::Map::new();
            rule.insert("type".into(), json!("field"));
            rule.insert("ruleTag".into(), json!(RULE_TAG));
            rule.insert(if is_ip { "ip" } else { "domain" }.into(), json!(values));
            let key = if !outbounds.contains(&tag) && balancers.contains(&tag) { "balancerTag" } else { "outboundTag" };
            rule.insert(key.into(), json!(tag));
            Value::Object(rule)
        })
        .collect()
}

type FileChanges = Vec<(String, Option<String>)>;

/// План изменений файлов confdir: (имя файла, новое содержимое | None = удалить).
fn plan_xray(files: &[(String, String)], rules: &[QuickRule]) -> Result<FileChanges, String> {
    let inv = xray_inventory(files)?;
    let enabled: Vec<&QuickRule> = rules.iter().filter(|r| r.enabled).collect();
    let outbounds: HashSet<String> = inv.outbounds.iter().map(|(t, _)| t.clone()).collect();
    let balancers: HashSet<String> = inv.balancers.iter().cloned().collect();

    for rule in &enabled {
        if rule.target.kind == TargetKind::Proxy && !outbounds.contains(&rule.target.tag) && !balancers.contains(&rule.target.tag) {
            return Err(format!("Подключение «{}» не найдено в конфигурации Xray", rule.target.tag));
        }
    }

    let mut tail_outbounds = Vec::new();
    let direct = if enabled.iter().any(|r| r.target.kind == TargetKind::Direct) {
        Some(find_outbound(&inv, "freedom", "direct").unwrap_or_else(|| {
            tail_outbounds.push(json!({ "tag": XRAY_DIRECT_TAG, "protocol": "freedom" }));
            XRAY_DIRECT_TAG.to_string()
        }))
    } else {
        None
    };
    let block = if enabled.iter().any(|r| r.target.kind == TargetKind::Block) {
        Some(find_outbound(&inv, "blackhole", "block").unwrap_or_else(|| {
            tail_outbounds.push(json!({ "tag": XRAY_BLOCK_TAG, "protocol": "blackhole" }));
            XRAY_BLOCK_TAG.to_string()
        }))
    } else {
        None
    };

    let generated = build_xray_rules(&enabled, direct.as_deref(), block.as_deref(), &outbounds, &balancers);
    let mut changes = Vec::new();

    let routing_name = inv.routing_file.clone().unwrap_or_else(|| XRAY_DEFAULT_ROUTING_FILE.to_string());
    let old = files.iter().find(|(n, _)| *n == routing_name).map(|(_, c)| c.as_str());
    if old.is_some() || !generated.is_empty() {
        let new = set_xray_quick_rules(old.unwrap_or(""), &generated)?;
        if old != Some(new.as_str()) {
            changes.push((routing_name, Some(new)));
        }
    }

    let old_tail = files.iter().find(|(n, _)| n == XRAY_TAIL_FILE).map(|(_, c)| c.as_str());
    if tail_outbounds.is_empty() {
        if old_tail.is_some() {
            changes.push((XRAY_TAIL_FILE.to_string(), None));
        }
    } else {
        let content = format!("{}\n", serde_json::to_string_pretty(&json!({ "outbounds": tail_outbounds })).unwrap_or_default());
        if old_tail != Some(content.as_str()) {
            changes.push((XRAY_TAIL_FILE.to_string(), Some(content)));
        }
    }
    Ok(changes)
}

// ─── Mihomo: rule-providers + строки RULE-SET ────────────────────────────────

fn mihomo_targets(yaml: &str) -> Result<Vec<(String, &'static str)>, String> {
    let docs = yaml_rust2::YamlLoader::load_from_str(yaml).map_err(|e| format!("Ошибка разбора config.yaml: {e}"))?;
    let mut out = vec![("DIRECT".to_string(), "builtin"), ("REJECT".to_string(), "builtin")];
    let Some(doc) = docs.first() else { return Ok(out) };
    for (key, kind) in [("proxy-groups", "group"), ("proxies", "proxy")] {
        if let Some(items) = doc[key].as_vec() {
            for item in items {
                if let Some(name) = item["name"].as_str()
                    && !out.iter().any(|(n, _)| n == name)
                {
                    out.push((name.to_string(), kind));
                }
            }
        }
    }
    Ok(out)
}

fn mihomo_payload(rule: &QuickRule) -> String {
    let v = &rule.value;
    match rule.kind {
        RuleKind::Domain => format!("DOMAIN-SUFFIX,{v}"),
        RuleKind::Full => format!("DOMAIN,{v}"),
        RuleKind::Keyword => format!("DOMAIN-KEYWORD,{v}"),
        RuleKind::Regexp => format!("DOMAIN-REGEX,{v}"),
        RuleKind::Geosite => format!("GEOSITE,{v}"),
        RuleKind::Ip if v.contains(':') => format!("IP-CIDR6,{v}/128"),
        RuleKind::Ip => format!("IP-CIDR,{v}/32"),
        RuleKind::Cidr if v.contains(':') => format!("IP-CIDR6,{v}"),
        RuleKind::Cidr => format!("IP-CIDR,{v}"),
        RuleKind::Geoip => format!("GEOIP,{}", v.to_ascii_uppercase()),
    }
}

fn yaml_dq(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn is_top_key(line: &str, key: &str) -> bool {
    [key.to_string(), format!("\"{key}\""), format!("'{key}'")]
        .iter()
        .any(|k| line.starts_with(k.as_str()) && line[k.len()..].starts_with(':'))
}

fn top_block_end(lines: &[String], idx: usize) -> usize {
    (idx + 1..lines.len())
        .find(|&j| {
            let l = &lines[j];
            !l.is_empty() && !matches!(l.as_bytes()[0], b' ' | b'\t' | b'#' | b'-')
        })
        .unwrap_or(lines.len())
}

/// `key: []` / `key: {}` / `key: null` → `key:`; иной однострочный вид не поддерживаем.
fn normalize_inline(line: &mut String, key: &str) -> Result<(), String> {
    let rest = &line[line.find(':').map_or(line.len(), |p| p + 1)..];
    let value = match rest.find('#') {
        Some(p) if p == 0 || rest.as_bytes()[p - 1].is_ascii_whitespace() => &rest[..p],
        _ => rest,
    }
    .trim();
    match value {
        "" => Ok(()),
        "[]" | "{}" | "~" | "null" => {
            *line = format!("{key}:");
            Ok(())
        }
        _ => Err(format!("Ключ «{key}» в config.yaml записан в однострочном виде — переведите его в многострочный вручную")),
    }
}

fn append_block(lines: &mut Vec<String>, block: Vec<String>) {
    let at = if lines.last().is_some_and(|l| l.is_empty()) { lines.len() - 1 } else { lines.len() };
    for (offset, line) in block.into_iter().enumerate() {
        lines.insert(at + offset, line);
    }
}

fn line_indent_str(line: &str) -> String {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').collect()
}

fn set_mihomo_rules(lines: &mut Vec<String>, rule_lines: &[String]) -> Result<(), String> {
    let marker = format!("RULE-SET,{MIHOMO_PROVIDER_PREFIX}");
    let Some(i) = lines.iter().position(|l| is_top_key(l, "rules")) else {
        if !rule_lines.is_empty() {
            let mut block = vec!["rules:".to_string()];
            block.extend(rule_lines.iter().map(|r| format!("  - {} # {RULE_TAG}", yaml_dq(r))));
            append_block(lines, block);
        }
        return Ok(());
    };
    normalize_inline(&mut lines[i], "rules")?;
    let mut end = top_block_end(lines, i);
    let mut j = i + 1;
    while j < end {
        if lines[j].contains(&marker) {
            lines.remove(j);
            end -= 1;
        } else {
            j += 1;
        }
    }
    let prefix = (i + 1..end).find_map(|j| {
        let t = lines[j].trim_start();
        (t.starts_with("- ") || t == "-").then(|| line_indent_str(&lines[j]))
    });
    if rule_lines.is_empty() && prefix.is_none() {
        lines[i] = "rules: []".into();
        return Ok(());
    }
    let prefix = prefix.unwrap_or_else(|| "  ".into());
    for (offset, rule) in rule_lines.iter().enumerate() {
        lines.insert(i + 1 + offset, format!("{prefix}- {} # {RULE_TAG}", yaml_dq(rule)));
    }
    Ok(())
}

fn provider_entry(indent: &str, name: &str) -> Vec<String> {
    vec![
        format!("{indent}{name}:"),
        format!("{indent}  type: file"),
        format!("{indent}  behavior: classical"),
        format!("{indent}  format: text"),
        format!("{indent}  path: ./{MIHOMO_PROVIDER_DIR}/{name}.txt"),
    ]
}

fn set_mihomo_providers(lines: &mut Vec<String>, providers: &[String]) -> Result<(), String> {
    let Some(i) = lines.iter().position(|l| is_top_key(l, "rule-providers")) else {
        if !providers.is_empty() {
            let mut block = vec!["rule-providers:".to_string()];
            for name in providers {
                block.extend(provider_entry("  ", name));
            }
            append_block(lines, block);
        }
        return Ok(());
    };
    normalize_inline(&mut lines[i], "rule-providers")?;
    let mut end = top_block_end(lines, i);
    let mut j = i + 1;
    while j < end {
        let indent = line_indent_str(&lines[j]).len();
        let key = lines[j].trim_start().trim_start_matches(['"', '\'']);
        if indent > 0 && key.starts_with(MIHOMO_PROVIDER_PREFIX) {
            let mut k = j + 1;
            while k < end {
                let t = lines[k].trim_start();
                if !t.is_empty() && !t.starts_with('#') && line_indent_str(&lines[k]).len() <= indent {
                    break;
                }
                k += 1;
            }
            lines.drain(j..k);
            end -= k - j;
        } else {
            j += 1;
        }
    }
    let child_indent = (i + 1..end).find_map(|j| {
        let t = lines[j].trim_start();
        (!t.is_empty() && !t.starts_with('#')).then(|| line_indent_str(&lines[j]))
    });
    if providers.is_empty() && child_indent.is_none() {
        lines[i] = "rule-providers: {}".into();
        return Ok(());
    }
    let child_indent = child_indent.filter(|c| !c.is_empty()).unwrap_or_else(|| "  ".into());
    let mut at = i + 1;
    for name in providers {
        for line in provider_entry(&child_indent, name) {
            lines.insert(at, line);
            at += 1;
        }
    }
    Ok(())
}

fn set_mihomo_yaml(text: &str, rule_lines: &[String], providers: &[String]) -> Result<String, String> {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
    set_mihomo_rules(&mut lines, rule_lines)?;
    set_mihomo_providers(&mut lines, providers)?;
    Ok(lines.join(nl))
}

struct MihomoPlan {
    config: String,
    /// (имя файла в quick-rules/, содержимое | None = удалить)
    files: FileChanges,
}

fn plan_mihomo(config: &str, rules: &[QuickRule], existing_files: &[String]) -> Result<MihomoPlan, String> {
    let targets = mihomo_targets(config)?;
    let enabled: Vec<&QuickRule> = rules.iter().filter(|r| r.enabled).collect();
    for rule in &enabled {
        if rule.target.kind == TargetKind::Proxy && !targets.iter().any(|(n, _)| *n == rule.target.tag) {
            return Err(format!("Прокси или группа «{}» не найдены в config.yaml", rule.target.tag));
        }
    }

    let mut groups: Vec<((bool, u8, String), Vec<String>)> = Vec::new();
    for rule in &enabled {
        let target = match rule.target.kind {
            TargetKind::Direct => "DIRECT".to_string(),
            TargetKind::Block => "REJECT".to_string(),
            TargetKind::Proxy => rule.target.tag.clone(),
        };
        let key = (rule.kind.is_ip(), rule.kind.level(), target);
        let line = mihomo_payload(rule);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, lines)) => lines.push(line),
            None => groups.push((key, vec![line])),
        }
    }
    groups.sort_by_key(|((is_ip, level, _), _)| (*is_ip, *level));

    let mut rule_lines = Vec::new();
    let mut names = Vec::new();
    let mut files = Vec::new();
    for ((is_ip, level, target), payload) in groups {
        let name = format!(
            "{MIHOMO_PROVIDER_PREFIX}{}{level}-{:08x}",
            if is_ip { 'i' } else { 'd' },
            fnv1a32(target.as_bytes())
        );
        if names.contains(&name) {
            return Err("Коллизия имён rule-provider — переименуйте группу".into());
        }
        rule_lines.push(format!("RULE-SET,{name},{target}{}", if is_ip { ",no-resolve" } else { "" }));
        files.push((format!("{name}.txt"), Some(format!("{}\n", payload.join("\n")))));
        names.push(name);
    }
    for existing in existing_files {
        if !files.iter().any(|(f, _)| f == existing) {
            files.push((existing.clone(), None));
        }
    }

    let new_config = set_mihomo_yaml(config, &rule_lines, &names)?;
    let docs = yaml_rust2::YamlLoader::load_from_str(&new_config).map_err(|e| format!("После правки config.yaml стал некорректным: {e}"))?;
    if !names.is_empty() && docs.first().and_then(|d| d["rule-providers"].as_hash()).is_none() {
        return Err("Не удалось добавить rule-providers в config.yaml".into());
    }
    Ok(MihomoPlan { config: new_config, files })
}

// ─── Файловые операции и применение ──────────────────────────────────────────

async fn write_atomic(path: &str, content: &str) -> Result<(), String> {
    let tmp = format!("{path}.xkeen-ui.tmp");
    tokio::fs::write(&tmp, content).await.map_err(|e| format!("Ошибка записи {path}: {e}"))?;
    tokio::fs::rename(&tmp, path).await.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Ошибка записи {path}: {e}")
    })
}

/// Записывает/удаляет файлы; при ошибке возвращает всё как было.
async fn write_changes(dir: &str, changes: &FileChanges) -> Result<Vec<(String, Option<String>)>, String> {
    let mut backups = Vec::new();
    for (name, content) in changes {
        let path = format!("{dir}/{name}");
        let old = tokio::fs::read_to_string(&path).await.ok();
        let result = match content {
            Some(c) => write_atomic(&path, c).await,
            None => match tokio::fs::remove_file(&path).await {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Ошибка удаления {path}: {e}")),
                _ => Ok(()),
            },
        };
        backups.push((path, old));
        if let Err(e) = result {
            restore(&backups).await;
            return Err(e);
        }
    }
    Ok(backups)
}

async fn restore(backups: &[(String, Option<String>)]) {
    for (path, old) in backups.iter().rev() {
        match old {
            Some(c) => {
                let _ = tokio::fs::write(path, c).await;
            }
            None => {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
    }
}

async fn read_xray_files() -> Result<Vec<(String, String)>, String> {
    let mut files = Vec::new();
    let mut entries = match tokio::fs::read_dir(XRAY_CONF_DIR).await {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(e) => return Err(format!("Не удалось открыть {XRAY_CONF_DIR}: {e}")),
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("json") || e.eq_ignore_ascii_case("jsonc"));
        if !is_json || !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(String::from) else { continue };
        let content = tokio::fs::read_to_string(&path).await.map_err(|e| format!("Не удалось прочитать {name}: {e}"))?;
        files.push((name, content));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

async fn apply_xray(rules: &[QuickRule]) -> Result<Option<String>, String> {
    let files = read_xray_files().await?;
    let changes = plan_xray(&files, rules)?;
    if changes.is_empty() {
        return Ok(None);
    }

    let mut set: Vec<(String, String)> = files;
    for (name, content) in &changes {
        set.retain(|(n, _)| n != name);
        if let Some(c) = content {
            set.push((name.clone(), c.clone()));
        }
    }
    let to_validate = set
        .iter()
        .map(|(n, c)| (format!("{XRAY_CONF_DIR}/{n}"), jsonc::strip_comments(c)))
        .collect();
    if let Err(e) = configs::validate_xray_files(to_validate).await {
        log("ERROR", format!("Быстрые правила: Xray отклонил конфигурацию: {e}"));
        return Err(format!("Xray отклонил конфигурацию, изменения не применены:\n{}", last_lines(&e, 3)));
    }

    let backups = write_changes(XRAY_CONF_DIR, &changes).await?;
    let running = !tokio::task::spawn_blocking(|| controller::get_pid("xray")).await.unwrap_or_default().is_empty();
    if !running {
        return Ok(Some("Xray не запущен — правила применятся при следующем запуске".into()));
    }
    if let Err(e) = controller::soft_restart("xray").await {
        restore(&backups).await;
        let _ = controller::soft_restart("xray").await;
        return Err(format!("Не удалось перезапустить Xray: {e}"));
    }
    Ok(None)
}

fn mihomo_provider_dir() -> String {
    format!("{MIHOMO_CONF_DIR}/{MIHOMO_PROVIDER_DIR}")
}

async fn list_provider_files() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(mihomo_provider_dir()).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Some(name) = entry.file_name().to_str()
                && name.starts_with(MIHOMO_PROVIDER_PREFIX)
                && name.ends_with(".txt")
            {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    out
}

async fn apply_mihomo(state: &AppState, rules: &[QuickRule]) -> Result<Option<String>, String> {
    let config_path = format!("{MIHOMO_CONF_DIR}/config.yaml");
    let config = tokio::fs::read_to_string(&config_path)
        .await
        .map_err(|e| format!("Не удалось прочитать {config_path}: {e}"))?;
    let existing = list_provider_files().await;
    let plan = plan_mihomo(&config, rules, &existing)?;
    if plan.config == config && plan.files.iter().all(|(_, c)| c.is_none()) && existing.is_empty() {
        return Ok(None);
    }

    let dir = mihomo_provider_dir();
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Не удалось создать {dir}: {e}"))?;
    let backups = write_changes(&dir, &plan.files).await?;

    let response = configs::apply_mihomo_hot_reload(state, &config_path, &plan.config, false).await;
    if response.0.success {
        return Ok(None);
    }
    let error = response.0.error.clone().unwrap_or_default();
    if error == configs::HOT_RELOAD_UNAVAILABLE {
        return Ok(Some("Mihomo не запущен или Clash API недоступен — правила применятся при следующем запуске".into()));
    }
    restore(&backups).await;
    Err("Mihomo отклонил конфигурацию, изменения отменены (подробности в журнале)".into())
}

// ─── Хранилище списка ────────────────────────────────────────────────────────

async fn load_store() -> Result<Store, String> {
    match tokio::fs::read_to_string(QUICK_RULES_FILE).await {
        Ok(content) => serde_json::from_str(&content).map_err(|e| format!("Ошибка разбора {QUICK_RULES_FILE}: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(format!("Ошибка чтения {QUICK_RULES_FILE}: {e}")),
    }
}

async fn save_store(store: &Store) -> Result<(), String> {
    if let Some(dir) = Path::new(QUICK_RULES_FILE).parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    write_atomic(QUICK_RULES_FILE, &content).await
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CoreQuery {
    core: Option<String>,
}

fn resolve_core(state: &AppState, requested: Option<&str>) -> Core {
    let name = requested.map(String::from).unwrap_or_else(|| state.core.read().unwrap().name.clone());
    if name == "mihomo" { Core::Mihomo } else { Core::Xray }
}

async fn targets_for(core: Core) -> (Value, Vec<String>) {
    let mut warnings = Vec::new();
    let targets = match core {
        Core::Xray => match read_xray_files().await.and_then(|files| xray_inventory(&files)) {
            Ok(inv) => json!({
                "items": inv.outbounds.iter().map(|(t, p)| json!({ "tag": t, "kind": "outbound", "protocol": p }))
                    .chain(inv.balancers.iter().map(|t| json!({ "tag": t, "kind": "balancer" })))
                    .collect::<Vec<_>>(),
                "directTag": find_outbound(&inv, "freedom", "direct"),
                "blockTag": find_outbound(&inv, "blackhole", "block"),
                "routingFile": inv.routing_file.unwrap_or_else(|| XRAY_DEFAULT_ROUTING_FILE.into()),
            }),
            Err(e) => {
                warnings.push(e);
                json!({ "items": [] })
            }
        },
        Core::Mihomo => {
            let path = format!("{MIHOMO_CONF_DIR}/config.yaml");
            match tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string()).and_then(|c| mihomo_targets(&c)) {
                Ok(list) => json!({
                    "items": list.iter().map(|(n, k)| json!({ "tag": n, "kind": k })).collect::<Vec<_>>(),
                }),
                Err(e) => {
                    warnings.push(e);
                    json!({ "items": [] })
                }
            }
        }
    };
    (targets, warnings)
}

pub async fn get_quick_rules(State(state): State<AppState>, Query(query): Query<CoreQuery>) -> impl IntoResponse {
    let core = resolve_core(&state, query.core.as_deref());
    let store = match load_store().await {
        Ok(s) => s,
        Err(e) => return Json(json!({ "success": false, "error": e })),
    };
    let rules = match core {
        Core::Xray => store.xray,
        Core::Mihomo => store.mihomo,
    };
    let (targets, warnings) = targets_for(core).await;
    Json(json!({ "success": true, "core": core.name(), "rules": rules, "targets": targets, "warnings": warnings }))
}

#[derive(Deserialize)]
pub struct PutReq {
    core: Option<String>,
    rules: Vec<QuickRule>,
}

pub async fn put_quick_rules(State(state): State<AppState>, Json(req): Json<PutReq>) -> impl IntoResponse {
    let _guard = LOCK.lock().await;
    let core = resolve_core(&state, req.core.as_deref());
    let rules = match normalize_all(req.rules) {
        Ok(r) => r,
        Err(e) => return Json(json!({ "success": false, "error": e })),
    };
    let mut store = match load_store().await {
        Ok(s) => s,
        Err(e) => return Json(json!({ "success": false, "error": e })),
    };

    let applied = match core {
        Core::Xray => apply_xray(&rules).await,
        Core::Mihomo => apply_mihomo(&state, &rules).await,
    };
    let warning = match applied {
        Ok(w) => w,
        Err(e) => return Json(json!({ "success": false, "error": e })),
    };

    match core {
        Core::Xray => store.xray = rules.clone(),
        Core::Mihomo => store.mihomo = rules.clone(),
    }
    if let Err(e) = save_store(&store).await {
        return Json(json!({ "success": false, "error": format!("Правила применены, но список не сохранён: {e}") }));
    }
    log(
        "INFO",
        format!("Быстрые правила {} применены: {} шт.", core.name(), rules.iter().filter(|r| r.enabled).count()),
    );
    Json(json!({ "success": true, "rules": rules, "warning": warning }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(value: &str, kind: RuleKind, target: TargetKind, tag: &str) -> QuickRule {
        QuickRule {
            id: String::new(),
            value: value.into(),
            kind,
            target: Target { kind: target, tag: tag.into() },
            enabled: true,
            comment: String::new(),
            created: 0,
        }
    }

    fn parse_strict(text: &str) -> Value {
        serde_json::from_str(&jsonc::strip_comments(text)).expect("valid json")
    }

    #[test]
    fn normalize_values() {
        assert_eq!(normalize_value(RuleKind::Domain, " *.YouTube.com ").unwrap(), "youtube.com");
        assert_eq!(normalize_value(RuleKind::Domain, "domain:example.org").unwrap(), "example.org");
        assert!(normalize_value(RuleKind::Ip, "192.168.001.1").is_err());
        assert_eq!(normalize_value(RuleKind::Ip, "1.1.1.1").unwrap(), "1.1.1.1");
        assert_eq!(normalize_value(RuleKind::Cidr, "10.0.0.0 / 8").unwrap(), "10.0.0.0/8");
        assert!(normalize_value(RuleKind::Cidr, "10.0.0.0/33").is_err());
        assert_eq!(normalize_value(RuleKind::Cidr, "2001:db8::/32").unwrap(), "2001:db8::/32");
        assert_eq!(normalize_value(RuleKind::Geosite, "geosite:Category-Ads-All").unwrap(), "category-ads-all");
        assert!(normalize_value(RuleKind::Regexp, "(unclosed").is_err());
        assert!(normalize_value(RuleKind::Keyword, "goo gle").is_err());
    }

    #[test]
    fn rejects_injection() {
        assert!(normalize_value(RuleKind::Domain, "a.com\nrules:").is_err());
        assert!(normalize_value(RuleKind::Domain, "a.com,DIRECT").is_err());
        assert!(normalize_value(RuleKind::Regexp, "a,b").is_err());
        assert!(normalize_value(RuleKind::Domain, "пример.рф").is_err());
        let r = rule("a.com", RuleKind::Domain, TargetKind::Proxy, "x\ny");
        assert!(normalize_rule(r).is_err());
        let r = rule("a.com", RuleKind::Domain, TargetKind::Proxy, "a,b");
        assert!(normalize_rule(r).is_err());
    }

    #[test]
    fn duplicates_rejected() {
        let rules = vec![
            rule("A.com", RuleKind::Domain, TargetKind::Direct, ""),
            rule("a.com", RuleKind::Domain, TargetKind::Block, ""),
        ];
        assert!(normalize_all(rules).is_err());
    }

    const ROUTING: &str = r#"{
  // пользовательский комментарий
  "routing": {
    "domainStrategy": "IPIfNonMatch",
    "rules": [
      // в прокси всё
      {
        "type": "field",
        "inboundTag": ["redirect", "tproxy"],
        "outboundTag": "vless-reality"
      }
    ]
  }
}
"#;

    fn sample_rules() -> Vec<Value> {
        vec![json!({ "type": "field", "ruleTag": RULE_TAG, "domain": ["domain:example.com"], "outboundTag": "direct" })]
    }

    #[test]
    fn xray_insert_preserves_comments_and_is_idempotent() {
        let once = set_xray_quick_rules(ROUTING, &sample_rules()).unwrap();
        assert!(once.contains("// пользовательский комментарий"));
        assert!(once.contains("// в прокси всё"));
        let v = parse_strict(&once);
        let rules = v["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0]["ruleTag"], RULE_TAG);
        assert_eq!(rules[1]["outboundTag"], "vless-reality");

        let twice = set_xray_quick_rules(&once, &sample_rules()).unwrap();
        assert_eq!(once, twice);

        let removed = set_xray_quick_rules(&once, &[]).unwrap();
        assert_eq!(parse_strict(&removed), parse_strict(ROUTING));
        assert!(removed.contains("// в прокси всё"));
    }

    #[test]
    fn xray_creates_missing_routing_and_rules() {
        let out = set_xray_quick_rules("{\n  \"log\": {}\n}\n", &sample_rules()).unwrap();
        assert_eq!(parse_strict(&out)["routing"]["rules"][0]["outboundTag"], "direct");
        assert_eq!(parse_strict(&out)["log"], json!({}));

        let out = set_xray_quick_rules("{\"routing\": {\"domainStrategy\": \"AsIs\"}}", &sample_rules()).unwrap();
        assert_eq!(parse_strict(&out)["routing"]["domainStrategy"], "AsIs");
        assert_eq!(parse_strict(&out)["routing"]["rules"].as_array().unwrap().len(), 1);

        let out = set_xray_quick_rules("{\"routing\": {\"rules\": []}}", &sample_rules()).unwrap();
        assert_eq!(parse_strict(&out)["routing"]["rules"].as_array().unwrap().len(), 1);
        let back = set_xray_quick_rules(&out, &[]).unwrap();
        assert_eq!(parse_strict(&back)["routing"]["rules"], json!([]));

        let out = set_xray_quick_rules("", &sample_rules()).unwrap();
        assert_eq!(parse_strict(&out)["routing"]["rules"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn xray_removes_quick_rules_anywhere() {
        let text = r#"{"routing":{"rules":[
  {"type":"field","outboundTag":"a","domain":["x.com"]},
  {"type":"field","ruleTag":"xkeen-ui-quick","outboundTag":"b","domain":["y.com"]}
]}}"#;
        let out = set_xray_quick_rules(text, &[]).unwrap();
        let rules = parse_strict(&out)["routing"]["rules"].as_array().unwrap().clone();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0]["outboundTag"], "a");
    }

    #[test]
    fn xray_rules_order_and_targets() {
        let rules = [
            rule("example.com", RuleKind::Domain, TargetKind::Direct, ""),
            rule("api.example.com", RuleKind::Full, TargetKind::Proxy, "proxy"),
            rule("1.1.1.1", RuleKind::Ip, TargetKind::Proxy, "balancer-1"),
            rule("ads", RuleKind::Geosite, TargetKind::Block, ""),
        ];
        let refs: Vec<&QuickRule> = rules.iter().collect();
        let outbounds: HashSet<String> = ["proxy".to_string()].into();
        let balancers: HashSet<String> = ["balancer-1".to_string()].into();
        let built = build_xray_rules(&refs, Some("direct"), Some("block"), &outbounds, &balancers);
        assert_eq!(built.len(), 4);
        assert_eq!(built[0]["domain"], json!(["full:api.example.com"]));
        assert_eq!(built[1]["ip"], json!(["1.1.1.1"]));
        assert_eq!(built[1]["balancerTag"], "balancer-1");
        assert_eq!(built[2]["domain"], json!(["domain:example.com"]));
        assert_eq!(built[2]["outboundTag"], "direct");
        assert_eq!(built[3]["domain"], json!(["geosite:ads"]));
        assert_eq!(built[3]["outboundTag"], "block");
    }

    fn xray_files() -> Vec<(String, String)> {
        vec![
            ("04_outbounds.json".into(), r#"{"outbounds":[{"tag":"vless-reality","protocol":"vless"},{"tag":"direct","protocol":"freedom"}]}"#.into()),
            ("05_routing.json".into(), ROUTING.into()),
        ]
    }

    #[test]
    fn plan_xray_uses_existing_freedom_and_adds_blackhole_tail() {
        let rules = vec![
            rule("example.com", RuleKind::Domain, TargetKind::Direct, ""),
            rule("ads.com", RuleKind::Domain, TargetKind::Block, ""),
        ];
        let changes = plan_xray(&xray_files(), &rules).unwrap();
        let routing = changes.iter().find(|(n, _)| n == "05_routing.json").unwrap().1.clone().unwrap();
        let v = parse_strict(&routing);
        assert_eq!(v["routing"]["rules"][0]["outboundTag"], "direct");
        assert_eq!(v["routing"]["rules"][1]["outboundTag"], XRAY_BLOCK_TAG);
        let tail = changes.iter().find(|(n, _)| n == XRAY_TAIL_FILE).unwrap().1.clone().unwrap();
        assert_eq!(parse_strict(&tail)["outbounds"][0]["protocol"], "blackhole");

        // Повторное применение поверх результата — без изменений.
        let mut files = xray_files();
        files[1].1 = routing;
        files.push((XRAY_TAIL_FILE.into(), tail));
        assert!(plan_xray(&files, &rules).unwrap().is_empty());

        // Все правила удалены — хвостовой файл тоже.
        let cleared = plan_xray(&files, &[]).unwrap();
        assert!(cleared.iter().any(|(n, c)| n == XRAY_TAIL_FILE && c.is_none()));
    }

    #[test]
    fn plan_xray_rejects_unknown_outbound() {
        let rules = vec![rule("example.com", RuleKind::Domain, TargetKind::Proxy, "nope")];
        assert!(plan_xray(&xray_files(), &rules).is_err());
    }

    #[test]
    fn plan_xray_routing_from_last_file() {
        let mut files = xray_files();
        files.push(("06_override.json".into(), "{\"routing\": {\"rules\": []}}".into()));
        let rules = vec![rule("example.com", RuleKind::Domain, TargetKind::Direct, "")];
        let changes = plan_xray(&files, &rules).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].0, "06_override.json");
    }

    const MIHOMO: &str = "mixed-port: 7890\n# комментарий\nproxies:\n  - name: \"vless\"\n    type: vless\nproxy-groups:\n  - name: 🚀 Proxy\n    type: select\n    proxies: [vless]\nrule-providers:\n  ru:\n    type: http\n    behavior: domain\n    url: https://example.com/ru.mrs\nrules:\n- GEOSITE,ru,DIRECT\n- MATCH,🚀 Proxy\n";

    #[test]
    fn mihomo_plan_inserts_and_removes() {
        let rules = vec![
            rule("example.com", RuleKind::Domain, TargetKind::Direct, ""),
            rule("1.1.1.0/24", RuleKind::Cidr, TargetKind::Proxy, "🚀 Proxy"),
            rule("chat.example.com", RuleKind::Full, TargetKind::Proxy, "vless"),
        ];
        let plan = plan_mihomo(MIHOMO, &rules, &[]).unwrap();
        assert!(plan.config.contains("# комментарий"));
        let docs = yaml_rust2::YamlLoader::load_from_str(&plan.config).unwrap();
        let doc = &docs[0];
        let rules_yaml: Vec<&str> = doc["rules"].as_vec().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
        assert_eq!(rules_yaml.len(), 5);
        assert!(rules_yaml[0].starts_with("RULE-SET,xkeen-ui-quick-d0-") && rules_yaml[0].ends_with(",vless"));
        assert!(rules_yaml[1].starts_with("RULE-SET,xkeen-ui-quick-d1-") && rules_yaml[1].ends_with(",DIRECT"));
        assert!(rules_yaml[2].ends_with(",🚀 Proxy,no-resolve"));
        assert_eq!(rules_yaml[3], "GEOSITE,ru,DIRECT");
        let providers = doc["rule-providers"].as_hash().unwrap();
        assert_eq!(providers.len(), 4);
        assert_eq!(plan.files.len(), 3);
        assert!(plan.files.iter().any(|(_, c)| c.as_deref() == Some("IP-CIDR,1.1.1.0/24\n")));

        let again = plan_mihomo(&plan.config, &rules, &[]).unwrap();
        assert_eq!(again.config, plan.config);

        let existing: Vec<String> = plan.files.iter().map(|(n, _)| n.clone()).collect();
        let cleared = plan_mihomo(&plan.config, &[], &existing).unwrap();
        assert_eq!(cleared.config, MIHOMO);
        assert!(cleared.files.iter().all(|(_, c)| c.is_none()));
    }

    #[test]
    fn mihomo_creates_sections_and_handles_inline_empty() {
        let rules = vec![rule("example.com", RuleKind::Domain, TargetKind::Block, "")];
        let plan = plan_mihomo("mode: rule\nrules: []\n", &rules, &[]).unwrap();
        let docs = yaml_rust2::YamlLoader::load_from_str(&plan.config).unwrap();
        assert_eq!(docs[0]["rules"].as_vec().unwrap().len(), 1);
        assert_eq!(docs[0]["rule-providers"].as_hash().unwrap().len(), 1);

        assert!(plan_mihomo("rules: [MATCH,DIRECT]\n", &rules, &[]).is_err());
    }

    #[test]
    fn mihomo_rejects_unknown_target_and_escapes_quotes() {
        let rules = vec![rule("example.com", RuleKind::Domain, TargetKind::Proxy, "missing")];
        assert!(plan_mihomo(MIHOMO, &rules, &[]).is_err());

        let yaml = "proxy-groups:\n  - name: 'say \"hi\"'\n    type: select\nrules:\n  - MATCH,DIRECT\n";
        let rules = vec![rule("example.com", RuleKind::Domain, TargetKind::Proxy, "say \"hi\"")];
        let plan = plan_mihomo(yaml, &rules, &[]).unwrap();
        let docs = yaml_rust2::YamlLoader::load_from_str(&plan.config).unwrap();
        assert!(docs[0]["rules"][0].as_str().unwrap().ends_with(",say \"hi\""));
    }

    #[test]
    fn jsonc_strip_keeps_strings() {
        let s = "{\"a\": \"http://x/#y\", // c\n \"b\": 1 /* d */}";
        assert_eq!(parse_strict(s), json!({ "a": "http://x/#y", "b": 1 }));
    }
}
