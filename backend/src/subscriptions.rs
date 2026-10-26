//! Автообновление подписок для Xray.
//!
//! Подписка — URL со списком ссылок (`vless://`, `vmess://`, `trojan://`, `ss://`,
//! `hysteria2://`/`hy2://`), plain-текстом или base64. Ссылки разбираются тем же способом, что
//! и во фронтенде (`frontend/src/lib/outboundParser.js` → `generateConfigForCore(.., 'xray')`),
//! и пишутся в отдельный файл `/opt/etc/xray/configs/04_outbounds_sub_<name>_tail.json`.
//!
//! Почему `_tail`: при слиянии конфигов Xray outbounds из следующих файлов добавляются В НАЧАЛО
//! списка (первый outbound — дефолтный), а у файлов со словом `tail` в имени — в конец. Без
//! `tail` первый сервер подписки стал бы маршрутом по умолчанию.
//!
//! Перед заменой файла весь набор конфигов проверяется `xray run -test` (как при сохранении из
//! редактора); при ошибке файл не меняется, ошибка сохраняется в `last_error`. Файл
//! переписывается только при изменении содержимого, затем Xray мягко перезапускается.

use crate::logger::log;
use crate::types::{AppState, XKEEN_CONF_DIR, XRAY_CONF_DIR};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use base64::Engine;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEFAULT_USER_AGENT: &str = "v2rayN/7.13.8";
const MAX_BODY: usize = 4 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Subscription {
    /// Имя (латиница/цифры/`-`/`_`) — часть имени файла и префикс тегов.
    pub name: String,
    pub url: String,
    pub enabled: bool,
    pub interval_hours: u32,
    pub user_agent: String,
}

impl Default for Subscription {
    fn default() -> Self {
        Self {
            name: String::new(),
            url: String::new(),
            enabled: true,
            interval_hours: 12,
            user_agent: String::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SubscriptionsSettings {
    pub items: Vec<Subscription>,
}

/// Результат последнего обновления (переживает перезапуск: `/opt/etc/xkeen/subscriptions_state.json`,
/// пишется только после обновления подписки — раз в несколько часов).
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SubState {
    pub last_update: Option<u64>,
    pub last_success: Option<u64>,
    pub last_error: Option<String>,
    pub count: usize,
    pub skipped: usize,
}

static STATE: LazyLock<Mutex<Option<BTreeMap<String, SubState>>>> = LazyLock::new(|| Mutex::new(None));
static UPDATE_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn state_file() -> String {
    format!("{XKEEN_CONF_DIR}/subscriptions_state.json")
}

fn with_state<R>(f: impl FnOnce(&mut BTreeMap<String, SubState>) -> R) -> R {
    let mut guard = STATE.lock().unwrap();
    let map = guard.get_or_insert_with(|| {
        std::fs::read_to_string(state_file())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    });
    f(map)
}

fn save_state() {
    let json = with_state(|m| serde_json::to_string_pretty(m).unwrap_or_default());
    let path = state_file();
    let tmp = format!("{path}.tmp");
    if let Err(e) = std::fs::create_dir_all(XKEEN_CONF_DIR)
        .and_then(|_| std::fs::write(&tmp, json))
        .and_then(|_| std::fs::rename(&tmp, &path))
    {
        log("WARN", format!("Не удалось сохранить {path}: {e}"));
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Имя подписки → безопасное имя для файла.
pub fn sanitize_name(name: &str) -> String {
    let s: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(32)
        .collect();
    s.trim_matches('_').to_string()
}

pub fn sub_file(name: &str) -> String {
    format!("{XRAY_CONF_DIR}/04_outbounds_sub_{}_tail.json", sanitize_name(name))
}

// ─── Парсер ссылок (порт outboundParser.js) ────────────────────────────────────────────────

static B64: LazyLock<GeneralPurpose> = LazyLock::new(|| {
    GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::Indifferent),
    )
});

/// `safeBase64`: url-safe → standard, паддинг не обязателен.
pub fn safe_base64(s: &str) -> Option<String> {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    let bytes = B64.decode(cleaned.trim_end_matches('=')).ok()?;
    String::from_utf8(bytes).ok()
}

fn pct_decode(s: &str) -> String {
    urlencoding::decode(s).map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string())
}

/// Параметры ссылки: ключ → значение. Поиск сначала по точному имени, затем в нижнем регистре
/// (в JS ключи query приводятся к нижнему регистру, а vmess-JSON берётся как есть).
struct Params(HashMap<String, String>);

impl Params {
    fn get(&self, key: &str) -> Option<&str> {
        self.0
            .get(key)
            .or_else(|| self.0.get(&key.to_ascii_lowercase()))
            .map(String::as_str)
    }
    /// `string(v)` из JS: непустая строка или ничего.
    fn s(&self, key: &str) -> Option<String> {
        self.get(key).filter(|v| !v.is_empty()).map(str::to_string)
    }
    /// `bool(v)`: `true`/`1` → true, иначе — поле не пишется.
    fn b(&self, key: &str) -> Option<bool> {
        matches!(self.get(key), Some("true" | "1")).then_some(true)
    }
    fn n(&self, key: &str) -> Option<Value> {
        let v = self.get(key)?.trim();
        if v.is_empty() {
            return None;
        }
        if let Ok(i) = v.parse::<i64>() {
            return Some(json!(i));
        }
        v.parse::<f64>().ok().filter(|f| f.is_finite()).map(|f| json!(f))
    }
}

fn put(map: &mut Map<String, Value>, key: &str, value: Option<impl Into<Value>>) {
    if let Some(v) = value {
        map.insert(key.into(), v.into());
    }
}

fn obj(pairs: Map<String, Value>) -> Value {
    Value::Object(pairs)
}

fn parse_json_param(p: &Params, key: &str) -> Option<Value> {
    let raw = p.get(key)?;
    serde_json::from_str(raw)
        .ok()
        .or_else(|| serde_json::from_str(&pct_decode(raw)).ok())
}

/// `getStreamSettings(type, params)`.
fn stream_settings(network: &str, p: &Params) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("network".into(), json!(network));
    let security = p.s("security");
    put(&mut out, "security", security.clone());
    let alpn = p
        .s("alpn")
        .map(|a| a.split(',').map(|x| json!(x.trim())).collect::<Vec<_>>());
    match security.as_deref() {
        Some("tls") => {
            let mut tls = Map::new();
            tls.insert("fingerprint".into(), json!(p.s("fp").unwrap_or_else(|| "chrome".into())));
            put(&mut tls, "serverName", p.s("sni"));
            put(&mut tls, "alpn", alpn);
            put(&mut tls, "allowInsecure", p.b("allowinsecure").or(p.b("insecure")));
            out.insert("tlsSettings".into(), obj(tls));
        }
        Some("reality") => {
            let mut r = Map::new();
            r.insert("fingerprint".into(), json!(p.s("fp").unwrap_or_else(|| "chrome".into())));
            put(&mut r, "serverName", p.s("sni"));
            put(&mut r, "publicKey", p.s("pbk"));
            put(&mut r, "shortId", p.s("sid"));
            put(&mut r, "spiderX", p.s("spx"));
            put(&mut r, "mldsa65Verify", p.s("pqv"));
            out.insert("realitySettings".into(), obj(r));
        }
        _ => {}
    }
    put(&mut out, "finalmask", parse_json_param(p, "fm"));

    let header = p.s("headerType").map(|t| json!({ "type": t }));
    match network {
        "tcp" => {
            if let Some(h) = header {
                out.insert("tcpSettings".into(), json!({ "header": h }));
            }
        }
        "raw" => {
            if let Some(h) = header {
                out.insert("rawSettings".into(), json!({ "header": h }));
            }
        }
        "xhttp" => {
            let mut x = Map::new();
            put(&mut x, "host", p.s("host"));
            x.insert("path".into(), json!(p.s("path").unwrap_or_else(|| "/".into())));
            x.insert("mode".into(), json!(p.s("mode").unwrap_or_else(|| "auto".into())));
            put(&mut x, "extra", parse_json_param(p, "extra"));
            out.insert("xhttpSettings".into(), obj(x));
        }
        "kcp" => {
            let mut k = Map::new();
            for key in ["mtu", "tti", "uplinkCapacity", "downlinkCapacity", "readBufferSize", "writeBufferSize"] {
                put(&mut k, key, p.n(key));
            }
            put(&mut k, "congestion", p.b("congestion"));
            put(&mut k, "header", header);
            put(&mut k, "seed", p.s("seed"));
            out.insert("kcpSettings".into(), obj(k));
        }
        "grpc" => {
            let mut g = Map::new();
            put(&mut g, "serviceName", p.s("servicename").or_else(|| p.s("serviceName")).or_else(|| p.s("path")));
            put(&mut g, "authority", p.s("authority"));
            g.insert("multiMode".into(), json!(p.get("mode") == Some("multi")));
            put(&mut g, "user_agent", p.s("user_agent"));
            put(&mut g, "idle_timeout", p.n("idle_timeout"));
            put(&mut g, "health_check_timeout", p.n("health_check_timeout"));
            put(&mut g, "permit_without_stream", p.b("permit_without_stream"));
            put(&mut g, "initial_windows_size", p.n("initial_windows_size"));
            out.insert("grpcSettings".into(), obj(g));
        }
        "ws" => {
            let mut w = Map::new();
            w.insert("path".into(), json!(p.s("path").unwrap_or_else(|| "/".into())));
            put(&mut w, "host", p.s("host"));
            put(&mut w, "heartbeatPeriod", p.n("heartbeatPeriod"));
            out.insert("wsSettings".into(), obj(w));
        }
        "httpupgrade" => {
            let mut h = Map::new();
            h.insert("path".into(), json!(p.s("path").unwrap_or_else(|| "/".into())));
            put(&mut h, "host", p.s("host"));
            out.insert("httpupgradeSettings".into(), obj(h));
        }
        _ => {}
    }
    out
}

struct UrlParts {
    host: String,
    port: u16,
    user: String,
    pass: Option<String>,
    tag: String,
    params: Params,
}

fn split_url(uri: &str) -> Result<UrlParts, String> {
    let url = Url::parse(uri.trim()).map_err(|e| format!("некорректная ссылка: {e}"))?;
    let host = url
        .host_str()
        .ok_or("в ссылке нет адреса")?
        .trim_matches(['[', ']'])
        .to_string();
    let mut map = HashMap::new();
    for (k, v) in url.query_pairs() {
        map.insert(k.to_ascii_lowercase(), v.into_owned());
    }
    Ok(UrlParts {
        host,
        port: url.port().unwrap_or(443),
        user: url.username().to_string(),
        pass: url.password().map(str::to_string),
        tag: url.fragment().map(pct_decode).unwrap_or_default(),
        params: Params(map),
    })
}

fn parse_vless(uri: &str) -> Result<Value, String> {
    let u = split_url(uri)?;
    let mut settings = Map::new();
    settings.insert("address".into(), json!(u.host));
    settings.insert("port".into(), json!(u.port));
    settings.insert("id".into(), json!(pct_decode(&u.user)));
    settings.insert("encryption".into(), json!(u.params.s("encryption").unwrap_or_else(|| "none".into())));
    put(&mut settings, "flow", u.params.s("flow"));
    let network = u.params.s("type").unwrap_or_else(|| "tcp".into());
    Ok(json!({
        "tag": u.tag,
        "protocol": "vless",
        "settings": settings,
        "streamSettings": stream_settings(&network, &u.params),
    }))
}

fn parse_trojan(uri: &str) -> Result<Value, String> {
    let u = split_url(uri)?;
    let network = u.params.s("type").unwrap_or_else(|| "tcp".into());
    Ok(json!({
        "tag": u.tag,
        "protocol": "trojan",
        "settings": { "address": u.host, "port": u.port, "password": pct_decode(&u.user) },
        "streamSettings": stream_settings(&network, &u.params),
    }))
}

/// `parseHysteria2Xray`: Xray-ядро, протокол `hysteria` (v2) с транспортом `hysteria`.
fn parse_hysteria2(uri: &str) -> Result<Value, String> {
    let uri = uri.trim();
    let uri = uri.strip_prefix("hy2://").map(|r| format!("hysteria2://{r}")).unwrap_or_else(|| uri.to_string());
    let mut u = split_url(&uri)?;
    let auth = pct_decode(&match &u.pass {
        Some(p) => format!("{}:{}", u.user, p),
        None => u.user.clone(),
    });
    if u.params.s("security").is_none() {
        u.params.0.insert("security".into(), "tls".into());
    }
    let mut ss = stream_settings("hysteria", &u.params);
    ss.insert("hysteriaSettings".into(), json!({ "auth": auth, "version": 2 }));
    if let Some(Value::Object(tls)) = ss.get_mut("tlsSettings") {
        tls.entry("alpn").or_insert_with(|| json!(["h3"]));
    }
    let mut fm = match ss.remove("finalmask") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    let mut quic = json!({ "congestion": "bbr", "bbrProfile": "standard" });
    if let Some(Value::Object(user)) = fm.get("quicParams") {
        for (k, v) in user {
            quic[k] = v.clone();
        }
    }
    fm.insert("quicParams".into(), quic);
    ss.insert("finalmask".into(), Value::Object(fm));
    Ok(json!({
        "tag": u.tag,
        "protocol": "hysteria",
        "settings": { "address": u.host, "port": u.port, "version": 2 },
        "streamSettings": ss,
    }))
}

fn parse_ss(uri: &str) -> Result<Value, String> {
    let rest = uri.trim().strip_prefix("ss://").ok_or("не ss-ссылка")?;
    let (head, tag) = match rest.split_once('#') {
        Some((h, t)) => (h, pct_decode(t)),
        None => (rest, String::new()),
    };
    let head = head.split('?').next().unwrap_or("").trim_end_matches('/');
    let (method, password, address, port);
    if let Some((userinfo, server)) = head.rsplit_once('@') {
        // SIP002: userinfo — base64(method:password) или (для 2022-шифров) percent-encoded plain.
        let decoded = safe_base64(userinfo)
            .filter(|d| d.contains(':'))
            .unwrap_or_else(|| pct_decode(userinfo));
        let (m, p) = decoded.split_once(':').ok_or("ошибка парсинга ss: нет метода")?;
        method = m.to_string();
        password = p.to_string();
        let (a, pt) = split_host_port(server)?;
        address = a;
        port = pt;
    } else {
        let decoded = safe_base64(head).ok_or("ошибка парсинга ss: не base64")?;
        let (cred, server) = decoded.rsplit_once('@').ok_or("ошибка парсинга ss")?;
        let (m, p) = cred.split_once(':').ok_or("ошибка парсинга ss")?;
        method = m.to_string();
        password = p.to_string();
        let (a, pt) = split_host_port(server)?;
        address = a;
        port = pt;
    }
    Ok(json!({
        "tag": tag,
        "protocol": "shadowsocks",
        "settings": { "address": address, "port": port, "method": method, "password": password },
    }))
}

fn split_host_port(server: &str) -> Result<(String, u16), String> {
    let (host, port) = server.rsplit_once(':').ok_or("нет порта")?;
    let port = port.trim().parse::<u16>().map_err(|_| "некорректный порт".to_string())?;
    Ok((host.trim_matches(['[', ']']).to_string(), port))
}

fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn parse_vmess(uri: &str) -> Result<Value, String> {
    let body = uri.trim().strip_prefix("vmess://").ok_or("не vmess-ссылка")?;
    let text = safe_base64(body).ok_or("vmess: не base64")?;
    let data: Map<String, Value> = serde_json::from_str(&text).map_err(|_| "vmess: некорректный JSON".to_string())?;
    let mut map: HashMap<String, String> = data
        .iter()
        .filter_map(|(k, v)| value_to_string(v).map(|s| (k.clone(), s)))
        .collect();
    if map.get("tls").map(String::as_str) == Some("tls") {
        map.insert("security".into(), "tls".into());
        let sni = map.get("sni").filter(|s| !s.is_empty()).or(map.get("host")).cloned().unwrap_or_default();
        map.insert("sni".into(), sni);
    }
    let p = Params(map);
    let port = p.get("port").and_then(|v| v.trim().parse::<u16>().ok()).ok_or("vmess: некорректный порт")?;
    let aid = p.get("aid").and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(0);
    let network = p.s("net").unwrap_or_else(|| "tcp".into());
    Ok(json!({
        "tag": p.s("ps").unwrap_or_default(),
        "protocol": "vmess",
        "settings": {
            "address": p.s("add").unwrap_or_default(),
            "port": port,
            "id": p.s("id").unwrap_or_default(),
            "alterId": aid,
            "security": p.s("scy").unwrap_or_else(|| "auto".into()),
        },
        "streamSettings": stream_settings(&network, &p),
    }))
}

/// Разбор одной ссылки в outbound Xray. Тег — имя из `#fragment` (может быть пустым).
pub fn parse_link(uri: &str) -> Result<Value, String> {
    let uri = uri.trim();
    let scheme = uri.split("://").next().unwrap_or("").to_ascii_lowercase();
    match scheme.as_str() {
        "vless" => parse_vless(uri),
        "trojan" => parse_trojan(uri),
        "ss" => parse_ss(uri),
        "vmess" => parse_vmess(uri),
        "hysteria2" | "hy2" => parse_hysteria2(uri),
        _ => Err("неизвестная ссылка".into()),
    }
}

/// Тело ответа подписки → список ссылок (plain или base64).
pub fn extract_links(body: &str) -> Vec<String> {
    let body = body.trim_start_matches('\u{feff}').trim();
    let text = if body.contains("://") {
        body.to_string()
    } else {
        safe_base64(body).unwrap_or_default()
    };
    text.lines()
        .map(str::trim)
        .filter(|l| {
            let lower = l.to_ascii_lowercase();
            ["vless://", "vmess://", "trojan://", "ss://", "hysteria2://", "hy2://"]
                .iter()
                .any(|p| lower.starts_with(p))
        })
        .map(str::to_string)
        .collect()
}

/// Санитайз имени для тега: печатные символы без кавычек/управляющих, пробелы → `_`, ≤ 48 символов.
pub fn sanitize_tag(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '"' | '\\' | '\u{200d}' | '\u{fe0f}'))
        .map(|c| if c.is_whitespace() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    trimmed.chars().take(48).collect()
}

/// Строит outbounds подписки: теги `<name>-<имя из ссылки>` или `<name>-<n>`, уникальные.
pub fn build_outbounds(name: &str, links: &[String]) -> (Vec<Value>, usize) {
    let prefix = sanitize_name(name);
    let mut used = HashSet::new();
    let mut out = Vec::new();
    let mut skipped = 0;
    for link in links {
        let Ok(mut ob) = parse_link(link) else {
            skipped += 1;
            continue;
        };
        let raw = ob.get("tag").and_then(|t| t.as_str()).map(sanitize_tag).unwrap_or_default();
        let base = if raw.is_empty() {
            format!("{prefix}-{}", out.len() + 1)
        } else {
            format!("{prefix}-{raw}")
        };
        let mut tag = base.clone();
        let mut i = 2;
        while !used.insert(tag.clone()) {
            tag = format!("{base}-{i}");
            i += 1;
        }
        ob["tag"] = json!(tag);
        out.push(ob);
    }
    (out, skipped)
}

pub fn render_file(outbounds: Vec<Value>) -> String {
    let doc = json!({ "outbounds": outbounds });
    let mut s = serde_json::to_string_pretty(&doc).unwrap_or_default();
    s.push('\n');
    s
}

// ─── Обновление ────────────────────────────────────────────────────────────────────────────

async fn fetch(state: &AppState, sub: &Subscription) -> Result<String, String> {
    let ua = if sub.user_agent.trim().is_empty() { DEFAULT_USER_AGENT } else { sub.user_agent.trim() };
    let res = state
        .http_client
        .get(sub.url.trim())
        .header("User-Agent", ua)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Не удалось загрузить подписку: {}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(format!("Сервер подписки вернул {}", res.status()));
    }
    if res.content_length().is_some_and(|l| l as usize > MAX_BODY) {
        return Err("Слишком большой ответ подписки".into());
    }
    let bytes = res.bytes().await.map_err(|e| format!("Ошибка чтения подписки: {}", e.without_url()))?;
    if bytes.len() > MAX_BODY {
        return Err("Слишком большой ответ подписки".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Обновить одну подписку. `Ok(true)` — файл изменён.
async fn update_one(state: &AppState, sub: &Subscription) -> Result<(bool, usize, usize), String> {
    if sanitize_name(&sub.name).is_empty() {
        return Err("Пустое имя подписки".into());
    }
    let body = fetch(state, sub).await?;
    let links = extract_links(&body);
    if links.is_empty() {
        return Err("В ответе нет поддерживаемых ссылок".into());
    }
    let (outbounds, skipped) = build_outbounds(&sub.name, &links);
    if outbounds.is_empty() {
        return Err(format!("Не удалось разобрать ни одной ссылки (пропущено {skipped})"));
    }
    let count = outbounds.len();
    let content = render_file(outbounds);
    let path = sub_file(&sub.name);
    if tokio::fs::read_to_string(&path).await.ok().as_deref() == Some(content.as_str()) {
        return Ok((false, count, skipped));
    }
    crate::configs::validate_xray_with(&path, Some(&content))
        .await
        .map_err(|e| format!("Проверка конфига не пройдена: {}", e.lines().last().unwrap_or("").chars().take(300).collect::<String>()))?;
    let tmp = format!("{path}.tmp");
    tokio::fs::write(&tmp, &content).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, &path).await.map_err(|e| e.to_string())?;
    Ok((true, count, skipped))
}

/// Обновляет подписки (все включённые или одну по имени); перезапускает Xray один раз, если
/// что-то изменилось и ядро запущено.
async fn update_many(state: &AppState, only: Option<&str>) -> Vec<(String, Result<(bool, usize, usize), String>)> {
    let _guard = UPDATE_LOCK.lock().await;
    let items = state.settings.read().unwrap().automation.subscriptions.items.clone();
    let mut results = Vec::new();
    let mut changed = false;
    for sub in items.iter().filter(|s| match only {
        Some(n) => s.name == n,
        None => s.enabled,
    }) {
        let res = update_one(state, sub).await;
        let now = now_secs();
        with_state(|m| {
            let st = m.entry(sub.name.clone()).or_default();
            st.last_update = Some(now);
            match &res {
                Ok((_, count, skipped)) => {
                    st.last_success = Some(now);
                    st.last_error = None;
                    st.count = *count;
                    st.skipped = *skipped;
                }
                Err(e) => st.last_error = Some(e.clone()),
            }
        });
        match &res {
            Ok((c, count, skipped)) => {
                changed |= *c;
                log(
                    "INFO",
                    format!(
                        "Подписка «{}»: {} серверов{}{}",
                        sub.name,
                        count,
                        if *skipped > 0 { format!(", пропущено {skipped}") } else { String::new() },
                        if *c { ", файл обновлён" } else { ", без изменений" }
                    ),
                );
            }
            Err(e) => {
                log("WARN", format!("Подписка «{}»: {}", sub.name, e));
                crate::notify::notify_event(state, &format!("sub:{}", sub.name), &format!("❗ Подписка «{}»: {}", sub.name, e)).await;
            }
        }
        results.push((sub.name.clone(), res));
    }
    if !results.is_empty() {
        save_state();
    }
    if changed {
        apply(state).await;
    }
    results
}

async fn apply(state: &AppState) {
    let core = state.core.read().unwrap().name.clone();
    let running = tokio::task::spawn_blocking(|| !crate::controller::get_pid("xray").is_empty())
        .await
        .unwrap_or(false);
    if core != "xray" || !running {
        return;
    }
    crate::notify::suppress_service_alerts(60);
    if let Err(e) = crate::controller::soft_restart("xray").await {
        log("ERROR", format!("Не удалось перезапустить Xray после обновления подписок: {e}"));
    }
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        // Первый прогон — через 2 минуты после старта (не мешаем загрузке роутера).
        tokio::time::sleep(Duration::from_secs(120)).await;
        let mut tick = tokio::time::interval(Duration::from_secs(600));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let (items, core) = {
                let s = state.settings.read().unwrap();
                (s.automation.subscriptions.items.clone(), state.core.read().unwrap().name.clone())
            };
            if core != "xray" || items.iter().all(|s| !s.enabled) {
                continue;
            }
            let now = now_secs();
            let due: Vec<String> = items
                .iter()
                .filter(|s| s.enabled)
                .filter(|s| {
                    let every = u64::from(s.interval_hours.max(1)) * 3600;
                    with_state(|m| m.get(&s.name).and_then(|st| st.last_update)).is_none_or(|t| now.saturating_sub(t) >= every)
                })
                .map(|s| s.name.clone())
                .collect();
            for name in due {
                update_many(&state, Some(&name)).await;
            }
        }
    });
}

// ─── API ───────────────────────────────────────────────────────────────────────────────────

pub async fn get_subscriptions(State(state): State<AppState>) -> impl IntoResponse {
    let items = state.settings.read().unwrap().automation.subscriptions.items.clone();
    let statuses = with_state(|m| m.clone());
    let list: Vec<Value> = items
        .iter()
        .map(|s| {
            let st = statuses.get(&s.name).cloned().unwrap_or_default();
            json!({
                "name": s.name,
                "url": s.url,
                "enabled": s.enabled,
                "interval_hours": s.interval_hours,
                "user_agent": s.user_agent,
                "file": sub_file(&s.name),
                "last_update": st.last_update,
                "last_success": st.last_success,
                "last_error": st.last_error,
                "count": st.count,
                "skipped": st.skipped,
            })
        })
        .collect();
    Json(json!({ "success": true, "items": list, "default_user_agent": DEFAULT_USER_AGENT }))
}

#[derive(Deserialize)]
pub struct UpdateReq {
    #[serde(default)]
    name: Option<String>,
}

pub async fn post_subscriptions_update(State(state): State<AppState>, Json(req): Json<UpdateReq>) -> impl IntoResponse {
    if state.core.read().unwrap().name != "xray" {
        return Json(json!({ "success": false, "error": "Подписки доступны только для ядра Xray" }));
    }
    let results = update_many(&state, req.name.as_deref()).await;
    if results.is_empty() {
        return Json(json!({ "success": false, "error": "Нет подписок для обновления" }));
    }
    let errors: Vec<String> = results
        .iter()
        .filter_map(|(n, r)| r.as_ref().err().map(|e| format!("{n}: {e}")))
        .collect();
    Json(json!({
        "success": errors.is_empty(),
        "error": (!errors.is_empty()).then(|| errors.join("; ")),
        "updated": results.iter().filter(|(_, r)| matches!(r, Ok((true, _, _)))).count(),
    }))
}

#[derive(Deserialize)]
pub struct DeleteReq {
    name: String,
}

/// Удаляет файл подписки (сама запись удаляется фронтом через PATCH /api/settings).
/// Если без файла набор конфигов невалиден (теги используются в routing) — отказ.
pub async fn delete_subscription_file(State(state): State<AppState>, Json(req): Json<DeleteReq>) -> impl IntoResponse {
    let path = sub_file(&req.name);
    if sanitize_name(&req.name).is_empty() {
        return Json(json!({ "success": false, "error": "Пустое имя подписки" }));
    }
    if tokio::fs::metadata(&path).await.is_ok() {
        if let Err(e) = crate::configs::validate_xray_with(&path, None).await {
            return Json(json!({
                "success": false,
                "error": format!(
                    "Без серверов подписки конфиг не проходит проверку (теги используются в правилах?): {}",
                    e.lines().last().unwrap_or("").chars().take(200).collect::<String>()
                ),
            }));
        }
        if let Err(e) = tokio::fs::remove_file(&path).await {
            return Json(json!({ "success": false, "error": e.to_string() }));
        }
        apply(&state).await;
    }
    with_state(|m| m.remove(&req.name));
    save_state();
    Json(json!({ "success": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vless_reality_tcp() {
        let ob = parse_link(
            "vless://b831381d-6324-4d53-ad4f-8cda48b30811@1.2.3.4:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sid=6ba85179e30d4fc2&type=tcp&headerType=none#%D0%9D%D0%B8%D0%B4%D0%B5%D1%80%D0%BB%D0%B0%D0%BD%D0%B4%D1%8B%20%F0%9F%87%B3%F0%9F%87%B1",
        )
        .unwrap();
        assert_eq!(ob["protocol"], "vless");
        assert_eq!(ob["tag"], "Нидерланды 🇳🇱");
        assert_eq!(ob["settings"]["address"], "1.2.3.4");
        assert_eq!(ob["settings"]["port"], 443);
        assert_eq!(ob["settings"]["id"], "b831381d-6324-4d53-ad4f-8cda48b30811");
        assert_eq!(ob["settings"]["flow"], "xtls-rprx-vision");
        assert_eq!(ob["settings"]["encryption"], "none");
        let ss = &ob["streamSettings"];
        assert_eq!(ss["network"], "tcp");
        assert_eq!(ss["security"], "reality");
        assert_eq!(ss["realitySettings"]["publicKey"], "SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc");
        assert_eq!(ss["realitySettings"]["shortId"], "6ba85179e30d4fc2");
        assert_eq!(ss["realitySettings"]["serverName"], "www.microsoft.com");
        assert_eq!(ss["realitySettings"]["fingerprint"], "chrome");
        assert_eq!(ss["tcpSettings"]["header"]["type"], "none");
        assert!(ss.get("tlsSettings").is_none());
    }

    #[test]
    fn vless_tls_ws_and_grpc_and_xhttp() {
        let ws = parse_link("vless://uuid@ex.com:8443?security=tls&type=ws&path=%2Fws%3Fed%3D2048&host=cdn.ex.com&sni=ex.com&alpn=h2,http/1.1&allowInsecure=1#WS").unwrap();
        let ss = &ws["streamSettings"];
        assert_eq!(ss["wsSettings"]["path"], "/ws?ed=2048");
        assert_eq!(ss["wsSettings"]["host"], "cdn.ex.com");
        assert_eq!(ss["tlsSettings"]["serverName"], "ex.com");
        assert_eq!(ss["tlsSettings"]["alpn"], json!(["h2", "http/1.1"]));
        assert_eq!(ss["tlsSettings"]["allowInsecure"], true);
        assert_eq!(ws["settings"]["port"], 8443);

        let grpc = parse_link("vless://uuid@ex.com:443?security=tls&type=grpc&serviceName=gun&mode=multi#G").unwrap();
        assert_eq!(grpc["streamSettings"]["grpcSettings"]["serviceName"], "gun");
        assert_eq!(grpc["streamSettings"]["grpcSettings"]["multiMode"], true);

        let xh = parse_link("vless://uuid@ex.com?security=reality&type=xhttp&path=%2Fx&mode=packet-up&pbk=k#X").unwrap();
        assert_eq!(xh["settings"]["port"], 443);
        assert_eq!(xh["streamSettings"]["xhttpSettings"]["path"], "/x");
        assert_eq!(xh["streamSettings"]["xhttpSettings"]["mode"], "packet-up");
        let xh2 = parse_link("vless://uuid@ex.com:443?type=xhttp#Y").unwrap();
        assert_eq!(xh2["streamSettings"]["xhttpSettings"]["path"], "/");
        assert_eq!(xh2["streamSettings"]["xhttpSettings"]["mode"], "auto");
        assert!(xh2["streamSettings"].get("security").is_none());
    }

    #[test]
    fn trojan_link() {
        let ob = parse_link("trojan://p%40ss@t.example.com:443?security=tls&sni=t.example.com&type=tcp#Trojan%201").unwrap();
        assert_eq!(ob["protocol"], "trojan");
        assert_eq!(ob["settings"]["password"], "p@ss");
        assert_eq!(ob["tag"], "Trojan 1");
        assert_eq!(ob["streamSettings"]["tlsSettings"]["serverName"], "t.example.com");
    }

    #[test]
    fn shadowsocks_sip002_legacy_and_plain() {
        // base64("aes-256-gcm:pass")
        let ob = parse_link("ss://YWVzLTI1Ni1nY206cGFzcw@1.1.1.1:8388#SS").unwrap();
        assert_eq!(ob["protocol"], "shadowsocks");
        assert_eq!(ob["settings"]["method"], "aes-256-gcm");
        assert_eq!(ob["settings"]["password"], "pass");
        assert_eq!(ob["settings"]["port"], 8388);
        assert!(ob.get("streamSettings").is_none());

        let legacy = parse_link("ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwdzp4QDUuNi43Ljg6NDQz#Old").unwrap();
        assert_eq!(legacy["settings"]["method"], "chacha20-ietf-poly1305");
        assert_eq!(legacy["settings"]["password"], "pw:x");
        assert_eq!(legacy["settings"]["address"], "5.6.7.8");
        assert_eq!(legacy["settings"]["port"], 443);

        let plain = parse_link("ss://2022-blake3-aes-128-gcm:a2V5%3D@[2001:db8::1]:443/?plugin=x#P").unwrap();
        assert_eq!(plain["settings"]["method"], "2022-blake3-aes-128-gcm");
        assert_eq!(plain["settings"]["password"], "a2V5=");
        assert_eq!(plain["settings"]["address"], "2001:db8::1");
    }

    #[test]
    fn vmess_ws_tls() {
        let ob = parse_link("vmess://eyJ2IjoiMiIsInBzIjoi0KLQtdGB0YIgVk0iLCJhZGQiOiJ2LmV4YW1wbGUuY29tIiwicG9ydCI6IjQ0MyIsImlkIjoiYjgzMTM4MWQtNjMyNC00ZDUzLWFkNGYtOGNkYTQ4YjMwODExIiwiYWlkIjoiMCIsInNjeSI6ImF1dG8iLCJuZXQiOiJ3cyIsInR5cGUiOiJub25lIiwiaG9zdCI6InYuZXhhbXBsZS5jb20iLCJwYXRoIjoiL3ZtIiwidGxzIjoidGxzIiwic25pIjoiIn0=").unwrap();
        assert_eq!(ob["protocol"], "vmess");
        assert_eq!(ob["tag"], "Тест VM");
        assert_eq!(ob["settings"]["address"], "v.example.com");
        assert_eq!(ob["settings"]["port"], 443);
        assert_eq!(ob["settings"]["alterId"], 0);
        assert_eq!(ob["settings"]["security"], "auto");
        let ss = &ob["streamSettings"];
        assert_eq!(ss["network"], "ws");
        assert_eq!(ss["security"], "tls");
        assert_eq!(ss["tlsSettings"]["serverName"], "v.example.com");
        assert_eq!(ss["wsSettings"]["path"], "/vm");
    }

    #[test]
    fn hysteria2_link() {
        let ob = parse_link("hy2://secret@h.example.com:8443?sni=h.example.com&insecure=1#HY").unwrap();
        assert_eq!(ob["protocol"], "hysteria");
        assert_eq!(ob["settings"]["version"], 2);
        assert_eq!(ob["settings"]["port"], 8443);
        let ss = &ob["streamSettings"];
        assert_eq!(ss["network"], "hysteria");
        assert_eq!(ss["security"], "tls");
        assert_eq!(ss["hysteriaSettings"]["auth"], "secret");
        assert_eq!(ss["tlsSettings"]["alpn"], json!(["h3"]));
        assert_eq!(ss["tlsSettings"]["allowInsecure"], true);
        assert_eq!(ss["finalmask"]["quicParams"]["congestion"], "bbr");
    }

    #[test]
    fn unknown_link_rejected() {
        assert!(parse_link("http://example.com").is_err());
        assert!(parse_link("vless://").is_err());
    }

    #[test]
    fn extracts_links_from_base64_and_plain() {
        let b64 = "dmxlc3M6Ly9iODMxMzgxZC02MzI0LTRkNTMtYWQ0Zi04Y2RhNDhiMzA4MTFAYS5leGFtcGxlLmNvbTo0NDM/c2VjdXJpdHk9dGxzJnNuaT1hLmV4YW1wbGUuY29tJnR5cGU9dGNwI0EKdHJvamFuOi8vc2VjcmV0QGIuZXhhbXBsZS5jb206NDQzP3NlY3VyaXR5PXRscyNCCgpodHRwOi8vbm90LWEtcHJveHk=";
        let links = extract_links(b64);
        assert_eq!(links.len(), 2);
        assert!(links[0].starts_with("vless://"));
        assert!(links[1].starts_with("trojan://"));
        let plain = extract_links("\u{feff}ss://YWVzLTI1Ni1nY206cGFzcw@1.1.1.1:8388#A\r\n# comment\r\nvmess://xyz\n");
        assert_eq!(plain.len(), 2);
    }

    #[test]
    fn builds_unique_prefixed_tags() {
        let links = vec![
            "trojan://a@x.com:443#Same Name".to_string(),
            "trojan://b@y.com:443#Same Name".to_string(),
            "trojan://c@z.com:443".to_string(),
            "garbage://x".to_string(),
        ];
        let (obs, skipped) = build_outbounds("My Sub", &links);
        assert_eq!(skipped, 1);
        let tags: Vec<_> = obs.iter().map(|o| o["tag"].as_str().unwrap().to_string()).collect();
        assert_eq!(tags.len(), 3);
        assert_eq!(tags[0], "my_sub-Same_Name");
        assert_eq!(tags[1], "my_sub-Same_Name-2");
        assert_eq!(tags[2], "my_sub-3");
    }

    #[test]
    fn file_name_is_tail_and_sanitized() {
        assert_eq!(sanitize_name(" My Sub!/.. "), "my_sub");
        assert_eq!(sub_file("My Sub"), "/opt/etc/xray/configs/04_outbounds_sub_my_sub_tail.json");
    }

    #[test]
    fn rendered_file_is_valid_json_with_outbounds() {
        let (obs, _) = build_outbounds("s", &["trojan://a@x.com:443#A".to_string()]);
        let text = render_file(obs);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["outbounds"][0]["tag"], "s-A");
    }
}
