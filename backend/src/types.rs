use serde::{Deserialize, Serialize};
use std::io::BufReader;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::Instant;
use tokio::sync::{Mutex, broadcast};
use tokio::task::AbortHandle;

pub const APP_CONFIG: &str = "/opt/etc/xkeen/xkeen-ui.json";
pub const APP_CONFIG_LEGACY: &str = "/opt/share/www/XKeen-UI/config.json";
pub const DEFAULT_ACCESS_LOG: &str = "/opt/var/log/xray/access.log";
pub const DEFAULT_ERROR_LOG: &str = "/opt/var/log/xray/error.log";
pub const MIHOMO_CONF: &str = "/opt/etc/mihomo/config.yaml";
pub const MIHOMO_CONF_DIR: &str = "/opt/etc/mihomo";
pub const S24XRAY: &str = "/opt/etc/init.d/S24xray";
pub const S99XKEEN: &str = "/opt/etc/init.d/S99xkeen";
pub const S99XKEEN_UI: &str = "/opt/etc/init.d/S99xkeen-ui";
pub const VERSION: &str = concat!("v", env!("CARGO_PKG_VERSION"));
pub const XKEEN_CONF_DIR: &str = "/opt/etc/xkeen";
pub const XKEEN_CONF: &str = "/opt/etc/xkeen/xkeen.json";
pub const XKEEN_UI_LOG: &str = "/opt/var/log/xkeen-ui.log";
pub const XRAY_ASSET_DIR: &str = "/opt/etc/xray/dat";
pub const XRAY_CONF_DIR: &str = "/opt/etc/xray/configs";

pub type GeoCache = std::collections::HashMap<String, (std::time::SystemTime, bool, bool)>;

#[derive(Clone)]
pub struct XrayLogPaths {
    pub error: String,
    pub access: String,
}

impl Default for XrayLogPaths {
    fn default() -> Self {
        Self {
            error: DEFAULT_ERROR_LOG.into(),
            access: DEFAULT_ACCESS_LOG.into(),
        }
    }
}

static XRAY_LOG_PATHS: LazyLock<RwLock<XrayLogPaths>> = LazyLock::new(|| RwLock::new(XrayLogPaths::default()));

fn normalize_xray_log_path(path: Option<&str>, fallback: &str) -> String {
    path.map(str::trim)
        .filter(|p| !p.is_empty() && !p.eq_ignore_ascii_case("none"))
        .unwrap_or(fallback)
        .to_string()
}

fn resolve_xray_log_paths() -> XrayLogPaths {
    let mut paths = XrayLogPaths::default();
    let Ok(entries) = std::fs::read_dir(XRAY_CONF_DIR) else {
        return paths;
    };

    let mut json_files: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("json")))
        .collect();

    json_files.sort();

    for path in json_files {
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        let reader = BufReader::new(file);

        let Ok(json) = serde_json::from_reader::<_, serde_json::Value>(reader) else {
            continue;
        };

        if let Some(log) = json.get("log").and_then(|v| v.as_object()) {
            if let Some(access) = log.get("access").and_then(|v| v.as_str()) {
                paths.access = normalize_xray_log_path(Some(access), DEFAULT_ACCESS_LOG);
            }
            if let Some(error) = log.get("error").and_then(|v| v.as_str()) {
                paths.error = normalize_xray_log_path(Some(error), DEFAULT_ERROR_LOG);
            }
        }
    }

    paths
}

pub fn refresh_xray_log_paths() {
    *XRAY_LOG_PATHS.write().unwrap() = resolve_xray_log_paths();
}

pub fn error_log_path() -> String {
    XRAY_LOG_PATHS.read().unwrap().error.clone()
}

pub fn access_log_path() -> String {
    XRAY_LOG_PATHS.read().unwrap().access.clone()
}

#[derive(Clone)]
pub struct AppState {
    pub core: Arc<RwLock<CoreInfo>>,
    pub settings: Arc<RwLock<AppSettings>>,
    pub init_file: Arc<RwLock<Option<String>>>,
    pub http_client: reqwest::Client,
    pub update_checker: UpdateChecker,
    pub geo_cache: Arc<RwLock<GeoCache>>,
    pub log_tx: Arc<broadcast::Sender<String>>,
    pub log_watcher: Arc<Mutex<Option<AbortHandle>>>,
    pub app_config_lock: Arc<Mutex<()>>,
    pub debug: bool,
    pub rci_token: Option<String>,
}

#[derive(Clone, Default)]
pub struct UpdateChecker {
    pub ui_outdated: Arc<RwLock<bool>>,
    pub core_outdated: Arc<RwLock<bool>>,
    pub last_ui_check: Arc<RwLock<Option<Instant>>>,
    pub last_core_check: Arc<RwLock<Option<Instant>>>,
    pub last_ui_toast: Arc<RwLock<Option<Instant>>>,
    pub last_core_toast: Arc<RwLock<Option<Instant>>>,
    pub ui_latest_tag: Arc<RwLock<Option<String>>>,
    pub core_latest_tag: Arc<RwLock<Option<String>>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CoreInfo {
    pub name: String,
    pub conf_dir: String,
    pub is_json: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
#[derive(Default)]
pub struct GuiSettings {
    pub routing: bool,
    pub outbounds: bool,
    pub log: bool,
    pub auto_apply: bool,
}


#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdaterSettings {
    pub auto_check_ui: bool,
    pub auto_check_core: bool,
    pub backup_core: bool,
    pub github_proxy: Vec<String>,
    pub xray_repo: String,
    pub mihomo_repo: String,
}

impl Default for UpdaterSettings {
    fn default() -> Self {
        Self {
            github_proxy: vec!["https://gh-proxy.com".into(), "https://ghfast.top".into()],
            xray_repo: "https://github.com/XTLS/Xray-core".into(),
            mihomo_repo: "https://github.com/MetaCubeX/mihomo".into(),
            backup_core: true,
            auto_check_ui: true,
            auto_check_core: true,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LogSettings {
    pub timezone: i32,
}

impl Default for LogSettings {
    fn default() -> Self {
        Self { timezone: 3 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PingMode {
    Single,
    Double,
    DoubleKeepAlive,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ClashApiSettings {
    pub ping_url: String,
    pub ping_timeout: u32,
    pub show_source_name: bool,
    pub hide_unavailable_proxies: bool,
    pub hide_unavailable_proxies_counter: u32,
    pub proxy_sort_order: String,
    pub auto_dns: String,
    pub close_connections_on_apply: bool,
    pub ping_mode: PingMode,
}

impl Default for ClashApiSettings {
    fn default() -> Self {
        Self {
            ping_url: "http://cp.cloudflare.com/generate_204".into(),
            ping_timeout: 5000,
            show_source_name: false,
            hide_unavailable_proxies: false,
            hide_unavailable_proxies_counter: 3,
            proxy_sort_order: "default".into(),
            auto_dns: "disabled".into(),
            close_connections_on_apply: false,
            ping_mode: PingMode::DoubleKeepAlive,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AuthSettings {
    pub enabled: bool,
    pub password_hash: Option<String>,
    pub session_ids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppendConfigPaths {
    pub xray: Vec<String>,
    pub mihomo: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RemoteRouter {
    pub host: String,
    pub port: u16,
    pub name: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PluginsSettings {
    pub multi_router: bool,
    pub routers: Vec<RemoteRouter>,
}

/// Автоматизация: уведомления, расписание, подписки Xray, мониторинг аптайма.
/// Всё выключено по умолчанию — фоновые задачи на слабом роутере просыпаются вхолостую.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AutomationSettings {
    pub notify: crate::notify::NotifySettings,
    pub scheduler: crate::scheduler::SchedulerSettings,
    pub subscriptions: crate::subscriptions::SubscriptionsSettings,
    pub uptime: crate::uptime::UptimeSettings,
}

/// Папка селекторов — чисто визуальная группировка в панели, конфиг ядра не меняется.
#[derive(Clone, Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(default)]
pub struct SelectorFolder {
    pub id: String,
    pub name: String,
    /// URL иконки или пусто.
    pub icon: String,
    /// Имена групп (proxy-groups) mihomo в порядке отображения.
    pub groups: Vec<String>,
}

/// Настройки интерфейса панели, общие для всех браузеров.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct UiSettings {
    pub selector_folders: Vec<SelectorFolder>,
}

pub const SELECTOR_FOLDER_NAME_MAX: usize = 40;

#[derive(Clone, Serialize, Default)]
pub struct AppSettings {
    pub gui: GuiSettings,
    pub updater: UpdaterSettings,
    pub log: LogSettings,
    pub clash_api: ClashApiSettings,
    pub append_config_paths: AppendConfigPaths,
    pub auth: AuthSettings,
    pub plugins: PluginsSettings,
    pub automation: AutomationSettings,
    pub ui: UiSettings,
}

impl<'de> Deserialize<'de> for AppSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawConfig {
            #[serde(default)]
            gui: GuiSettings,
            #[serde(default)]
            updater: UpdaterSettings,
            #[serde(default)]
            log: LogSettings,
            #[serde(default)]
            clash_api: ClashApiSettings,
            #[serde(default)]
            append_config_paths: AppendConfigPaths,
            #[serde(default)]
            auth: AuthSettings,
            #[serde(default)]
            plugins: PluginsSettings,
            #[serde(default)]
            automation: AutomationSettings,
            #[serde(default)]
            ui: UiSettings,
            #[serde(rename = "timezoneOffset")]
            legacy_tz: Option<i32>,
        }
        let mut raw = RawConfig::deserialize(deserializer)?;
        if let Some(tz) = raw.legacy_tz {
            raw.log.timezone = tz;
        }
        Ok(Self {
            gui: raw.gui,
            updater: raw.updater,
            log: raw.log,
            clash_api: raw.clash_api,
            append_config_paths: raw.append_config_paths,
            auth: raw.auth,
            plugins: raw.plugins,
            automation: raw.automation,
            ui: raw.ui,
        })
    }
}

impl AppSettings {
    pub fn normalize_proxies(&mut self) {
        self.updater.github_proxy = self
            .updater
            .github_proxy
            .iter()
            .map(|p| {
                if p.starts_with("http") {
                    p.to_string()
                } else {
                    format!("https://{}", p.trim_start_matches("://"))
                }
            })
            .collect();
    }

    pub fn validate_automation(&mut self) -> Result<(), String> {
        let a = &mut self.automation;
        for (name, time) in [
            ("обновления geo", &a.scheduler.geo_update.time),
            ("перезапуска ядра", &a.scheduler.restart_core.time),
            ("автобэкапа", &a.scheduler.backup.time),
        ] {
            if crate::scheduler::parse_hhmm(time).is_none() {
                return Err(format!("Некорректное время {}: ожидается ЧЧ:ММ", name));
            }
        }
        a.scheduler.backup.keep = a.scheduler.backup.keep.clamp(1, 100);
        a.uptime.interval_minutes = a.uptime.interval_minutes.clamp(crate::uptime::MIN_INTERVAL_MIN, 1440);
        a.notify.telegram.cooldown_minutes = a.notify.telegram.cooldown_minutes.clamp(1, 1440);
        let mut names = std::collections::HashSet::new();
        for sub in &mut a.subscriptions.items {
            sub.name = sub.name.trim().to_string();
            sub.url = sub.url.trim().to_string();
            sub.interval_hours = sub.interval_hours.clamp(1, 24 * 7);
            let key = crate::subscriptions::sanitize_name(&sub.name);
            if key.is_empty() {
                return Err("Имя подписки: нужны латинские буквы или цифры".into());
            }
            if !names.insert(key) {
                return Err(format!("Подписка с именем «{}» уже есть", sub.name));
            }
            if !(sub.url.starts_with("http://") || sub.url.starts_with("https://")) {
                return Err(format!("Подписка «{}»: URL должен начинаться с http(s)://", sub.name));
            }
        }
        Ok(())
    }

    /// Папки селекторов: имя непустое и не длиннее `SELECTOR_FOLDER_NAME_MAX`, id уникальны,
    /// группа лежит не более чем в одной папке. Пробелы по краям и пустые имена групп убираются.
    pub fn validate_ui(&mut self) -> Result<(), String> {
        let mut ids = std::collections::HashSet::new();
        // группа → (id, имя) папки
        let mut owner: std::collections::HashMap<String, (String, String)> = std::collections::HashMap::new();
        for f in &mut self.ui.selector_folders {
            f.id = f.id.trim().to_string();
            f.name = f.name.trim().to_string();
            f.icon = f.icon.trim().to_string();
            let mut seen = std::collections::HashSet::new();
            f.groups = f
                .groups
                .iter()
                .map(|g| g.trim().to_string())
                .filter(|g| !g.is_empty() && seen.insert(g.clone()))
                .collect();
            if f.name.is_empty() {
                return Err("Имя папки не может быть пустым".into());
            }
            if f.name.chars().count() > SELECTOR_FOLDER_NAME_MAX {
                return Err(format!("Имя папки «{}» длиннее {} символов", f.name, SELECTOR_FOLDER_NAME_MAX));
            }
            if f.id.is_empty() {
                return Err(format!("У папки «{}» нет id", f.name));
            }
            if !ids.insert(f.id.clone()) {
                return Err(format!("id папки «{}» повторяется", f.id));
            }
            for g in &f.groups {
                if let Some((_, prev)) = owner.insert(g.clone(), (f.id.clone(), f.name.clone())) {
                    return Err(format!("Селектор «{g}» уже лежит в папке «{prev}»"));
                }
            }
        }
        Ok(())
    }

    pub fn validate_plugins(&self) -> Result<(), String> {
        for router in &self.plugins.routers {
            if router.host.trim().is_empty() {
                return Err("Хост роутера не может быть пустым".into());
            }
            if router.port == 0 {
                return Err("Неверный порт роутера".into());
            }
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(flatten)]
    pub data: Option<T>,
}

#[derive(Deserialize)]
pub struct UpdateReq {
    pub core: String,
    pub version: String,
    pub backup_core: bool,
    #[serde(default)]
    pub assets: Vec<String>,
}

#[cfg(test)]
mod ui_settings_tests {
    use super::*;

    fn folder(id: &str, name: &str, groups: &[&str]) -> SelectorFolder {
        SelectorFolder { id: id.into(), name: name.into(), icon: String::new(), groups: groups.iter().map(|g| g.to_string()).collect() }
    }

    #[test]
    fn old_config_without_ui_deserializes() {
        let s: AppSettings = serde_json::from_str(r#"{"gui":{"routing":true},"log":{"timezone":5}}"#).unwrap();
        assert!(s.ui.selector_folders.is_empty());
        assert_eq!(s.log.timezone, 5);
    }

    #[test]
    fn ui_folders_roundtrip() {
        let json = r#"{"ui":{"selector_folders":[{"id":"ai","name":"AI","icon":"https://x/ai.png","groups":["AI","ChatGPT","Claude","Gemini"]}]}}"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.ui.selector_folders, vec![SelectorFolder { icon: "https://x/ai.png".into(), ..folder("ai", "AI", &["AI", "ChatGPT", "Claude", "Gemini"]) }]);
        let v = serde_json::to_value(&s.ui).unwrap();
        assert_eq!(v["selector_folders"][0]["groups"][3], "Gemini");
        // неполная запись папки — поля по умолчанию
        let s2: AppSettings = serde_json::from_str(r#"{"ui":{"selector_folders":[{"id":"x","name":"X"}]}}"#).unwrap();
        assert!(s2.ui.selector_folders[0].groups.is_empty() && s2.ui.selector_folders[0].icon.is_empty());
    }

    #[test]
    fn validate_ui_rules() {
        let mut s = AppSettings::default();
        s.ui.selector_folders = vec![folder(" ai ", " AI ", &[" AI ", "ChatGPT", "ChatGPT", ""]), folder("media", "Медиа", &["YouTube"])];
        assert!(s.validate_ui().is_ok());
        assert_eq!(s.ui.selector_folders[0].id, "ai");
        assert_eq!(s.ui.selector_folders[0].name, "AI");
        assert_eq!(s.ui.selector_folders[0].groups, vec!["AI".to_string(), "ChatGPT".to_string()]);

        s.ui.selector_folders = vec![folder("a", "   ", &[])];
        assert!(s.validate_ui().unwrap_err().contains("пустым"));

        s.ui.selector_folders = vec![folder("a", &"я".repeat(SELECTOR_FOLDER_NAME_MAX + 1), &[])];
        assert!(s.validate_ui().is_err());
        s.ui.selector_folders = vec![folder("a", &"я".repeat(SELECTOR_FOLDER_NAME_MAX), &[])];
        assert!(s.validate_ui().is_ok());

        s.ui.selector_folders = vec![folder("a", "A", &[]), folder("a", "B", &[])];
        assert!(s.validate_ui().unwrap_err().contains("повторяется"));

        s.ui.selector_folders = vec![folder("a", "A", &["AI"]), folder("b", "B", &["AI"])];
        assert!(s.validate_ui().unwrap_err().contains("«AI»"));

        s.ui.selector_folders = vec![folder("", "A", &[])];
        assert!(s.validate_ui().is_err());
    }
}
