use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
#[cfg(windows)]
#[path = "selection_windows.rs"]
mod native;
static BUSY: AtomicBool = AtomicBool::new(false);
#[derive(Clone, Default, serde::Serialize)]
pub struct Snapshot {
    text: String,
    error: String,
    token: Option<String>,
}
struct Busy;
impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}
pub fn open(app: tauri::AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _busy = Busy;
        let snapshot = match native::capture().await {
            Ok(snapshot) => snapshot,
            Err(error) => Snapshot {
                error,
                ..Default::default()
            },
        };
        crate::show(&app);
        let _ = app.emit("launcher:selection", snapshot);
    });
}
#[tauri::command]
pub async fn replace_selection(
    app: tauri::AppHandle,
    token: String,
    text: String,
) -> Result<(), String> {
    validate_replacement(&text)?;
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("Selection is busy. Please try again.".into());
    }
    let _busy = Busy;
    #[cfg(windows)]
    let owner = app
        .get_webview_window("main")
        .ok_or("Launcher window is unavailable")?
        .hwnd()
        .map_err(|e| e.to_string())?
        .0 as usize;
    #[cfg(not(windows))]
    let owner = 0;
    let result = native::replace(token, text, owner).await;
    if result.is_ok() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    } else {
        crate::show(&app);
    }
    result
}
fn validate_replacement(text: &str) -> Result<(), String> {
    if text.is_empty() || text.encode_utf16().count() > 100_000 {
        return Err("Replacement must contain 1–100,000 characters.".into());
    }
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(
            "The response contains unsupported control characters. Use Copy response instead."
                .into(),
        );
    }
    Ok(())
}
#[cfg(not(windows))]
mod native {
    use super::Snapshot;
    pub async fn capture() -> Result<Snapshot, String> {
        Err("Selection capture is currently available on Windows. Paste your text here.".into())
    }
    pub async fn replace(_: String, _: String, _: usize) -> Result<(), String> {
        Err("Replacing selections is currently available on Windows.".into())
    }
}
#[cfg(test)]
mod tests {
    use super::validate_replacement;
    #[test]
    fn validates_replacement_input() {
        assert!(validate_replacement("hé🙂\r\n\tcode").is_ok());
        assert!(validate_replacement("").is_err());
        assert!(validate_replacement("x\u{1b}y").is_err());
        assert!(validate_replacement(&"🙂".repeat(50_001)).is_err());
    }
}
