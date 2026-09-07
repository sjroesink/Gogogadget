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
            IUIAutomationTextRange, IUIAutomationValuePattern, TextPatternRangeEndpoint_End,
            TextPatternRangeEndpoint_Start, UIA_IsReadOnlyAttributeId, UIA_TextPatternId,
            UIA_ValuePatternId,
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
            || (!cfg!(test) && element.CurrentProcessId()? == std::process::id() as i32)
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
    let available = target
        .element
        .CurrentIsEnabled()
        .map_err(|e| format!("The original field is unavailable: {e}"))?
        .as_bool();
    if !IsWindow(Some(target.window)).as_bool() || !available {
        return Err("The original window is closed or its text field is disabled.".into());
    }
    if target
        .element
        .CurrentIsPassword()
        .map_err(|e| e.to_string())?
        .as_bool()
    {
        return Err("Password fields cannot be replaced.".into());
    }
    // Foreground activation crosses input queues and is asynchronous. Do not
    // interpret its immediate return value as proof that focus has settled.
    let _ = SetForegroundWindow(target.window);
    wait_until(deadline, || Ok(GetForegroundWindow() == target.window)).map_err(|_| {
        "Windows could not activate the original window. Open it and select the text again."
            .to_string()
    })?;
    // Allow the source app to restore its own focused control before requesting
    // UIA SetFocus, which can collapse selections in some editors.
    let focus_deadline = deadline.min(Instant::now() + Duration::from_millis(250));
    if wait_until(focus_deadline, || {
        target
            .element
            .CurrentHasKeyboardFocus()
            .map(|v| v.as_bool())
            .map_err(|e| e.to_string())
    })
    .is_err()
    {
        target
            .element
            .SetFocus()
            .map_err(|e| format!("Could not focus the original text field: {e}"))?;
        wait_until(deadline, || {
            target
                .element
                .CurrentHasKeyboardFocus()
                .map(|v| v.as_bool())
                .map_err(|e| e.to_string())
        })
        .map_err(|_| "The original text field did not regain keyboard focus.".to_string())?;
    }
    let pattern: IUIAutomationTextPattern =
        target
            .element
            .GetCurrentPatternAs(UIA_TextPatternId)
            .map_err(|e| format!("The original selection is unavailable: {e}"))?;
    let ranges = pattern.GetSelection().map_err(|e| e.to_string())?;
    if ranges.Length().map_err(|e| e.to_string())? != 1 {
        return Err("The original field no longer has exactly one selection.".into());
    }
    let current = ranges.GetElement(0).map_err(|e| e.to_string())?;
    let readonly = current
        .GetAttributeValue(UIA_IsReadOnlyAttributeId)
        .ok()
        .and_then(|v| bool::try_from(&v).ok())
        .or_else(|| {
            target
                .element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .ok()
                .and_then(|p| p.CurrentIsReadOnly().ok())
                .map(|v| v.as_bool())
        });
    match readonly {
        Some(false) => {}
        Some(true) => return Err("The original text field reports that it is read-only.".into()),
        None => {
            return Err(
                "This editor does not report whether its selection is editable. Use Copy response."
                    .into(),
            )
        }
    }
    if current.GetText(100_001).map_err(|e| e.to_string())? != target.text {
        return Err(
            "The selected text changed after the action started. Select it again with Ctrl+Alt+T."
                .into(),
        );
    }
    for endpoint in [TextPatternRangeEndpoint_Start, TextPatternRangeEndpoint_End] {
        if current
            .CompareEndpoints(endpoint, &target.range, endpoint)
            .map_err(|e| format!("The saved selection expired: {e}"))?
            != 0
        {
            return Err(
                "The selection moved to a different position. Select it again with Ctrl+Alt+T."
                    .into(),
            );
        }
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

fn wait_until(
    deadline: Instant,
    mut ready: impl FnMut() -> Result<bool, String>,
) -> Result<(), String> {
    loop {
        if Instant::now() >= deadline {
            return Err("Focus transition timed out".into());
        }
        if ready()? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "interactive focus/paste integration using two synthetic windows; changes clipboard"]
    async fn native_focus_restore_and_paste_roundtrip() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        use windows::{
            core::w,
            Win32::{
                Foundation::{LPARAM, WPARAM},
                UI::{Input::KeyboardAndMouse::SetFocus, WindowsAndMessaging::*},
            },
        };
        let done = Arc::new(AtomicBool::new(false));
        let stop = done.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let fixture = std::thread::spawn(move || unsafe {
            let _library =
                windows::Win32::System::LibraryLoader::LoadLibraryW(w!("Msftedit.dll")).unwrap();
            let source = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("Gogogadget source test"),
                WS_OVERLAPPEDWINDOW,
                40,
                40,
                500,
                200,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let edit = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("RICHEDIT50W"),
                w!("before ORIGINAL after"),
                WS_CHILD | WS_VISIBLE | WINDOW_STYLE(4),
                0,
                0,
                450,
                120,
                Some(source),
                None,
                None,
                None,
            )
            .unwrap();
            let launcher = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("Gogogadget launcher test"),
                WS_OVERLAPPEDWINDOW,
                600,
                40,
                300,
                150,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let _ = ShowWindow(source, SW_SHOW);
            let _ = SetForegroundWindow(source);
            let _ = SetFocus(Some(edit));
            SendMessageW(edit, 0x00b1, Some(WPARAM(7)), Some(LPARAM(15)));
            tx.send((source.0 as usize, edit.0 as usize, launcher.0 as usize))
                .unwrap();
            let mut msg = MSG::default();
            while !stop.load(Ordering::SeqCst) {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let _ = DestroyWindow(launcher);
            let _ = DestroyWindow(source);
        });
        let (source, edit, launcher) = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let result = async {
            unsafe {
                let _ = SetForegroundWindow(HWND(source as *mut _));
            }
            wait_until(Instant::now() + Duration::from_secs(1), || {
                Ok(unsafe { GetForegroundWindow() }.0 as usize == source)
            })
            .map_err(|_| "Test setup could not activate its source window".to_string())?;
            tokio::time::sleep(Duration::from_millis(200)).await;
            let selection = capture()
                .await
                .map_err(|e| format!("Initial test capture: {e}"))?;
            if selection.text != "ORIGINAL" {
                return Err(format!("Wrong test selection: {:?}", selection.text));
            }
            unsafe {
                let _ = ShowWindow(HWND(launcher as *mut _), SW_SHOW);
                let _ = SetForegroundWindow(HWND(launcher as *mut _));
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            unsafe {
                let _ = ShowWindow(HWND(launcher as *mut _), SW_HIDE);
            }
            replace(
                selection.token.ok_or("No test token")?,
                "Hé, dit is een test. 🙂".into(),
                launcher,
            )
            .await?;
            tokio::time::sleep(Duration::from_millis(200)).await;
            let actual = unsafe {
                let mut text = vec![0u16; 512];
                let size = GetWindowTextW(HWND(edit as *mut _), &mut text) as usize;
                String::from_utf16(&text[..size]).unwrap()
            };
            if actual != "before Hé, dit is een test. 🙂 after" {
                return Err(format!("Wrong replacement: {actual:?}"));
            }
            if unsafe { GetForegroundWindow() }.0 as usize != source {
                return Err("Source did not regain foreground".into());
            }
            // Equal text at a different position must still be refused.
            unsafe {
                SendMessageW(
                    HWND(edit as *mut _),
                    WM_SETTEXT,
                    None,
                    Some(LPARAM(w!("same same").as_ptr() as isize)),
                );
                SendMessageW(
                    HWND(edit as *mut _),
                    0x00b1,
                    Some(WPARAM(0)),
                    Some(LPARAM(4)),
                );
            }
            let saved = capture().await?;
            unsafe {
                SendMessageW(
                    HWND(edit as *mut _),
                    0x00b1,
                    Some(WPARAM(5)),
                    Some(LPARAM(9)),
                );
            }
            let refused = replace(
                saved.token.ok_or("No second token")?,
                "WRONG".into(),
                launcher,
            )
            .await;
            if !refused.is_err_and(|e| e.contains("different position")) {
                return Err("A moved selection was not correctly refused".into());
            }
            let mut unchanged = vec![0u16; 30];
            let size = unsafe { GetWindowTextW(HWND(edit as *mut _), &mut unchanged) } as usize;
            if String::from_utf16(&unchanged[..size]).unwrap() != "same same" {
                return Err("Refused replacement modified the source".into());
            }
            Ok::<(), String>(())
        }
        .await;
        done.store(true, Ordering::SeqCst);
        fixture.join().unwrap();
        result.unwrap();
    }
    #[test]
    fn waits_for_delayed_focus_but_never_accepts_expired_checks() {
        let mut observations = 0;
        wait_until(Instant::now() + Duration::from_secs(1), || {
            observations += 1;
            Ok(observations >= 3)
        })
        .unwrap();
        assert_eq!(observations, 3);
        assert!(wait_until(Instant::now(), || Ok(true)).is_err());
        assert!(wait_until(Instant::now() + Duration::from_secs(1), || Err(
            "Window closed".into()
        ))
        .is_err());
    }
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
