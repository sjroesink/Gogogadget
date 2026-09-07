use super::Snapshot;
use std::{
    sync::{mpsc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
use windows::Win32::{
    Foundation::{GlobalFree, HANDLE, HWND},
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    },
    System::{
        DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard,
            SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
    },
    UI::{
        Accessibility::{
            CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
            IUIAutomationTextRange, TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start,
            UIA_IsReadOnlyAttributeId, UIA_TextPatternId,
        },
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYEVENTF_KEYUP, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_V,
        },
        WindowsAndMessaging::{GetForegroundWindow, IsWindow, SetForegroundWindow},
    },
};
enum Request {
    Capture(Instant, oneshot::Sender<Result<Snapshot, String>>),
    Replace(
        String,
        String,
        usize,
        Instant,
        oneshot::Sender<Result<(), String>>,
    ),
}
struct Target {
    token: String,
    window: HWND,
    element: IUIAutomationElement,
    range: IUIAutomationTextRange,
    text: String,
}
// UIA objects remain on this lazily started COM worker. No polling. Clipboard writes happen only on explicit replacement.
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
                    Request::Replace(token, text, owner, deadline, reply) => {
                        // Consume before input: a partial/uncertain insertion must never be retried.
                        let saved = target.take();
                        let result = saved
                            .filter(|t: &Target| t.token == token)
                            .ok_or_else(|| {
                                "This selection has expired. Select the text again with Ctrl+Alt+T."
                                    .to_string()
                            })
                            .and_then(|t| replace_now(&t, &text, HWND(owner as *mut _), deadline));
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
pub async fn replace(token: String, text: String, owner: usize) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    worker()
        .try_send(Request::Replace(
            token,
            text,
            owner,
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
unsafe fn replace_now(
    target: &Target,
    text: &str,
    owner: HWND,
    deadline: Instant,
) -> Result<(), String> {
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
    let inputs = paste_inputs();
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
    let clipboard_sequence = write_clipboard(owner, text)
        .map_err(|e| format!("Could not prepare the clipboard: {e}"))?;
    if Instant::now() > deadline
        || GetForegroundWindow() != target.window
        || !target
            .element
            .CurrentHasKeyboardFocus()
            .map_err(|e| e.to_string())?
            .as_bool()
        || GetClipboardSequenceNumber() != clipboard_sequence
    {
        return Err(
            "Focus or clipboard changed. The response is on the clipboard; paste it manually."
                .into(),
        );
    }
    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    if sent != inputs.len() as u32 {
        // A partial shortcut must not leave Ctrl or V held down.
        let _ = SendInput(&inputs[2..], std::mem::size_of::<INPUT>() as i32);
        return Err("Windows did not accept the full replacement. Check the original field before trying again.".into());
    }
    Ok(())
}

// One paste command, independent of response length. No per-character VK_PACKET events.
fn paste_inputs() -> [INPUT; 4] {
    [
        (VK_CONTROL, false),
        (VK_V, false),
        (VK_V, true),
        (VK_CONTROL, true),
    ]
    .map(|(key, up)| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                ..Default::default()
            },
        },
    })
}
fn clipboard_text(text: &str) -> Vec<u16> {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n")
        .encode_utf16()
        .chain(Some(0))
        .collect()
}
unsafe fn write_clipboard(owner: HWND, text: &str) -> windows::core::Result<u32> {
    let text = clipboard_text(text);
    let memory = GlobalAlloc(GMEM_MOVEABLE, text.len() * 2)?;
    let result = (|| {
        let pointer = GlobalLock(memory);
        if pointer.is_null() {
            return Err(windows::core::Error::from_win32());
        }
        std::ptr::copy_nonoverlapping(text.as_ptr(), pointer.cast::<u16>(), text.len());
        let _ = GlobalUnlock(memory);
        OpenClipboard(Some(owner))?;
        struct Clipboard;
        impl Drop for Clipboard {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseClipboard();
                }
            }
        }
        let _clipboard = Clipboard;
        EmptyClipboard()?;
        SetClipboardData(13, Some(HANDLE(memory.0)))?; // CF_UNICODETEXT; ownership transfers to Windows.
        Ok(())
    })();
    if result.is_err() {
        let _ = GlobalFree(Some(memory));
    }
    result.map(|_| GetClipboardSequenceNumber())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "native clipboard integration; writes synthetic test text to the clipboard"]
    fn native_clipboard_paste_replaces_selected_text_exactly() {
        use windows::{
            core::w,
            Win32::{
                Foundation::{LPARAM, WPARAM},
                UI::WindowsAndMessaging::*,
            },
        };
        unsafe {
            let owner = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("Gogogadget paste test"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
            .unwrap();
            struct Window(HWND);
            impl Drop for Window {
                fn drop(&mut self) {
                    unsafe {
                        let _ = DestroyWindow(self.0);
                    }
                }
            }
            let _owner = Window(owner);
            let edit = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("EDIT"),
                w!("before ORIGINAL after"),
                WS_CHILD | WINDOW_STYLE(0x0004),
                0,
                0,
                500,
                100,
                Some(owner),
                None,
                None,
                None,
            )
            .unwrap(); // ES_MULTILINE
            let _edit = Window(edit);
            let text = "Hey, dit is een test. hé🙂\n\tconst answer = 42;";
            let sequence = write_clipboard(owner, text).unwrap();
            assert_eq!(sequence, GetClipboardSequenceNumber());
            SendMessageW(edit, 0x00b1, Some(WPARAM(7)), Some(LPARAM(15))); // EM_SETSEL: ORIGINAL
            SendMessageW(edit, WM_PASTE, None, None);
            let mut result = vec![0u16; GetWindowTextLengthW(edit) as usize + 1];
            let length = GetWindowTextW(edit, &mut result) as usize;
            assert_eq!(
                String::from_utf16(&result[..length]).unwrap(),
                "before Hey, dit is een test. hé🙂\r\n\tconst answer = 42; after"
            );
        }
    }
    #[test]
    fn paste_uses_one_shortcut_instead_of_character_events() {
        let inputs = paste_inputs();
        assert_eq!(inputs.len(), 4);
        unsafe {
            assert_eq!(inputs[0].Anonymous.ki.wVk, VK_CONTROL);
            assert_eq!(inputs[1].Anonymous.ki.wVk, VK_V);
            assert_eq!(inputs[2].Anonymous.ki.dwFlags, KEYEVENTF_KEYUP);
            assert_eq!(inputs[3].Anonymous.ki.wVk, VK_CONTROL);
            assert_eq!(inputs[3].Anonymous.ki.dwFlags, KEYEVENTF_KEYUP);
            assert!(inputs.iter().all(|i| i.Anonymous.ki.wScan == 0));
        }
    }
    #[test]
    fn clipboard_keeps_full_unicode_text_tabs_and_line_breaks() {
        let text = "Hey, dit is een test. hé🙂\n\tcode\r\nnext";
        let wide = clipboard_text(text);
        assert_eq!(wide.last(), Some(&0));
        assert_eq!(
            String::from_utf16(&wide[..wide.len() - 1]).unwrap(),
            "Hey, dit is een test. hé🙂\r\n\tcode\r\nnext"
        );
    }
}
