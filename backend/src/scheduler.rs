//! Планировщик: обновление geo-файлов, плановый перезапуск ядра, автобэкап.
//!
//! Один тикер раз в минуту. Время задач — `HH:MM` в часовом поясе `settings.log.timezone`
//! (как и журнал). Задача выполняется не чаще раза в сутки: факт запуска запоминается по
//! дате (в памяти), поэтому пропущенное из-за перезапуска панели окно не догоняется —
//! так безопаснее для ночного перезапуска ядра.

use crate::logger::log;
use crate::types::AppState;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Команда обновления geo-файлов XKeen: так её вызывает cron, который ставит сам XKeen
/// (`$install_dir/xkeen -ug`, scripts/_xkeen/02_install/06_install_cron.sh в jameszeroX/XKeen).
pub const DEFAULT_GEO_COMMAND: &str = "/opt/sbin/xkeen -ug";

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ScheduledTask {
    pub enabled: bool,
    /// `HH:MM`
    pub time: String,
}

impl ScheduledTask {
    fn at(time: &str) -> Self {
        Self { enabled: false, time: time.into() }
    }
}

impl Default for ScheduledTask {
    fn default() -> Self {
        Self::at("04:00")
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GeoUpdateTask {
    pub enabled: bool,
    pub time: String,
    /// Shell-команда обновления (через `sh -c`).
    pub command: String,
}

impl Default for GeoUpdateTask {
    fn default() -> Self {
        Self {
            enabled: false,
            time: "04:30".into(),
            command: DEFAULT_GEO_COMMAND.into(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupTask {
    pub enabled: bool,
    pub time: String,
    /// Сколько последних автобэкапов хранить (ручные не считаются и не удаляются).
    pub keep: u32,
}

impl Default for BackupTask {
    fn default() -> Self {
        Self {
            enabled: false,
            time: "03:30".into(),
            keep: 7,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SchedulerSettings {
    pub geo_update: GeoUpdateTask,
    pub restart_core: ScheduledTask,
    pub backup: BackupTask,
}

impl Default for SchedulerSettings {
    fn default() -> Self {
        Self {
            geo_update: GeoUpdateTask::default(),
            restart_core: ScheduledTask::at("05:00"),
            backup: BackupTask::default(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Task {
    GeoUpdate,
    RestartCore,
    Backup,
}

impl Task {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "geo_update" => Some(Self::GeoUpdate),
            "restart_core" => Some(Self::RestartCore),
            "backup" => Some(Self::Backup),
            _ => None,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::GeoUpdate => "обновление geo-файлов",
            Self::RestartCore => "перезапуск ядра",
            Self::Backup => "автобэкап",
        }
    }
}

/// `HH:MM` → время. Допускает `H:MM`.
pub fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    let (h, m) = s.trim().split_once(':')?;
    NaiveTime::from_hms_opt(h.trim().parse().ok()?, m.trim().parse().ok()?, 0)
}

/// Пора ли запускать: текущая локальная минута совпадает с `time`, а сегодня ещё не запускали.
pub fn is_due(now_local: DateTime<FixedOffset>, time: &str, last_run: Option<NaiveDate>) -> bool {
    let Some(at) = parse_hhmm(time) else { return false };
    let today = now_local.date_naive();
    if last_run == Some(today) {
        return false;
    }
    let t = now_local.time();
    // Окно в 2 минуты на случай дрейфа тикера (тик может прийти в hh:mm:59 и следующий — в hh:mm+2:00).
    let start = at;
    let end = at + chrono::Duration::minutes(2);
    if end < start {
        // переход через полночь (23:59): окно [23:59, 24:00) ∪ [00:00, 00:01)
        t >= start || t < end
    } else {
        t >= start && t < end
    }
}

/// Ближайший будущий запуск (для UI), в локальном времени.
pub fn next_run(now_local: DateTime<FixedOffset>, time: &str) -> Option<DateTime<FixedOffset>> {
    let at = parse_hhmm(time)?;
    let tz = *now_local.offset();
    let today = now_local.date_naive().and_time(at).and_local_timezone(tz).single()?;
    Some(if today > now_local { today } else { today + chrono::Duration::days(1) })
}

pub fn local_now(tz_hours: i32) -> DateTime<FixedOffset> {
    let offset = FixedOffset::east_opt(tz_hours.clamp(-12, 14) * 3600).unwrap_or(FixedOffset::east_opt(0).unwrap());
    Utc::now().with_timezone(&offset)
}

#[derive(Clone, Serialize, Default)]
struct RunInfo {
    last_run: Option<String>,
    ok: Option<bool>,
    message: Option<String>,
}

static LAST_DATE: LazyLock<Mutex<HashMap<Task, NaiveDate>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static LAST_INFO: LazyLock<Mutex<HashMap<&'static str, RunInfo>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static RUNNING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn task_key(task: Task) -> &'static str {
    match task {
        Task::GeoUpdate => "geo_update",
        Task::RestartCore => "restart_core",
        Task::Backup => "backup",
    }
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let (sched, tz) = {
                let s = state.settings.read().unwrap();
                (s.automation.scheduler.clone(), s.log.timezone)
            };
            if !sched.geo_update.enabled && !sched.restart_core.enabled && !sched.backup.enabled {
                continue;
            }
            let now = local_now(tz);
            for (task, enabled, time) in [
                (Task::Backup, sched.backup.enabled, &sched.backup.time),
                (Task::GeoUpdate, sched.geo_update.enabled, &sched.geo_update.time),
                (Task::RestartCore, sched.restart_core.enabled, &sched.restart_core.time),
            ] {
                if !enabled {
                    continue;
                }
                let last = LAST_DATE.lock().unwrap().get(&task).copied();
                if is_due(now, time, last) {
                    LAST_DATE.lock().unwrap().insert(task, now.date_naive());
                    let st = state.clone();
                    tokio::spawn(async move {
                        let _ = run_task(&st, task, false).await;
                    });
                }
            }
        }
    });
}

async fn run_task(state: &AppState, task: Task, manual: bool) -> Result<String, String> {
    let _guard = RUNNING.lock().await;
    log(
        "INFO",
        format!("Планировщик: {} ({})", task.label(), if manual { "вручную" } else { "по расписанию" }),
    );
    let (sched, tz) = {
        let s = state.settings.read().unwrap();
        (s.automation.scheduler.clone(), s.log.timezone)
    };
    let result = match task {
        Task::Backup => {
            let keep = sched.backup.keep.max(1) as usize;
            tokio::task::spawn_blocking(move || crate::backuper::create_auto_backup_sync(tz, keep))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
                .map(|name| format!("Создан {name}"))
        }
        Task::GeoUpdate => run_shell(&sched.geo_update.command).await,
        Task::RestartCore => restart_core(state).await,
    };
    match &result {
        Ok(msg) => log("INFO", format!("Планировщик: {} — готово. {}", task.label(), msg)),
        Err(e) => {
            log("ERROR", format!("Планировщик: {} — ошибка: {}", task.label(), e));
            crate::notify::notify_event(
                state,
                &format!("scheduler:{}", task_key(task)),
                &format!("❗ Ошибка задачи «{}»: {}", task.label(), e.chars().take(300).collect::<String>()),
            )
            .await;
        }
    }
    LAST_INFO.lock().unwrap().insert(
        task_key(task),
        RunInfo {
            last_run: Some(local_now(tz).format("%Y-%m-%d %H:%M").to_string()),
            ok: Some(result.is_ok()),
            message: Some(match &result {
                Ok(m) => m.clone(),
                Err(e) => e.chars().take(300).collect(),
            }),
        },
    );
    result
}

/// Полный перезапуск ядра теми же средствами, что и кнопка «Перезапустить» (init-скрипт XKeen).
async fn restart_core(state: &AppState) -> Result<String, String> {
    crate::notify::suppress_service_alerts(180);
    crate::controller::run_init_command(state, &["restart", "on"]).await?;
    Ok("Ядро перезапущено".into())
}

/// Запуск shell-команды с таймаутом 10 минут, вывод — в журнал ядра (как у init-команд).
async fn run_shell(command: &str) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("Команда не задана".into());
    }
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(command);
    cmd.env("PATH", "/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    cmd.stdin(std::process::Stdio::null());
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(crate::types::error_log_path())
        && let Ok(clone) = file.try_clone()
    {
        cmd.stdout(clone).stderr(file);
    }
    cmd.kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(600), cmd.status())
        .await
        .map_err(|_| "Таймаут 10 минут".to_string())?
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(format!("`{command}` завершилась успешно"))
    } else {
        Err(format!("`{command}`: {status}"))
    }
}

#[derive(Deserialize)]
pub struct RunReq {
    task: String,
}

pub async fn post_scheduler_run(State(state): State<AppState>, Json(req): Json<RunReq>) -> impl IntoResponse {
    let Some(task) = Task::parse(&req.task) else {
        return Json(serde_json::json!({ "success": false, "error": "Неизвестная задача" }));
    };
    match run_task(&state, task, true).await {
        Ok(message) => Json(serde_json::json!({ "success": true, "message": message })),
        Err(error) => Json(serde_json::json!({ "success": false, "error": error })),
    }
}

/// Статус задач: последний запуск и следующий по расписанию.
pub async fn get_scheduler(State(state): State<AppState>) -> impl IntoResponse {
    let (sched, tz) = {
        let s = state.settings.read().unwrap();
        (s.automation.scheduler.clone(), s.log.timezone)
    };
    let now = local_now(tz);
    let info = LAST_INFO.lock().unwrap().clone();
    let mut tasks = serde_json::Map::new();
    for (key, enabled, time) in [
        ("geo_update", sched.geo_update.enabled, sched.geo_update.time.as_str()),
        ("restart_core", sched.restart_core.enabled, sched.restart_core.time.as_str()),
        ("backup", sched.backup.enabled, sched.backup.time.as_str()),
    ] {
        let last = info.get(key).cloned().unwrap_or_default();
        tasks.insert(
            key.into(),
            serde_json::json!({
                "next_run": enabled.then(|| next_run(now, time)).flatten().map(|t| t.format("%Y-%m-%d %H:%M").to_string()),
                "last_run": last.last_run,
                "ok": last.ok,
                "message": last.message,
            }),
        );
    }
    Json(serde_json::json!({ "success": true, "tasks": tasks }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32, s: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(3 * 3600).unwrap().with_ymd_and_hms(2026, 10, 26, h, m, s).unwrap()
    }

    #[test]
    fn parses_time() {
        assert_eq!(parse_hhmm("04:30"), NaiveTime::from_hms_opt(4, 30, 0));
        assert_eq!(parse_hhmm("4:05"), NaiveTime::from_hms_opt(4, 5, 0));
        assert!(parse_hhmm("24:00").is_none());
        assert!(parse_hhmm("abc").is_none());
    }

    #[test]
    fn due_only_inside_window_and_once_per_day() {
        assert!(!is_due(at(4, 29, 59), "04:30", None));
        assert!(is_due(at(4, 30, 0), "04:30", None));
        assert!(is_due(at(4, 31, 30), "04:30", None));
        assert!(!is_due(at(4, 32, 0), "04:30", None));
        let today = at(4, 30, 0).date_naive();
        assert!(!is_due(at(4, 30, 10), "04:30", Some(today)));
        assert!(is_due(at(4, 30, 10), "04:30", today.pred_opt()));
        assert!(!is_due(at(4, 30, 0), "bad", None));
    }

    #[test]
    fn due_window_wraps_midnight() {
        assert!(is_due(at(23, 59, 30), "23:59", None));
        assert!(is_due(at(0, 0, 30), "23:59", None));
        assert!(!is_due(at(0, 1, 0), "23:59", None));
    }

    #[test]
    fn next_run_today_or_tomorrow() {
        assert_eq!(next_run(at(3, 0, 0), "04:30").unwrap(), at(4, 30, 0));
        assert_eq!(next_run(at(5, 0, 0), "04:30").unwrap(), at(4, 30, 0) + chrono::Duration::days(1));
        assert_eq!(next_run(at(4, 30, 0), "04:30").unwrap(), at(4, 30, 0) + chrono::Duration::days(1));
    }

    #[test]
    fn defaults_are_disabled() {
        let s: SchedulerSettings = serde_json::from_str("{}").unwrap();
        assert!(!s.geo_update.enabled && !s.restart_core.enabled && !s.backup.enabled);
        assert_eq!(s.geo_update.command, DEFAULT_GEO_COMMAND);
        assert_eq!(s.backup.keep, 7);
    }

    #[test]
    fn task_names() {
        assert_eq!(Task::parse("backup"), Some(Task::Backup));
        assert_eq!(Task::parse("restart_core"), Some(Task::RestartCore));
        assert_eq!(Task::parse("nope"), None);
    }
}
