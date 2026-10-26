//! Уведомления в Telegram.
//!
//! Фоновая задача (`start`) просыпается раз в минуту и ничего не делает, пока уведомления
//! выключены. Следит за:
//! - статусом ядра: «упал» — процесс ядра пропал, хотя за последние 10 минут из панели не
//!   было остановки/перезапуска/смены ядра (`mark_manual_stop` вызывается в
//!   `controller::post_control`), а плановые операции не подавили алерт (`suppress_service_alerts`);
//! - доступностью серверов — только по данным мониторинга аптайма (`uptime.rs`), свои пинги
//!   не запускаем;
//! - флагами `update_checker` (один раз на тег).
//!
//! Анти-спам: одно и то же событие (ключ) — не чаще `cooldown_minutes`.

use crate::logger::log;
use crate::types::AppState;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const DEFAULT_API_BASE: &str = "https://api.telegram.org";

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct NotifyEvents {
    pub service_down: bool,
    pub service_up: bool,
    pub server_down: bool,
    pub update_available: bool,
}

impl Default for NotifyEvents {
    fn default() -> Self {
        Self {
            service_down: true,
            service_up: true,
            server_down: true,
            update_available: true,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TelegramSettings {
    pub enabled: bool,
    pub bot_token: String,
    pub chat_id: String,
    /// Базовый URL Bot API. В РФ api.telegram.org может быть недоступен — можно указать
    /// своё зеркало/реверс-прокси (`https://tg.example.com`), путь `/bot<token>/...` сохраняется.
    pub api_base: String,
    pub events: NotifyEvents,
    /// Минимальный интервал между повторами одного и того же события, мин.
    pub cooldown_minutes: u32,
}

impl Default for TelegramSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            bot_token: String::new(),
            chat_id: String::new(),
            api_base: DEFAULT_API_BASE.into(),
            events: NotifyEvents::default(),
            cooldown_minutes: 30,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct NotifySettings {
    pub telegram: TelegramSettings,
}

/// Последняя отправка по ключу события (анти-спам).
static LAST_SENT: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Проверяет и отмечает кулдаун. `true` — можно отправлять.
fn cooldown_allows(key: &str, cooldown: Duration) -> bool {
    let mut map = LAST_SENT.lock().unwrap();
    let now = Instant::now();
    match map.get(key) {
        Some(t) if now.duration_since(*t) < cooldown => false,
        _ => {
            map.insert(key.to_string(), now);
            true
        }
    }
}

fn api_url(base: &str, token: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let base = if base.is_empty() { DEFAULT_API_BASE } else { base };
    format!("{base}/bot{token}/sendMessage")
}

/// Отправка сообщения. Токен в лог не попадает.
pub async fn send_message(state: &AppState, tg: &TelegramSettings, text: &str) -> Result<(), String> {
    if tg.bot_token.trim().is_empty() || tg.chat_id.trim().is_empty() {
        return Err("Не указан токен бота или chat_id".into());
    }
    let res = state
        .http_client
        .post(api_url(&tg.api_base, tg.bot_token.trim()))
        .timeout(Duration::from_secs(15))
        .json(&serde_json::json!({
            "chat_id": tg.chat_id.trim(),
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": true,
        }))
        .send()
        .await
        .map_err(|e| format!("Telegram недоступен: {}", e.without_url()))?;
    if res.status().is_success() {
        return Ok(());
    }
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    let desc = body.get("description").and_then(|d| d.as_str()).unwrap_or("");
    Err(format!("Telegram вернул {status}: {desc}"))
}

fn host_label() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "router".into())
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Отправить уведомление о событии, если оно включено и не попадает в кулдаун.
/// Ошибки отправки — только WARN в журнал.
pub async fn notify_event(state: &AppState, key: &str, text: &str) {
    let tg = state.settings.read().unwrap().automation.notify.telegram.clone();
    if !tg.enabled {
        return;
    }
    let cooldown = Duration::from_secs(u64::from(tg.cooldown_minutes.max(1)) * 60);
    if !cooldown_allows(key, cooldown) {
        return;
    }
    let full = format!("<b>XKeen UI · {}</b>\n{}", escape_html(&host_label()), text);
    if let Err(e) = send_message(state, &tg, &full).await {
        log("WARN", format!("Уведомление не отправлено: {e}"));
    }
}

pub async fn post_notify_test(State(state): State<AppState>) -> impl IntoResponse {
    let tg = state.settings.read().unwrap().automation.notify.telegram.clone();
    let text = format!("<b>XKeen UI · {}</b>\nТестовое уведомление ✅", escape_html(&host_label()));
    match send_message(&state, &tg, &text).await {
        Ok(()) => Json(serde_json::json!({ "success": true })),
        Err(e) => {
            log("WARN", format!("Тестовое уведомление не отправлено: {e}"));
            Json(serde_json::json!({ "success": false, "error": e }))
        }
    }
}

/// Плановые операции (перезапуск ядра по расписанию) кратковременно гасят процесс —
/// на это время подавляем «сервис упал».
static SUPPRESS_UNTIL: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));

pub fn suppress_service_alerts(for_secs: u64) {
    *SUPPRESS_UNTIL.lock().unwrap() = Some(Instant::now() + Duration::from_secs(for_secs));
}

fn suppressed() -> bool {
    SUPPRESS_UNTIL.lock().unwrap().is_some_and(|t| Instant::now() < t)
}

/// Надёжного флага «остановлен вручную» у XKeen нет, поэтому «упал» = переход «ядро работало
/// при прошлой проверке → его нет сейчас», если панель не останавливала сервис последние
/// 10 минут (любое действие `POST /api/control`, кроме `start`).
static MANUAL_STOP_AT: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));

pub fn mark_manual_stop() {
    *MANUAL_STOP_AT.lock().unwrap() = Some(Instant::now());
}

fn stopped_by_user_recently() -> bool {
    MANUAL_STOP_AT
        .lock()
        .unwrap()
        .is_some_and(|t| t.elapsed() < Duration::from_secs(600))
}

/// Состояние, которое переживает тики фоновой задачи.
#[derive(Default)]
struct Watch {
    core_running: Option<bool>,
    down_notified: bool,
    ui_tag_sent: Option<String>,
    core_tag_sent: Option<String>,
}

fn core_running(core: &str) -> bool {
    !crate::controller::get_pid(core).is_empty()
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        let mut watch = Watch::default();
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let tg = state.settings.read().unwrap().automation.notify.telegram.clone();
            if !tg.enabled {
                watch.core_running = None;
                continue;
            }
            tick(&state, &tg, &mut watch).await;
        }
    });
}

async fn tick(state: &AppState, tg: &TelegramSettings, watch: &mut Watch) {
    // 1. Статус ядра
    let core = state.core.read().unwrap().name.clone();
    let core_c = core.clone();
    let running = tokio::task::spawn_blocking(move || core_running(&core_c))
        .await
        .unwrap_or(true);
    match (watch.core_running, running) {
        (Some(true), false) if !suppressed() && !stopped_by_user_recently() => {
            if tg.events.service_down {
                notify_event(state, "service_down", &format!("🔴 Ядро <b>{core}</b> не запущено — процесс завершился")).await;
            }
            watch.down_notified = true;
        }
        (Some(false), true) if watch.down_notified => {
            if tg.events.service_up {
                notify_event(state, "service_up", &format!("🟢 Ядро <b>{core}</b> снова работает")).await;
            }
            watch.down_notified = false;
        }
        (_, true) => watch.down_notified = false,
        _ => {}
    }
    watch.core_running = Some(running);

    // 2. Серверы — только по данным мониторинга аптайма
    if tg.events.server_down {
        for (tag, down) in crate::uptime::transitions_since_last_notify() {
            let (key, text) = if down {
                (format!("server_down:{tag}"), format!("⚠️ Сервер <b>{}</b> не отвечает", escape_html(&tag)))
            } else {
                (format!("server_up:{tag}"), format!("✅ Сервер <b>{}</b> снова доступен", escape_html(&tag)))
            };
            notify_event(state, &key, &text).await;
        }
    }

    // 3. Обновления — один раз на тег
    if tg.events.update_available {
        let uc = &state.update_checker;
        let ui_tag = (*uc.ui_outdated.read().unwrap()).then(|| uc.ui_latest_tag.read().unwrap().clone()).flatten();
        if let Some(tag) = ui_tag
            && watch.ui_tag_sent.as_deref() != Some(tag.as_str())
        {
            notify_event(state, &format!("update_ui:{tag}"), &format!("⬆️ Доступно обновление XKeen UI: <b>{}</b>", escape_html(&tag))).await;
            watch.ui_tag_sent = Some(tag);
        }
        let core_tag = (*uc.core_outdated.read().unwrap()).then(|| uc.core_latest_tag.read().unwrap().clone()).flatten();
        if let Some(tag) = core_tag
            && watch.core_tag_sent.as_deref() != Some(tag.as_str())
        {
            notify_event(
                state,
                &format!("update_core:{tag}"),
                &format!("⬆️ Доступно обновление {}: <b>{}</b>", escape_html(&core), escape_html(&tag)),
            )
            .await;
            watch.core_tag_sent = Some(tag);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_url_uses_default_and_custom_base() {
        assert_eq!(api_url("", "123:ABC"), "https://api.telegram.org/bot123:ABC/sendMessage");
        assert_eq!(api_url("https://tg.example.com/", "1:x"), "https://tg.example.com/bot1:x/sendMessage");
    }

    #[test]
    fn cooldown_blocks_repeats() {
        let key = "test-cooldown-key";
        assert!(cooldown_allows(key, Duration::from_secs(60)));
        assert!(!cooldown_allows(key, Duration::from_secs(60)));
        assert!(cooldown_allows("test-cooldown-other", Duration::from_secs(60)));
    }

    #[test]
    fn html_is_escaped() {
        assert_eq!(escape_html("a<b>&c"), "a&lt;b&gt;&amp;c");
    }

    #[test]
    fn old_config_without_notify_reads_defaults() {
        let s: NotifySettings = serde_json::from_str("{}").unwrap();
        assert!(!s.telegram.enabled);
        assert_eq!(s.telegram.api_base, DEFAULT_API_BASE);
        assert!(s.telegram.events.service_down);
    }
}
