use crate::process::WireEvent;
use futures_util::StreamExt;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::ipc::Channel;
use tokio::sync::{oneshot, Mutex};

#[derive(Clone)]
pub struct Http {
    client: reqwest::Client,
    requests: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}
impl Default for Http {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(300))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
            requests: Default::default(),
        }
    }
}
fn endpoint(base: &str, path: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("Use HTTPS or a local HTTP endpoint.".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Endpoint must not contain credentials, a query or a fragment.".into());
    }
    if !matches!(path, "/api/tags" | "/api/chat") {
        return Err("Unsupported endpoint".into());
    }
    Ok(format!("{}{path}", base.trim_end_matches('/')))
}
#[tauri::command]
pub async fn http_request(
    state: tauri::State<'_, Http>,
    id: String,
    base: String,
    path: String,
    body: Option<Value>,
    events: Channel<WireEvent>,
) -> Result<(), String> {
    let url = endpoint(&base, &path)?;
    let (tx, rx) = oneshot::channel();
    {
        let mut requests = state.requests.lock().await;
        if requests.len() >= 8 || requests.contains_key(&id) {
            return Err("Too many active requests".into());
        }
        requests.insert(id.clone(), tx);
    }
    let request = if let Some(body) = body {
        state.client.post(url).json(&body)
    } else {
        state.client.get(url)
    };
    let work = async {
        events
            .send(WireEvent::Ready(()))
            .map_err(|e| e.to_string())?;
        let response = request
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            buffer.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
            if buffer.len() > 4 * 1024 * 1024 {
                return Err("Response too large".to_string());
            }
            while let Some(at) = buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buffer.drain(..=at).collect();
                let text = String::from_utf8(line).map_err(|e| e.to_string())?;
                if !text.trim().is_empty() {
                    events
                        .send(WireEvent::Line(text))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        if !buffer.is_empty() {
            events
                .send(WireEvent::Line(
                    String::from_utf8(buffer).map_err(|e| e.to_string())?,
                ))
                .map_err(|e| e.to_string())?;
        }
        events
            .send(WireEvent::Done(()))
            .map_err(|e| e.to_string())?;
        Ok(())
    };
    let result = tokio::select! { result = work => result, _ = rx => Err("Cancelled".to_string()) };
    state.requests.lock().await.remove(&id);
    result
}
#[tauri::command]
pub async fn http_cancel(state: tauri::State<'_, Http>, id: String) -> Result<(), String> {
    if let Some(tx) = state.requests.lock().await.remove(&id) {
        let _ = tx.send(());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_endpoints() {
        assert!(endpoint("http://127.0.0.1:11434", "/api/chat").is_ok());
        assert!(endpoint("http://remote.example", "/api/chat").is_err());
        assert!(endpoint("file:///secret", "/api/tags").is_err());
        assert!(endpoint("https://example.com?x=1", "/api/tags").is_err());
    }
}
