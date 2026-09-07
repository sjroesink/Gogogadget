use super::Snapshot;
use std::{
    sync::{mpsc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
use windows::Win32::{
    Foundation::HWND,
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    },
    UI::{
        Accessibility::{
            CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
            IUIAutomationTextRange, TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start,
            UIA_IsReadOnlyAttributeId, UIA_TextPatternId,
        },
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
        },
        WindowsAndMessaging::{GetForegroundWindow, IsWindow, SetForegroundWindow},
    },
};
enum Request {
    Capture(Instant, oneshot::Sender<Result<Snapshot, String>>),
    Replace(String, String, Instant, oneshot::Sender<Result<(), String>>),
}
struct Target {
    token: String,
    window: HWND,
    element: IUIAutomationElement,
    range: IUIAutomationTextRange,
    text: String,
}
// UIA objects remain on this lazily started COM worker. No polling or clipboard access.
fn worker() -> &'static mpsc::SyncSender<Request> {
    static WORKER: OnceLock<mpsc::SyncSender<Request>> = OnceLock::new();
    WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || unsafe {
            let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).ok();
            let mut target = None;
            let mut sequence = 0u64;
            for request in rx {
                match request {
                    Request::Capture(deadline, reply) => {
                        target = None;
                        sequence += 1;
                        let result = initialized
                            .as_ref()
                            .map_err(|e| e.to_string())
                            .and_then(|_| capture_now(sequence.to_string(), deadline));
                        match result {
                            Ok((snapshot, next)) => {
                                if reply.send(Ok(snapshot)).is_ok() {
                                    target = next;
                                }
                            }
                            Err(error) => {
                                let _ = reply.send(Err(error));
                            }
                        }
                    }
                    Request::Replace(token, text, deadline, reply) => {
                        // Consume before input: a partial/uncertain insertion must never be retried.
                        let saved = target.take();
                        let result = saved
                            .filter(|t: &Target| t.token == token)
                            .ok_or_else(|| {
                                "This selection has expired. Select the text again with Ctrl+Alt+T."
                                    .to_string()
                            })
                            .and_then(|t| replace_now(&t, &text, deadline));
                        let _ = reply.send(result);
                    }
                }
            }
            drop(target);
            if initialized.is_ok() {
                CoUninitialize();
            }
        });
        tx
    })
}
pub async fn capture() -> Result<Snapshot, String> {
    let (tx, rx) = oneshot::channel();
    worker()
        .try_send(Request::Capture(
            Instant::now() + Duration::from_millis(1400),
            tx,
        ))
        .map_err(|_| "Selection capture is busy. Copy and paste your text here.".to_string())?;
    tokio::time::timeout(Duration::from_millis(1500), rx)
        .await
        .map_err(|_| "Selection capture timed out. Copy and paste your text here.".to_string())?
        .map_err(|_| "Selection worker stopped.".to_string())?
}
pub async fn replace(token: String, text: String) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    worker()
        .try_send(Request::Replace(
            token,
            text,
            Instant::now() + Duration::from_secs(3),
            tx,
        ))
        .map_err(|_| "Selection is busy. Select the text again.".to_string())?;
    // No external timeout that could report failure while input is still being sent.
    // The worker checks its deadline after UIA calls and before sending input.
    rx.await
        .map_err(|_| "Selection worker stopped.".to_string())?
}
unsafe fn capture_now(
    token: String,
    deadline: Instant,
) -> Result<(Snapshot, Option<Target>), String> {
    let read = || -> windows::core::Result<(Snapshot, Option<Target>)> {
        let window = GetForegroundWindow();
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let element = automation.GetFocusedElement()?;
        if element.CurrentIsPassword()?.as_bool()
            || element.CurrentProcessId()? == std::process::id() as i32
        {
            return Ok((Snapshot::default(), None));
        }
        let pattern: IUIAutomationTextPattern = element.GetCurrentPatternAs(UIA_TextPatternId)?;
        let ranges = pattern.GetSelection()?;
        let count = ranges.Length()?;
        if count > 32 {
            return Ok((
                Snapshot {
                    error: "Too many separate selections. Select one text range.".into(),
                    ..Default::default()
                },
                None,
            ));
        }
        let mut text = String::new();
        for i in 0..count {
            let remaining = 100_001usize.saturating_sub(text.encode_utf16().count());
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
        if window != GetForegroundWindow()
            || !element.CurrentHasKeyboardFocus()?.as_bool()
            || Instant::now() > deadline
        {
            return Ok((Snapshot::default(), None));
        }
        let target = if count == 1 && !text.trim().is_empty() {
            Some(Target {
                token: token.clone(),
                window,
                element,
                range: ranges.GetElement(0)?.Clone()?,
                text: text.clone(),
            })
        } else {
            None
        };
        Ok((
            Snapshot {
                text,
                error: String::new(),
                token: target.as_ref().map(|t| t.token.clone()),
            },
            target,
        ))
    };
    let (snapshot, target) = read().map_err(|_| {
        "This field does not expose a selection. Copy and paste your text here.".to_string()
    })?;
    if !snapshot.error.is_empty() {
        return Err(snapshot.error);
    }
    if snapshot.text.encode_utf16().count() > 100_000 {
        return Err("Selection is too large (maximum 100,000 characters).".into());
    }
    if snapshot.text.trim().is_empty() {
        return Err("No selected text found. Select text first, or paste it here.".into());
    }
    Ok((snapshot, target))
}
unsafe fn replace_now(target: &Target, text: &str, deadline: Instant) -> Result<(), String> {
    let inspect = || -> windows::core::Result<bool> {
        if !IsWindow(Some(target.window)).as_bool()
            || target.element.CurrentIsPassword()?.as_bool()
            || !target.element.CurrentIsEnabled()?.as_bool()
        {
            return Ok(false);
        }
        // Unknown/read-only ranges fail closed, including terminal output.
        let read_only = target.range.GetAttributeValue(UIA_IsReadOnlyAttributeId)?;
        if bool::try_from(&read_only).unwrap_or(true) {
            return Ok(false);
        }
        if Instant::now() > deadline || !SetForegroundWindow(target.window).as_bool() {
            return Ok(false);
        }
        target.element.SetFocus()?;
        let pattern: IUIAutomationTextPattern =
            target.element.GetCurrentPatternAs(UIA_TextPatternId)?;
        let ranges = pattern.GetSelection()?;
        if ranges.Length()? != 1 {
            return Ok(false);
        }
        let current = ranges.GetElement(0)?;
        Ok(current.GetText(100_001)? == target.text
            && current.CompareEndpoints(
                TextPatternRangeEndpoint_Start,
                &target.range,
                TextPatternRangeEndpoint_Start,
            )? == 0
            && current.CompareEndpoints(
                TextPatternRangeEndpoint_End,
                &target.range,
                TextPatternRangeEndpoint_End,
            )? == 0
            && target.element.CurrentHasKeyboardFocus()?.as_bool())
    };
    if !inspect().map_err(|_| "The original text field is no longer available.".to_string())? {
        return Err("The selection changed or the field is not editable. Select the text again, or use Copy response.".into());
    }
    let normalized = text.replace("\r\n", "\n").replace('\n', "\r");
    let mut inputs = Vec::with_capacity(normalized.len() * 2);
    for ch in normalized.encode_utf16() {
        for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wScan: ch,
                        dwFlags: flags,
                        ..Default::default()
                    },
                },
            });
        }
    }
    if Instant::now() > deadline
        || GetForegroundWindow() != target.window
        || !target
            .element
            .CurrentHasKeyboardFocus()
            .map_err(|_| "The original field lost focus.".to_string())?
            .as_bool()
    {
        return Err("The original window lost focus. Select the text again.".into());
    }
    if [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        .iter()
        .any(|key| GetAsyncKeyState(key.0 as i32) < 0)
    {
        return Err("Release modifier keys and select the text again.".into());
    }
    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    if sent != inputs.len() as u32 {
        return Err("Windows did not accept the full replacement. Check the original field before trying again.".into());
    }
    Ok(())
}
