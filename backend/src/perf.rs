//! Живой монитор нагрузки (`GET /api/perf`): загрузка CPU по ядрам, CPU/RSS процесса ядра
//! (xray/mihomo) и скорость интерфейсов. Всё читается из /proc без внешних команд и только
//! по запросу UI: скорость считается по разнице с предыдущим снимком (хранится в памяти).

use crate::controller::get_pid;
use crate::types::AppState;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Счётчики одной строки `cpuN` из /proc/stat: (занято, всего) в тиках.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct CpuTimes {
    pub busy: u64,
    pub total: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProcStat {
    /// Суммарная строка `cpu`.
    pub all: CpuTimes,
    /// Строки `cpu0`, `cpu1`, ...
    pub cores: Vec<CpuTimes>,
}

/// Разбор /proc/stat. `idle` и `iowait` считаются простоем, остальное — занятостью
/// (guest уже входит в user, поэтому берём первые 8 полей).
pub fn parse_proc_stat(content: &str) -> ProcStat {
    let mut stat = ProcStat::default();
    for line in content.lines() {
        let mut parts = line.split_whitespace();
        let Some(label) = parts.next() else { continue };
        if !label.starts_with("cpu") {
            continue;
        }
        let values: Vec<u64> = parts.take(8).filter_map(|v| v.parse().ok()).collect();
        if values.len() < 4 {
            continue;
        }
        let total: u64 = values.iter().sum();
        let idle = values[3] + values.get(4).copied().unwrap_or(0);
        let times = CpuTimes { busy: total.saturating_sub(idle), total };
        if label == "cpu" {
            stat.all = times;
        } else {
            stat.cores.push(times);
        }
    }
    stat
}

/// utime+stime (тики) из /proc/<pid>/stat. Имя процесса в скобках может содержать
/// пробелы, поэтому поля отсчитываются после последней `)`.
pub fn parse_pid_stat(content: &str) -> Option<u64> {
    let rest = &content[content.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // После `)`: [0]=state(3) … [11]=utime(14), [12]=stime(15).
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    Some(utime + stime)
}

/// VmRSS в байтах из /proc/<pid>/status.
pub fn parse_vm_rss(content: &str) -> Option<u64> {
    content.lines().find_map(|line| {
        let value = line.strip_prefix("VmRSS:")?;
        let kb: u64 = value.split_whitespace().next()?.parse().ok()?;
        Some(kb * 1024)
    })
}

/// Байты rx/tx по интерфейсам из /proc/net/dev.
pub fn parse_net_dev(content: &str) -> Vec<(String, u64, u64)> {
    content
        .lines()
        .filter_map(|line| {
            let (name, data) = line.split_once(':')?;
            let fields: Vec<u64> = data.split_whitespace().filter_map(|v| v.parse().ok()).collect();
            if fields.len() < 9 {
                return None;
            }
            Some((name.trim().to_string(), fields[0], fields[8]))
        })
        .collect()
}

fn percent(delta_busy: u64, delta_total: u64) -> f64 {
    if delta_total == 0 {
        return 0.0;
    }
    ((delta_busy as f64 / delta_total as f64) * 1000.0).round() / 10.0
}

#[derive(Clone)]
struct Sample {
    at: Instant,
    stat: ProcStat,
    process_ticks: Option<u64>,
    process_name: String,
    net: HashMap<String, (u64, u64)>,
}

static PREVIOUS: LazyLock<Mutex<Option<Sample>>> = LazyLock::new(|| Mutex::new(None));

fn take_sample(process: &str) -> (Sample, Option<u64>, usize) {
    let stat = parse_proc_stat(&std::fs::read_to_string("/proc/stat").unwrap_or_default());
    let pids = get_pid(process);
    let mut ticks: Option<u64> = None;
    let mut rss: Option<u64> = None;
    for pid in &pids {
        if let Some(t) = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().as_deref().and_then(parse_pid_stat) {
            ticks = Some(ticks.unwrap_or(0) + t);
        }
        if let Some(r) = std::fs::read_to_string(format!("/proc/{pid}/status")).ok().as_deref().and_then(parse_vm_rss) {
            rss = Some(rss.unwrap_or(0) + r);
        }
    }
    let net = parse_net_dev(&std::fs::read_to_string("/proc/net/dev").unwrap_or_default())
        .into_iter()
        .map(|(name, rx, tx)| (name, (rx, tx)))
        .collect();
    (
        Sample { at: Instant::now(), stat, process_ticks: ticks, process_name: process.to_string(), net },
        rss,
        pids.len(),
    )
}

#[derive(Serialize)]
struct NetRate {
    name: String,
    rx_bps: u64,
    tx_bps: u64,
}

fn collect(process: String) -> serde_json::Value {
    let previous = {
        let guard = PREVIOUS.lock().unwrap();
        guard.clone().filter(|p| p.process_name == process && p.at.elapsed() < Duration::from_secs(15))
    };
    // Первый запрос (или после паузы): короткий базовый снимок, чтобы сразу отдать значения.
    let previous = match previous {
        Some(p) if p.at.elapsed() >= Duration::from_millis(200) => p,
        _ => {
            let (baseline, _, _) = take_sample(&process);
            std::thread::sleep(Duration::from_millis(300));
            baseline
        }
    };
    let (current, rss, pid_count) = take_sample(&process);
    *PREVIOUS.lock().unwrap() = Some(current.clone());

    let elapsed = current.at.duration_since(previous.at).as_secs_f64().max(0.001);
    let cores_count = current.stat.cores.len().max(1);
    let d_total = current.stat.all.total.saturating_sub(previous.stat.all.total);
    let d_busy = current.stat.all.busy.saturating_sub(previous.stat.all.busy);

    let cores: Vec<f64> = current
        .stat
        .cores
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let p = previous.stat.cores.get(i).copied().unwrap_or_default();
            percent(c.busy.saturating_sub(p.busy), c.total.saturating_sub(p.total))
        })
        .collect();

    // Доля процесса от всей мощности CPU и от одного ядра (100% = ядро занято целиком).
    let process_cpu = match (current.process_ticks, previous.process_ticks) {
        (Some(c), Some(p)) if d_total > 0 => {
            let total = percent(c.saturating_sub(p), d_total);
            Some((total, ((total * cores_count as f64) * 10.0).round() / 10.0))
        }
        _ => None,
    };

    let mut net: Vec<NetRate> = current
        .net
        .iter()
        .filter_map(|(name, (rx, tx))| {
            let (prx, ptx) = previous.net.get(name)?;
            Some(NetRate {
                name: name.clone(),
                rx_bps: ((rx.saturating_sub(*prx) as f64 * 8.0) / elapsed) as u64,
                tx_bps: ((tx.saturating_sub(*ptx) as f64 * 8.0) / elapsed) as u64,
            })
        })
        .collect();
    net.sort_by(|a, b| (b.rx_bps + b.tx_bps).cmp(&(a.rx_bps + a.tx_bps)).then_with(|| a.name.cmp(&b.name)));

    json!({
        "success": true,
        "cpu": { "total": percent(d_busy, d_total), "cores": cores },
        "process": {
            "name": process,
            "running": pid_count > 0,
            "cpu_total": process_cpu.map(|p| p.0),
            "cpu_core": process_cpu.map(|p| p.1),
            "rss": rss,
        },
        "net": net,
        "interval_ms": (elapsed * 1000.0).round() as u64,
    })
}

pub async fn get_perf(State(state): State<AppState>) -> impl IntoResponse {
    let process = state.core.read().unwrap().name.clone();
    match tokio::task::spawn_blocking(move || collect(process)).await {
        Ok(value) => Json(value),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAT: &str = "cpu  100 0 50 800 50 0 0 0 0 0\n\
cpu0 60 0 30 400 10 0 0 0 0 0\n\
cpu1 40 0 20 400 40 0 0 0 0 0\n\
intr 12345 0 0\n\
ctxt 999\n";

    #[test]
    fn parses_proc_stat() {
        let stat = parse_proc_stat(STAT);
        assert_eq!(stat.all, CpuTimes { busy: 150, total: 1000 });
        assert_eq!(stat.cores, vec![CpuTimes { busy: 90, total: 500 }, CpuTimes { busy: 60, total: 500 }]);
    }

    #[test]
    fn parses_pid_stat_with_spaces_in_comm() {
        let line = "1234 (xray core) S 1 1234 1234 0 -1 4194560 2000 0 0 0 150 25 0 0 20 0 9 0 5000 123456789 4000 18446744073709551615";
        assert_eq!(parse_pid_stat(line), Some(175));
        assert_eq!(parse_pid_stat("garbage"), None);
    }

    #[test]
    fn parses_vm_rss() {
        let status = "Name:\txray\nVmPeak:\t  900000 kB\nVmRSS:\t   45678 kB\nThreads:\t9\n";
        assert_eq!(parse_vm_rss(status), Some(45678 * 1024));
        assert_eq!(parse_vm_rss("Name: x\n"), None);
    }

    #[test]
    fn parses_net_dev() {
        let dev = "Inter-|   Receive                                                |  Transmit\n \
face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    \
lo:  1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0\n   \
br0: 5000000  4000    0    0    0     0          0         0  9000000    7000    0    0    0     0       0          0\n";
        let parsed = parse_net_dev(dev);
        assert_eq!(parsed, vec![("lo".into(), 1000, 1000), ("br0".into(), 5_000_000, 9_000_000)]);
    }

    #[test]
    fn percent_rounding() {
        assert_eq!(percent(1, 3), 33.3);
        assert_eq!(percent(5, 0), 0.0);
    }
}
