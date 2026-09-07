use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

static CAPTURING: AtomicBool = AtomicBool::new(false);

/// Only the explicit selection shortcut reads another application's selection.
pub fn open(app: tauri::AppHandle) {
    if CAPTURING.swap(true, Ordering::SeqCst) {
        crate::show(&app);
        let _ = app.emit("launcher:selection", serde_json::json!({"text":"","error":"Selection capture is still busy. Copy your selection and paste it here."}));
        return;
    }
    tauri::async_runtime::spawn(async move {
        let task = tauri::async_runtime::spawn_blocking(|| {
            struct Reset;
            impl Drop for Reset {
                fn drop(&mut self) {
                    CAPTURING.store(false, Ordering::SeqCst);
                }
            }
            let _reset = Reset;
            capture()
        });
        let result = tokio::time::timeout(std::time::Duration::from_millis(1500), task).await;
        let (text, error) = match result {
            Ok(Ok(Ok(text))) => (text, String::new()),
            Ok(Ok(Err(error))) => (String::new(), error),
            _ => (
                String::new(),
                "Selection capture timed out. Copy your selection and paste it here.".into(),
            ),
        };
        crate::show(&app);
        let _ = app.emit(
            "launcher:selection",
            serde_json::json!({"text":text,"error":error}),
        );
    });
}

#[cfg(windows)]
fn capture() -> Result<String, String> {
    use windows::Win32::{
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
            },
            WindowsAndMessaging::GetForegroundWindow,
        },
    };
    let read = || -> windows::core::Result<String> {
        // This dedicated worker owns all COM objects; none cross a thread boundary.
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            struct Com;
            impl Drop for Com {
                fn drop(&mut self) {
                    unsafe { CoUninitialize() }
                }
            }
            let _com = Com;
            let foreground = GetForegroundWindow();
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let element = automation.GetFocusedElement()?;
            if element.CurrentIsPassword()?.as_bool()
                || element.CurrentProcessId()? == std::process::id() as i32
            {
                return Ok(String::new());
            }
            let pattern: IUIAutomationTextPattern =
                element.GetCurrentPatternAs(UIA_TextPatternId)?;
            let ranges = pattern.GetSelection()?;
            if ranges.Length()? > 32 {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x80070057u32 as i32,
                )));
            }
            let mut text = String::new();
            for i in 0..ranges.Length()? {
                let remaining = 100_001usize.saturating_sub(text.chars().count());
                if remaining == 0 {
                    break;
                }
                let part = ranges.GetElement(i)?.GetText(remaining as i32)?.to_string();
                if !part.is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(&part);
                }
            }
            if foreground != GetForegroundWindow() || !element.CurrentHasKeyboardFocus()?.as_bool()
            {
                return Ok(String::new());
            }
            Ok(text)
        }
    };
    let text = read().map_err(|_| {
        "This text field does not expose a selection. Copy your selection and paste it here."
            .to_string()
    })?;
    if text.chars().count() > 100_000 {
        return Err("Selection is too large (maximum 100,000 characters).".into());
    }
    if text.trim().is_empty() {
        return Err("No selected text found. Select text first, or paste it here.".into());
    }
    Ok(text)
}

#[cfg(not(windows))]
fn capture() -> Result<String, String> {
    Err("Selection capture is currently available on Windows. Paste your text here.".into())
}
