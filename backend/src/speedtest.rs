//! Ручной спидтест (`POST /api/speedtest`): скачивание тестового файла роутером
//! напрямую или через выбранный outbound Xray.
//!
//! - `direct`: reqwest качает URL с самого роутера (собственный трафик роутера в политику
//!   XKeen не попадает, т.е. это скорость канала без прокси).
//! - `proxy`: как в пинге аутбаундов (healthchecker.rs) поднимается одноразовый
//!   `xray -c '@сокет'` только с присланным outbound и tunnel-инбаундом на абстрактном
//!   unix-сокете; скачивание идёт через него, т.е. замер включает шифрование на CPU роутера.
//!
//! Тест ограничен по времени, одновременно выполняется только один.

use crate::healthchecker::{
    AbortOnDrop, STARTUP_TIMEOUT, TLS_CONFIG, parse_status, read_headers, serve_config, start_xray, wait_xray_ready,
};
use crate::logger::log;
use crate::types::AppState;
use axum::extract::{Json, State};
use axum::response::IntoResponse;
use futures_util::StreamExt;
use reqwest::Url;
use serde::Deserialize;
use serde_json::json;
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tokio_rustls::TlsConnector;

pub const DEFAULT_URL: &str = "https://speed.cloudflare.com/__down?bytes=25000000";
const DEFAULT_SECONDS: u64 = 10;
const MIN_SECONDS: u64 = 3;
const MAX_SECONDS: u64 = 20;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

static SPEEDTEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Deserialize)]
pub struct SpeedtestReq {
    pub mode: String,
    #[serde(default)]
    pub outbound: Option<serde_json::Value>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Measurement {
    pub bytes: u64,
    /// Время скачивания тела (от первого байта ответа до конца/лимита).
    pub elapsed: Duration,
    /// Время до первого байта ответа (подключение + рукопожатия + запрос).
    pub ttfb: Duration,
}

pub fn mbps(bytes: u64, elapsed: Duration) -> f64 {
    let secs = elapsed.as_secs_f64();
    if secs <= 0.0 {
        return 0.0;
    }
    ((bytes as f64 * 8.0 / secs / 1_000_000.0) * 10.0).round() / 10.0
}

fn parse_url(url: Option<&str>) -> Result<Url, String> {
    let raw = url.map(str::trim).filter(|u| !u.is_empty()).unwrap_or(DEFAULT_URL);
    let parsed = Url::parse(raw).map_err(|e| format!("Некорректный URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("URL должен быть http(s) с хостом".into());
    }
    Ok(parsed)
}

pub async fn post_speedtest(State(state): State<AppState>, Json(req): Json<SpeedtestReq>) -> impl IntoResponse {
    let Ok(_guard) = SPEEDTEST_LOCK.try_lock() else {
        return Json(json!({ "success": false, "error": "Тест уже выполняется — дождитесь окончания" }));
    };
    let url = match parse_url(req.url.as_deref()) {
        Ok(u) => u,
        Err(e) => return Json(json!({ "success": false, "error": e })),
    };
    let limit = Duration::from_secs(req.seconds.unwrap_or(DEFAULT_SECONDS).clamp(MIN_SECONDS, MAX_SECONDS));

    let result = match req.mode.as_str() {
        "direct" => measure_direct(&state, &url, limit).await,
        "proxy" => match req.outbound.as_ref().filter(|o| o.is_object()) {
            Some(outbound) => measure_proxy(outbound, &url, limit).await,
            None => Err("Не выбран outbound для теста через прокси".into()),
        },
        _ => Err("Неизвестный режим теста".into()),
    };

    match result {
        Ok(m) => {
            let speed = mbps(m.bytes, m.elapsed);
            log("INFO", format!("Спидтест ({}): {speed} Мбит/с, {} байт за {:.1} с", req.mode, m.bytes, m.elapsed.as_secs_f64()));
            Json(json!({
                "success": true,
                "mode": req.mode,
                "mbps": speed,
                "bytes": m.bytes,
                "seconds": (m.elapsed.as_secs_f64() * 10.0).round() / 10.0,
                "ttfb_ms": m.ttfb.as_millis() as u64,
            }))
        }
        Err(e) => {
            log("WARN", format!("Спидтест ({}) не удался: {e}", req.mode));
            Json(json!({ "success": false, "error": e }))
        }
    }
}

async fn measure_direct(state: &AppState, url: &Url, limit: Duration) -> Result<Measurement, String> {
    let started = Instant::now();
    let response = tokio::time::timeout(
        CONNECT_TIMEOUT,
        state
            .http_client
            .get(url.clone())
            .header("Accept-Encoding", "identity")
            .timeout(limit + CONNECT_TIMEOUT)
            .send(),
    )
    .await
    .map_err(|_| "Сервер не ответил за 10 с".to_string())?
    .map_err(|e| format!("Ошибка запроса: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Сервер вернул HTTP {}", response.status().as_u16()));
    }
    let ttfb = started.elapsed();
    let body_started = Instant::now();
    let deadline = body_started + limit;
    let mut stream = response.bytes_stream();
    let mut bytes = 0u64;
    loop {
        match tokio::time::timeout_at(deadline.into(), stream.next()).await {
            Err(_) | Ok(None) => break,
            Ok(Some(Ok(chunk))) => bytes += chunk.len() as u64,
            Ok(Some(Err(e))) => {
                if bytes == 0 {
                    return Err(format!("Ошибка загрузки: {e}"));
                }
                break;
            }
        }
    }
    Ok(Measurement { bytes, elapsed: body_started.elapsed(), ttfb })
}

async fn measure_proxy(outbound: &serde_json::Value, url: &Url, limit: Duration) -> Result<Measurement, String> {
    let host = url.host_str().ok_or("В URL нет хоста")?.trim_matches(['[', ']']).to_string();
    let port = url.port_or_known_default().unwrap_or(80);
    let base = format!(
        "speedtest-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default()
    );
    let config_socket = format!("{base}-cfg");
    let socket_name = format!("{base}-px");

    let mut outbound = outbound.clone();
    outbound["tag"] = json!("speedtest-out");
    let config = serde_json::to_vec(&json!({
        "log": { "access": "none", "loglevel": "warning" },
        "inbounds": [{
            "protocol": "tunnel",
            "listen": format!("@{socket_name}"),
            "settings": { "rewriteAddress": host, "rewritePort": port }
        }],
        "outbounds": [outbound]
    }))
    .map_err(|e| e.to_string())?;

    let startup_deadline = Instant::now() + STARTUP_TIMEOUT;
    let listener =
        UnixListener::bind(format!("\0{config_socket}")).map_err(|e| format!("Не удалось открыть сокет выдачи конфига: {e}"))?;
    let _config_task = AbortOnDrop(tokio::spawn(serve_config(listener, config, startup_deadline)));

    let (mut child, ready, output_task) = start_xray(&config_socket).await?;
    let result = match wait_xray_ready(&mut child, startup_deadline, ready, output_task).await {
        Ok(()) => download_via_socket(&socket_name, url, &host, limit).await,
        Err(e) => Err(e),
    };
    _ = child.kill().await;
    _ = child.wait().await;
    result
}

async fn download_via_socket(socket_name: &str, url: &Url, host: &str, limit: Duration) -> Result<Measurement, String> {
    let started = Instant::now();
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, UnixStream::connect(format!("\0{socket_name}")))
        .await
        .map_err(|_| "Таймаут подключения к Xray".to_string())?
        .map_err(|e| format!("Не удалось подключиться к сокету Xray: {e}"))?;
    let request = build_request(url);
    if url.scheme() == "https" {
        let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
            .map_err(|e| format!("Некорректный хост для TLS: {e}"))?;
        let tls = tokio::time::timeout(CONNECT_TIMEOUT, TlsConnector::from(TLS_CONFIG.clone()).connect(server_name, stream))
            .await
            .map_err(|_| "Таймаут TLS-рукопожатия через прокси".to_string())?
            .map_err(|e| format!("TLS-рукопожатие через прокси не удалось: {e}"))?;
        download(tls, &request, started, limit).await
    } else {
        download(stream, &request, started, limit).await
    }
}

pub fn build_request(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    let host_header = url.port().map_or_else(|| host.to_string(), |port| format!("{host}:{port}"));
    let mut path = url.path().to_string();
    if let Some(query) = url.query() {
        path = format!("{path}?{query}");
    }
    format!(
        "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: XKeen-UI\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
    )
}

/// Длина тела, уже прочитанного вместе с заголовками.
pub fn body_after_headers(buffer: &[u8]) -> usize {
    buffer
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map_or(0, |pos| buffer.len() - pos - 4)
}

async fn download<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S, request: &str, started: Instant, limit: Duration,
) -> Result<Measurement, String> {
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("Не удалось отправить запрос: {e}"))?;
    let headers = tokio::time::timeout(CONNECT_TIMEOUT, read_headers(&mut stream))
        .await
        .map_err(|_| "Сервер не ответил за 10 с".to_string())??;
    let status = parse_status(&headers)?;
    if !(200..300).contains(&status) {
        return Err(format!("Сервер вернул HTTP {status}"));
    }
    let ttfb = started.elapsed();
    let body_started = Instant::now();
    let deadline = body_started + limit;
    let mut bytes = body_after_headers(&headers) as u64;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match tokio::time::timeout_at(deadline.into(), stream.read(&mut buffer)).await {
            Err(_) | Ok(Ok(0)) => break,
            Ok(Ok(n)) => bytes += n as u64,
            Ok(Err(e)) => {
                if bytes == 0 {
                    return Err(format!("Ошибка загрузки: {e}"));
                }
                break;
            }
        }
    }
    Ok(Measurement { bytes, elapsed: body_started.elapsed(), ttfb })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_mbps() {
        assert_eq!(mbps(12_500_000, Duration::from_secs(1)), 100.0);
        assert_eq!(mbps(1, Duration::ZERO), 0.0);
    }

    #[test]
    fn validates_url() {
        assert_eq!(parse_url(None).unwrap().as_str(), DEFAULT_URL);
        assert!(parse_url(Some("ftp://x")).is_err());
        assert!(parse_url(Some("not a url")).is_err());
        assert_eq!(parse_url(Some(" http://example.com/f ")).unwrap().host_str(), Some("example.com"));
    }

    #[test]
    fn builds_request() {
        let url = Url::parse("https://speed.cloudflare.com/__down?bytes=100").unwrap();
        assert_eq!(
            build_request(&url),
            "GET /__down?bytes=100 HTTP/1.1\r\nHost: speed.cloudflare.com\r\nUser-Agent: XKeen-UI\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
        );
        let url = Url::parse("http://10.0.0.1:8080/file").unwrap();
        assert!(build_request(&url).contains("Host: 10.0.0.1:8080\r\n"));
    }

    #[test]
    fn counts_body_after_headers() {
        assert_eq!(body_after_headers(b"HTTP/1.1 200 OK\r\nA: b\r\n\r\nhello"), 5);
        assert_eq!(body_after_headers(b"HTTP/1.1 200 OK\r\n\r\n"), 0);
        assert_eq!(body_after_headers(b"partial"), 0);
    }

    #[tokio::test]
    async fn downloads_over_plain_stream() {
        let (client, mut server) = tokio::io::duplex(1 << 16);
        let server_task = tokio::spawn(async move {
            let mut buf = vec![0u8; 1024];
            let _ = server.read(&mut buf).await;
            server.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789").await.unwrap();
            server.shutdown().await.unwrap();
        });
        let m = download(client, "GET / HTTP/1.1\r\n\r\n", Instant::now(), Duration::from_secs(3)).await.unwrap();
        assert_eq!(m.bytes, 10);
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_non_2xx() {
        let (client, mut server) = tokio::io::duplex(1 << 16);
        tokio::spawn(async move {
            let mut buf = vec![0u8; 1024];
            let _ = server.read(&mut buf).await;
            let _ = server.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n").await;
        });
        let err = download(client, "GET / HTTP/1.1\r\n\r\n", Instant::now(), Duration::from_secs(3)).await.unwrap_err();
        assert!(err.contains("403"));
    }
}
