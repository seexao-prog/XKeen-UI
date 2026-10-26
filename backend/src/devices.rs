//! Устройства локальной сети и их участие в проксировании XKeen.
//!
//! Как XKeen выбирает трафик для прокси (jameszeroX/XKeen, `04_register_init.sh`):
//! - ищет в `rci/show/ip/policy` политику доступа Keenetic с описанием `xkeen`
//!   (и `xkeen_full` — принудительное проксирование), берёт её fwmark и в iptables
//!   перехватывает только пакеты с этим mark. Устройство попадает в прокси, если в
//!   Keenetic ему назначена эта политика (`ip hotspot host <mac> policy <PolicyN>`).
//!   Смена политики хоста применяется сразу, без перезапуска XKeen.
//! - если политики `xkeen` нет — проксируются все клиенты; исключить устройство можно
//!   только через `/opt/etc/xkeen/ip_exclude.lst` (ipset `user_exclude` сверяется и с
//!   src, и с dst), а такие изменения подхватываются лишь после перезапуска XKeen.
//!
//! Формат RCI-команд назначения/снятия политики — как в hoaxisr/awg-manager
//! (`internal/ndms/command/policies.go`): `{"ip":{"hotspot":{"host":{"mac":…,"policy":…}}}}`
//! и `"policy":{"no":true}`.

use crate::logger::log;
use crate::types::{AppState, XKEEN_CONF_DIR};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;

const POLICY_DESCRIPTION: &str = "xkeen";
const POLICY_FULL_DESCRIPTION: &str = "xkeen_full";

fn ip_exclude_path() -> String {
    format!("{XKEEN_CONF_DIR}/ip_exclude.lst")
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Device {
    pub mac: String,
    pub ip: String,
    pub name: String,
    pub online: bool,
    /// Внутреннее имя политики Keenetic (PolicyN), назначенной хосту.
    pub policy: String,
    pub in_proxy: bool,
    /// Устройство в `xkeen_full` (принудительное проксирование) — переключатель его не трогает.
    pub forced: bool,
}

/// Внутренние имена (`PolicyN`) политик XKeen по описанию из `show ip policy`.
#[derive(Debug, Default, PartialEq)]
pub struct XkeenPolicies {
    pub main: Option<String>,
    pub full: Option<String>,
}

pub fn find_xkeen_policies(policies: &Value) -> XkeenPolicies {
    let mut found = XkeenPolicies::default();
    let Some(map) = policies.as_object() else {
        return found;
    };
    for (name, policy) in map {
        let description = policy.get("description").and_then(Value::as_str).unwrap_or_default();
        if description.eq_ignore_ascii_case(POLICY_DESCRIPTION) {
            found.main = Some(name.clone());
        } else if description.eq_ignore_ascii_case(POLICY_FULL_DESCRIPTION) {
            found.full = Some(name.clone());
        }
    }
    found
}

fn parse_active(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "yes" || s == "true",
        _ => false,
    }
}

pub fn normalize_mac(mac: &str) -> Option<String> {
    let mac = mac.trim().to_ascii_lowercase();
    let parts: Vec<&str> = mac.split(':').collect();
    (parts.len() == 6 && parts.iter().all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit()))).then_some(mac)
}

/// IPv4-адреса из ip_exclude.lst (комментарии и подсети /32 учитываются, прочие подсети — нет).
pub fn parse_ip_exclude(content: &str) -> Vec<String> {
    content
        .lines()
        .map(|line| line.split('#').next().unwrap_or_default().trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.strip_suffix("/32").unwrap_or(line).to_string())
        .collect()
}

/// Добавляет или убирает адрес устройства в ip_exclude.lst, не трогая остальные строки.
pub fn toggle_ip_exclude(content: &str, ip: &str, exclude: bool, label: &str) -> String {
    let matches = |line: &str| {
        let value = line.split('#').next().unwrap_or_default().trim();
        value == ip || value == format!("{ip}/32")
    };
    let mut lines: Vec<String> = content.lines().filter(|line| !matches(line)).map(str::to_string).collect();
    if exclude {
        let label = label.replace(['\n', '\r', '#'], " ");
        lines.push(format!("{ip} # xkeen-ui: {}", label.trim()));
    }
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

pub fn build_devices(hotspot: &Value, policies: &XkeenPolicies, excluded: &[String]) -> Vec<Device> {
    let hosts = hotspot
        .get("host")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| hotspot.as_array().cloned())
        .unwrap_or_default();

    let mut out: Vec<Device> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for host in hosts {
        let Some(mac) = host.get("mac").and_then(Value::as_str).and_then(normalize_mac) else {
            continue;
        };
        let ip = host
            .get("ip")
            .and_then(Value::as_str)
            .filter(|ip| *ip != "0.0.0.0")
            .unwrap_or_default()
            .to_string();
        let name = ["name", "hostname"]
            .iter()
            .filter_map(|k| host.get(*k).and_then(Value::as_str))
            .find(|s| !s.trim().is_empty())
            .unwrap_or_default()
            .to_string();
        let policy = host.get("policy").and_then(Value::as_str).unwrap_or_default().to_string();
        let forced = policies.full.as_deref().is_some_and(|p| p == policy);
        let in_proxy = match &policies.main {
            Some(main) => forced || *main == policy,
            None => ip.is_empty() || !excluded.contains(&ip),
        };
        let device = Device {
            online: parse_active(host.get("active")),
            mac: mac.clone(),
            ip,
            name,
            policy,
            in_proxy,
            forced,
        };
        match seen.get(&mac) {
            Some(&idx) => {
                if device.online {
                    out[idx] = device;
                }
            }
            None => {
                seen.insert(mac, out.len());
                out.push(device);
            }
        }
    }
    out.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

async fn rci_get(state: &AppState, endpoint: &str) -> Result<Value, String> {
    let mut req = state
        .http_client
        .get(format!("http://127.0.0.1:79/rci/show/{endpoint}"))
        .timeout(Duration::from_secs(5));
    if let Some(token) = state.rci_token.as_ref() {
        req = req.header("X-Ndma-Tkn", token);
    }
    let response = req.send().await.map_err(|e| format!("Ошибка запроса RCI ({endpoint}): {e}"))?;
    if !response.status().is_success() {
        return Err(format!("RCI ({endpoint}) вернул {}", response.status()));
    }
    response.json().await.map_err(|e| format!("Ошибка парсинга RCI ({endpoint}): {e}"))
}

async fn rci_post(state: &AppState, commands: &Value) -> Result<Value, String> {
    let mut req = state
        .http_client
        .post("http://127.0.0.1:79/rci/")
        .json(commands)
        .timeout(Duration::from_secs(10));
    if let Some(token) = state.rci_token.as_ref() {
        req = req.header("X-Ndma-Tkn", token);
    }
    let response = req.send().await.map_err(|e| format!("Ошибка POST RCI: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("RCI вернул {status}: {}", body.chars().take(300).collect::<String>()));
    }
    response.json().await.map_err(|e| format!("Ошибка парсинга ответа RCI: {e}"))
}

/// Первая ошибка из ответа RCI (`"status":[{"status":"error","message":…}]` на любой глубине).
pub fn find_rci_error(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(items) = map.get("status").and_then(Value::as_array) {
                for item in items {
                    if item.get("status").and_then(Value::as_str) == Some("error") {
                        let message = item.get("message").and_then(Value::as_str).unwrap_or("неизвестная ошибка RCI");
                        return Some(message.to_string());
                    }
                }
            }
            map.values().find_map(find_rci_error)
        }
        Value::Array(items) => items.iter().find_map(find_rci_error),
        _ => None,
    }
}

struct Snapshot {
    devices: Vec<Device>,
    policies: XkeenPolicies,
}

async fn load_snapshot(state: &AppState) -> Result<Snapshot, String> {
    let (hotspot, policies) = tokio::join!(rci_get(state, "ip/hotspot"), rci_get(state, "ip/policy"));
    let hotspot = hotspot?;
    let policies = find_xkeen_policies(&policies?);
    let excluded = if policies.main.is_none() {
        parse_ip_exclude(&tokio::fs::read_to_string(ip_exclude_path()).await.unwrap_or_default())
    } else {
        Vec::new()
    };
    Ok(Snapshot {
        devices: build_devices(&hotspot, &policies, &excluded),
        policies,
    })
}

pub async fn get_devices(State(state): State<AppState>) -> impl IntoResponse {
    match load_snapshot(&state).await {
        Ok(snapshot) => Json(json!({
            "success": true,
            "mode": if snapshot.policies.main.is_some() { "policy" } else { "exclude_list" },
            "policy": snapshot.policies.main,
            "policy_full": snapshot.policies.full,
            "devices": snapshot.devices,
        })),
        Err(e) => Json(json!({ "success": false, "error": e })),
    }
}

#[derive(Deserialize)]
pub struct DeviceProxyReq {
    pub mac: String,
    pub enabled: bool,
}

pub async fn post_device_proxy(State(state): State<AppState>, Json(req): Json<DeviceProxyReq>) -> impl IntoResponse {
    let Some(mac) = normalize_mac(&req.mac) else {
        return Json(json!({ "success": false, "error": "Некорректный MAC-адрес" }));
    };
    let snapshot = match load_snapshot(&state).await {
        Ok(s) => s,
        Err(e) => return Json(json!({ "success": false, "error": e })),
    };
    let Some(device) = snapshot.devices.iter().find(|d| d.mac == mac) else {
        return Json(json!({ "success": false, "error": "Устройство не найдено в списке хостов роутера" }));
    };
    if device.forced {
        return Json(json!({
            "success": false,
            "error": "Устройство в политике xkeen_full (принудительный прокси) — измените её в веб-интерфейсе Keenetic",
        }));
    }
    if device.in_proxy == req.enabled {
        return Json(json!({ "success": true, "restart_required": false }));
    }

    match snapshot.policies.main {
        Some(policy) => {
            let host = if req.enabled {
                json!({ "mac": mac, "policy": policy })
            } else {
                json!({ "mac": mac, "policy": { "no": true } })
            };
            let commands = json!([
                { "ip": { "hotspot": { "host": host } } },
                { "system": { "configuration": { "save": {} } } }
            ]);
            match rci_post(&state, &commands).await {
                Ok(resp) => {
                    if let Some(e) = find_rci_error(&resp) {
                        return Json(json!({ "success": false, "error": format!("Keenetic отклонил команду: {e}") }));
                    }
                }
                Err(e) => return Json(json!({ "success": false, "error": e })),
            }
            log(
                "INFO",
                format!(
                    "Устройство {} ({}) {} политики {}",
                    device.name, mac, if req.enabled { "добавлено в" } else { "убрано из" }, POLICY_DESCRIPTION
                ),
            );
            Json(json!({ "success": true, "restart_required": false }))
        }
        None => {
            if device.ip.is_empty() {
                return Json(json!({ "success": false, "error": "У устройства нет IP-адреса — исключение по списку невозможно" }));
            }
            let path = ip_exclude_path();
            let current = tokio::fs::read_to_string(&path).await.unwrap_or_default();
            let label = if device.name.is_empty() { mac.clone() } else { format!("{} {}", device.name, mac) };
            let next = toggle_ip_exclude(&current, &device.ip, !req.enabled, &label);
            if let Err(e) = tokio::fs::create_dir_all(XKEEN_CONF_DIR).await {
                return Json(json!({ "success": false, "error": e.to_string() }));
            }
            let tmp = format!("{path}.tmp");
            if let Err(e) = tokio::fs::write(&tmp, &next).await {
                return Json(json!({ "success": false, "error": format!("Не удалось записать {path}: {e}") }));
            }
            if let Err(e) = tokio::fs::rename(&tmp, &path).await {
                return Json(json!({ "success": false, "error": format!("Не удалось записать {path}: {e}") }));
            }
            log(
                "INFO",
                format!("Устройство {} {} ip_exclude.lst", device.ip, if req.enabled { "убрано из" } else { "добавлено в" }),
            );
            Json(json!({ "success": true, "restart_required": true }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policies() -> Value {
        json!({
            "Policy0": { "description": "XKeen", "mark": "ffffaaa" },
            "Policy1": { "description": "xkeen_full", "mark": "ffffaab" },
            "Policy2": { "description": "VPN" }
        })
    }

    #[test]
    fn finds_xkeen_policies_case_insensitive() {
        let found = find_xkeen_policies(&policies());
        assert_eq!(found.main.as_deref(), Some("Policy0"));
        assert_eq!(found.full.as_deref(), Some("Policy1"));
        assert_eq!(find_xkeen_policies(&json!([])), XkeenPolicies::default());
    }

    #[test]
    fn builds_devices_in_policy_mode() {
        let hotspot = json!({ "host": [
            { "mac": "AA:BB:CC:DD:EE:01", "ip": "192.168.1.10", "name": "PC", "active": true, "policy": "Policy0" },
            { "mac": "aa:bb:cc:dd:ee:02", "ip": "0.0.0.0", "hostname": "phone", "active": "no" },
            { "mac": "aa:bb:cc:dd:ee:03", "ip": "192.168.1.12", "name": "TV", "active": "yes", "policy": "Policy1" },
            { "mac": "bad", "ip": "192.168.1.13" }
        ]});
        let devices = build_devices(&hotspot, &find_xkeen_policies(&policies()), &[]);
        assert_eq!(devices.len(), 3);
        let pc = devices.iter().find(|d| d.name == "PC").unwrap();
        assert!(pc.in_proxy && pc.online && !pc.forced);
        assert_eq!(pc.mac, "aa:bb:cc:dd:ee:01");
        let phone = devices.iter().find(|d| d.name == "phone").unwrap();
        assert!(!phone.in_proxy && !phone.online && phone.ip.is_empty());
        let tv = devices.iter().find(|d| d.name == "TV").unwrap();
        assert!(tv.in_proxy && tv.forced);
        assert!(!devices.last().unwrap().online);
    }

    #[test]
    fn builds_devices_in_exclude_mode() {
        let hotspot = json!({ "host": [
            { "mac": "aa:bb:cc:dd:ee:01", "ip": "192.168.1.10", "name": "PC", "active": true },
            { "mac": "aa:bb:cc:dd:ee:02", "ip": "192.168.1.11", "name": "NAS", "active": true }
        ]});
        let excluded = parse_ip_exclude("# comment\n192.168.1.11/32 # nas\n10.0.0.0/8\n");
        let devices = build_devices(&hotspot, &XkeenPolicies::default(), &excluded);
        assert!(devices.iter().find(|d| d.name == "PC").unwrap().in_proxy);
        assert!(!devices.iter().find(|d| d.name == "NAS").unwrap().in_proxy);
    }

    #[test]
    fn toggles_ip_exclude_preserving_other_lines() {
        let base = "# user list\n10.0.0.0/8\n";
        let added = toggle_ip_exclude(base, "192.168.1.10", true, "PC aa:bb");
        assert_eq!(added, "# user list\n10.0.0.0/8\n192.168.1.10 # xkeen-ui: PC aa:bb\n");
        assert_eq!(toggle_ip_exclude(&added, "192.168.1.10", true, "PC"), "# user list\n10.0.0.0/8\n192.168.1.10 # xkeen-ui: PC\n");
        assert_eq!(toggle_ip_exclude(&added, "192.168.1.10", false, ""), base);
        assert_eq!(toggle_ip_exclude("192.168.1.10/32\n", "192.168.1.10", false, ""), "");
    }

    #[test]
    fn normalizes_mac() {
        assert_eq!(normalize_mac(" AA:bb:CC:dd:EE:ff ").as_deref(), Some("aa:bb:cc:dd:ee:ff"));
        assert!(normalize_mac("aa:bb:cc:dd:ee").is_none());
        assert!(normalize_mac("aa:bb:cc:dd:ee:zz").is_none());
    }

    #[test]
    fn finds_nested_rci_error() {
        let ok = json!([{ "ip": { "hotspot": { "host": { "status": [{ "status": "message", "message": "ok" }] } } } }, {}]);
        assert!(find_rci_error(&ok).is_none());
        let err = json!([{ "ip": { "hotspot": { "host": { "status": [{ "status": "error", "message": "no such policy" }] } } } }]);
        assert_eq!(find_rci_error(&err).as_deref(), Some("no such policy"));
    }
}
