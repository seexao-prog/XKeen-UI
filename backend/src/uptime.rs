//! История доступности серверов (аптайм) за 24 часа.
//!
//! Мониторинг выключен по умолчанию: каждый прогон поднимает временный xray («тест всех» из
//! `healthchecker.rs`), на слабом роутере это ощутимая нагрузка. Интервал — не меньше 5 мин.
//!
//! История — кольцевой буфер в памяти на тег (≤ 288 точек = 24 ч при шаге 5 мин) и сброс в
//! `/opt/etc/xkeen/uptime.json` не чаще раза в 10 минут (бережём флеш).

use crate::logger::log;
use crate::types::{AppState, XKEEN_CONF_DIR, XRAY_CONF_DIR};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MIN_INTERVAL_MIN: u32 = 5;
const WINDOW_SECS: u64 = 24 * 3600;
const CAPACITY: usize = (WINDOW_SECS / (MIN_INTERVAL_MIN as u64 * 60)) as usize; // 288
const FLUSH_EVERY: Duration = Duration::from_secs(600);

fn uptime_file() -> String {
    format!("{XKEEN_CONF_DIR}/uptime.json")
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UptimeSettings {
    pub enabled: bool,
    pub interval_minutes: u32,
}

impl Default for UptimeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_minutes: 10,
        }
    }
}

/// Точка: unix-время (с) и задержка в мс (0 — сервер недоступен).
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Sample(pub u64, pub u32);

/// Кольцевой буфер фиксированной ёмкости: при переполнении вытесняется самая старая точка.
#[derive(Clone, Serialize, Deserialize, Default, Debug)]
#[serde(transparent)]
pub struct Ring {
    items: VecDeque<Sample>,
}

impl Ring {
    pub fn push(&mut self, sample: Sample, capacity: usize) {
        while self.items.len() >= capacity.max(1) {
            self.items.pop_front();
        }
        self.items.push_back(sample);
    }

    /// Удаляет точки старше `min_ts`.
    pub fn prune(&mut self, min_ts: u64) {
        while self.items.front().is_some_and(|s| s.0 < min_ts) {
            self.items.pop_front();
        }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn last(&self) -> Option<Sample> {
        self.items.back().copied()
    }

    /// Две последние точки — неуспешные (защита от единичных сбоев при уведомлениях).
    pub fn is_down(&self) -> bool {
        self.items.len() >= 2 && self.items.iter().rev().take(2).all(|s| s.1 == 0)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Sample> {
        self.items.iter()
    }
}

#[derive(Default)]
struct Store {
    rings: BTreeMap<String, Ring>,
    dirty: bool,
    last_flush: Option<Instant>,
    loaded: bool,
    /// Последнее известное «упал/работает» по тегу и изменения для уведомлений.
    down: HashMap<String, bool>,
    pending: BTreeMap<String, bool>,
    last_run: Option<u64>,
    last_error: Option<String>,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn load_once(store: &mut Store) {
    if store.loaded {
        return;
    }
    store.loaded = true;
    if let Ok(text) = std::fs::read_to_string(uptime_file())
        && let Ok(rings) = serde_json::from_str::<BTreeMap<String, Ring>>(&text)
    {
        let min_ts = now_secs().saturating_sub(WINDOW_SECS);
        store.rings = rings
            .into_iter()
            .map(|(k, mut r)| {
                r.prune(min_ts);
                (k, r)
            })
            .filter(|(_, r)| r.len() > 0)
            .collect();
    }
}

fn record(results: &[(String, Result<u64, String>)], ts: u64) {
    let mut store = STORE.lock().unwrap();
    load_once(&mut store);
    let min_ts = ts.saturating_sub(WINDOW_SECS);
    for (tag, result) in results {
        let delay = match result {
            Ok(ms) => (*ms).clamp(1, u32::MAX as u64) as u32,
            Err(_) => 0,
        };
        let ring = store.rings.entry(tag.clone()).or_default();
        ring.prune(min_ts);
        ring.push(Sample(ts, delay), CAPACITY);
        let down = ring.is_down();
        let up = ring.last().is_some_and(|s| s.1 > 0);
        let prev = store.down.get(tag).copied().unwrap_or(false);
        if down && !prev {
            store.down.insert(tag.clone(), true);
            store.pending.insert(tag.clone(), true);
        } else if prev && up {
            store.down.insert(tag.clone(), false);
            store.pending.insert(tag.clone(), false);
        }
    }
    // Теги, которых больше нет в конфиге и нет свежих точек, — выкидываем.
    store.rings.retain(|_, r| {
        r.prune(min_ts);
        r.len() > 0
    });
    store.dirty = true;
    store.last_run = Some(ts);
}

/// Изменения «упал/поднялся» с прошлого вызова — для notify.rs.
pub fn transitions_since_last_notify() -> Vec<(String, bool)> {
    std::mem::take(&mut STORE.lock().unwrap().pending).into_iter().collect()
}

fn flush(force: bool) {
    let (json, path) = {
        let mut store = STORE.lock().unwrap();
        if !store.dirty || (!force && store.last_flush.is_some_and(|t| t.elapsed() < FLUSH_EVERY)) {
            return;
        }
        store.dirty = false;
        store.last_flush = Some(Instant::now());
        (serde_json::to_string(&store.rings).unwrap_or_else(|_| "{}".into()), uptime_file())
    };
    let tmp = format!("{path}.tmp");
    if let Err(e) = std::fs::create_dir_all(XKEEN_CONF_DIR)
        .and_then(|_| std::fs::write(&tmp, json))
        .and_then(|_| std::fs::rename(&tmp, &path))
    {
        log("WARN", format!("Не удалось сохранить {path}: {e}"));
    }
}

/// Убирает `//` и `/* */` комментарии вне строк (конфиги Xray бывают JSONC).
pub fn strip_json_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_str = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

const SKIP_PROTOCOLS: [&str; 5] = ["freedom", "blackhole", "dns", "loopback", "direct"];

/// Прокси-аутбаунды активных конфигов Xray (по тегу, без служебных протоколов).
fn collect_outbounds() -> Vec<serde_json::Value> {
    let Ok(dir) = std::fs::read_dir(XRAY_CONF_DIR) else {
        return Vec::new();
    };
    let mut files: Vec<_> = dir
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json" || e == "jsonc"))
        .collect();
    files.sort();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for path in files {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&strip_json_comments(&text)) else {
            continue;
        };
        for ob in json.get("outbounds").and_then(|o| o.as_array()).into_iter().flatten() {
            let tag = ob.get("tag").and_then(|t| t.as_str()).unwrap_or("").trim();
            let proto = ob.get("protocol").and_then(|p| p.as_str()).unwrap_or("");
            if tag.is_empty() || SKIP_PROTOCOLS.contains(&proto) || !seen.insert(tag.to_string()) {
                continue;
            }
            out.push(ob.clone());
        }
    }
    out
}

async fn run_once(state: &AppState) -> Result<usize, String> {
    let outbounds = tokio::task::spawn_blocking(collect_outbounds).await.map_err(|e| e.to_string())?;
    if outbounds.is_empty() {
        return Ok(0);
    }
    let results = crate::healthchecker::ping_all_background(state, &outbounds).await?;
    let n = results.len();
    record(&results, now_secs());
    Ok(n)
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        let mut last_run: Option<Instant> = None;
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let (cfg, core) = {
                let s = state.settings.read().unwrap();
                (s.automation.uptime.clone(), state.core.read().unwrap().name.clone())
            };
            flush(!cfg.enabled);
            if !cfg.enabled || core != "xray" {
                continue;
            }
            let every = Duration::from_secs(u64::from(cfg.interval_minutes.max(MIN_INTERVAL_MIN)) * 60);
            if last_run.is_some_and(|t| t.elapsed() < every) {
                continue;
            }
            // Ядро не запущено — пинговать бессмысленно (и xray-бинарь может отсутствовать).
            if tokio::task::spawn_blocking(|| crate::controller::get_pid("xray").is_empty())
                .await
                .unwrap_or(true)
            {
                continue;
            }
            last_run = Some(Instant::now());
            match run_once(&state).await {
                Ok(_) => STORE.lock().unwrap().last_error = None,
                Err(e) => {
                    log("WARN", format!("Мониторинг аптайма: {e}"));
                    STORE.lock().unwrap().last_error = Some(e);
                }
            }
            flush(false);
        }
    });
}

pub async fn get_uptime(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = state.settings.read().unwrap().automation.uptime.clone();
    let mut store = STORE.lock().unwrap();
    load_once(&mut store);
    let now = now_secs();
    let history: BTreeMap<&String, Vec<[u64; 2]>> = store
        .rings
        .iter()
        .map(|(k, r)| (k, r.iter().map(|s| [s.0, u64::from(s.1)]).collect()))
        .collect();
    Json(serde_json::json!({
        "success": true,
        "enabled": cfg.enabled,
        "interval_minutes": cfg.interval_minutes.max(MIN_INTERVAL_MIN),
        "now": now,
        "window_secs": WINDOW_SECS,
        "last_run": store.last_run,
        "last_error": store.last_error,
        "history": history,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_evicts_oldest_on_overflow() {
        let mut ring = Ring::default();
        for i in 0..5 {
            ring.push(Sample(i, 10), 3);
        }
        assert_eq!(ring.len(), 3);
        assert_eq!(ring.iter().map(|s| s.0).collect::<Vec<_>>(), vec![2, 3, 4]);
        assert_eq!(ring.last(), Some(Sample(4, 10)));
    }

    #[test]
    fn ring_prunes_old_points() {
        let mut ring = Ring::default();
        for ts in [100, 200, 300] {
            ring.push(Sample(ts, 1), 10);
        }
        ring.prune(200);
        assert_eq!(ring.iter().map(|s| s.0).collect::<Vec<_>>(), vec![200, 300]);
    }

    #[test]
    fn down_needs_two_failures() {
        let mut ring = Ring::default();
        ring.push(Sample(1, 50), 10);
        ring.push(Sample(2, 0), 10);
        assert!(!ring.is_down());
        ring.push(Sample(3, 0), 10);
        assert!(ring.is_down());
        ring.push(Sample(4, 40), 10);
        assert!(!ring.is_down());
    }

    #[test]
    fn ring_serializes_compactly() {
        let mut ring = Ring::default();
        ring.push(Sample(10, 0), 10);
        ring.push(Sample(20, 35), 10);
        assert_eq!(serde_json::to_string(&ring).unwrap(), "[[10,0],[20,35]]");
        let back: Ring = serde_json::from_str("[[10,0],[20,35]]").unwrap();
        assert_eq!(back.len(), 2);
    }

    #[test]
    fn capacity_covers_24h_at_min_interval() {
        assert_eq!(CAPACITY, 288);
    }

    #[test]
    fn strips_comments_outside_strings() {
        let src = "{\n // c\n \"a\": \"http://x/*y*/\", /* b */ \"b\": 1 }";
        let v: serde_json::Value = serde_json::from_str(&strip_json_comments(src)).unwrap();
        assert_eq!(v["a"], "http://x/*y*/");
        assert_eq!(v["b"], 1);
    }
}
