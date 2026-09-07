use serde::Serialize;
use std::{collections::HashMap, process::Stdio, sync::Arc};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{mpsc, oneshot, watch, Mutex},
};

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum WireEvent {
    Ready(()),
    Done(()),
    Line(String),
    Error(String),
    Exit(Option<i32>),
}
struct Process {
    input: mpsc::Sender<String>,
    stop: oneshot::Sender<()>,
    done: watch::Receiver<bool>,
}
#[derive(Clone, Default)]
pub struct Processes(Arc<Mutex<HashMap<String, Process>>>);

pub fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

// npm's codex shim is a .cmd file. Resolve its JS entrypoint without invoking a shell.
fn provider_command(executable: &str, args: &[String]) -> Result<Command, String> {
    if executable.eq_ignore_ascii_case("codex") {
        #[cfg(windows)]
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                let native = dir.join("codex.exe");
                if native.is_file() {
                    let mut cmd = Command::new(native);
                    cmd.args(args);
                    return Ok(cmd);
                }
                let js = dir.join("node_modules/@openai/codex/bin/codex.js");
                if js.is_file() {
                    let mut cmd = Command::new("node");
                    cmd.arg(js).args(args);
                    return Ok(cmd);
                }
            }
        }
    }
    if executable.to_lowercase().ends_with(".cmd") || executable.to_lowercase().ends_with(".bat") {
        return Err("Choose the .exe file or node with the .js file as an argument; shell scripts are not run automatically.".into());
    }
    let mut command = Command::new(executable);
    command.args(args);
    Ok(command)
}

// Windows Job Object owns the entire agent process tree and kills it on close.
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
impl Job {
    fn attach(child: &tokio::process::Child) -> Result<Self, String> {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::{JobObjects::*, Threading::*},
        };
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let guard = Job(job);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                0,
                child.id().ok_or("Process exited")?,
            );
            if process.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(guard)
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[tauri::command]
pub async fn process_open(
    state: tauri::State<'_, Processes>,
    id: String,
    executable: String,
    args: Vec<String>,
    cwd: String,
    events: Channel<WireEvent>,
) -> Result<(), String> {
    let mut map = state.0.lock().await;
    if map.contains_key(&id) {
        return Err("Duplicate process ID".into());
    }
    if map.len() >= 8 {
        return Err("Too many active providers".into());
    }
    if executable.trim().is_empty() {
        return Err("Configure an agent executable first.".into());
    }
    let mut command = provider_command(&executable, &args)?;
    hidden(&mut command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if !cwd.is_empty() {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start {executable}: {e}"))?;
    #[cfg(windows)]
    let job = Job::attach(&child)?;
    let mut stdin = child.stdin.take().ok_or("Missing stdin")?;
    let mut stdout = child.stdout.take().ok_or("Missing stdout")?;
    let mut stderr = child.stderr.take().ok_or("Missing stderr")?;
    let (input, mut receiver) = mpsc::channel::<String>(32);
    let (stop, mut cancelled) = oneshot::channel::<()>();
    let (finished, done) = watch::channel(false);
    map.insert(id.clone(), Process { input, stop, done });
    let shared = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        #[cfg(windows)]
        let job = job;
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut error_chunk = [0u8; 2048];
        let mut last_error = String::new();
        let mut stderr_open = true;
        loop {
            tokio::select! {
                _ = &mut cancelled => { let _ = child.kill().await; break; }
                message = receiver.recv() => {
                    let Some(message) = message else { break; };
                    let frame = format!("{message}\n");
                    tokio::select! {
                        result = stdin.write_all(frame.as_bytes()) => { if result.is_err() { break; } }
                        _ = &mut cancelled => { break; }
                    }
                }
                result = stdout.read(&mut chunk) => {
                    match result {
                        Ok(0) => break,
                        Ok(size) => {
                            buffer.extend_from_slice(&chunk[..size]);
                            if buffer.len() > 4 * 1024 * 1024 { let _ = events.send(WireEvent::Error("Agent message too large".into())); break; }
                            let mut disconnected = false;
                            while let Some(at) = buffer.iter().position(|b| *b == b'\n') {
                                let bytes: Vec<u8> = buffer.drain(..=at).collect();
                                let line = String::from_utf8_lossy(&bytes).trim_end().to_owned();
                                if events.send(WireEvent::Line(line)).is_err() { disconnected = true; break; }
                            }
                            if disconnected { break; }
                        }
                        Err(e) => { let _ = events.send(WireEvent::Error(e.to_string())); break; }
                    }
                }
                line = stderr.read(&mut error_chunk), if stderr_open => {
                    match line { Ok(size) if size > 0 => last_error = String::from_utf8_lossy(&error_chunk[..size]).into_owned(), _ => stderr_open = false }
                }
            }
        }
        let status = child.try_wait().ok().flatten();
        if status.is_none() {
            let _ = child.kill().await;
        }
        #[cfg(windows)]
        drop(job);
        if status.as_ref().is_some_and(|s| !s.success()) && !last_error.is_empty() {
            let _ = events.send(WireEvent::Error(last_error));
        }
        let _ = events.send(WireEvent::Exit(status.and_then(|s| s.code())));
        shared.0.lock().await.remove(&id);
        let _ = finished.send(true);
    });
    Ok(())
}

#[tauri::command]
pub async fn process_write(
    state: tauri::State<'_, Processes>,
    id: String,
    message: String,
) -> Result<(), String> {
    if message.len() > 4 * 1024 * 1024 || message.contains('\n') {
        return Err("Invalid protocol frame".into());
    }
    let input = state
        .0
        .lock()
        .await
        .get(&id)
        .ok_or("Agent has closed")?
        .input
        .clone();
    input.send(message).await.map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn process_close(state: tauri::State<'_, Processes>, id: String) -> Result<(), String> {
    let process = state.0.lock().await.remove(&id);
    if let Some(mut process) = process {
        let _ = process.stop.send(());
        if !*process.done.borrow() {
            tokio::time::timeout(std::time::Duration::from_secs(5), process.done.changed())
                .await
                .map_err(|_| "Agent shutdown timed out")?
                .map_err(|_| "Agent shutdown interrupted")?;
        }
    }
    Ok(())
}
