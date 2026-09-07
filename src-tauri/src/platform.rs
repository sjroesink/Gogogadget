use crate::process::hidden;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::process::Command;

#[derive(Clone, Serialize, Deserialize)]
pub struct AppEntry {
    pub id: String,
    pub name: String,
}
#[derive(Default)]
pub struct AppIndex(pub tokio::sync::Mutex<Option<Vec<AppEntry>>>);

#[tauri::command]
pub async fn list_apps(
    state: tauri::State<'_, AppIndex>,
    refresh: bool,
) -> Result<Vec<AppEntry>, String> {
    let mut cache = state.0.lock().await;
    if !refresh {
        if let Some(apps) = cache.as_ref() {
            return Ok(apps.clone());
        }
    }
    #[cfg(windows)]
    let apps = {
        let mut cmd = Command::new("powershell.exe");
        hidden(&mut cmd).args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-StartApps | ForEach-Object { @{id=$_.AppID;name=$_.Name} }) | ConvertTo-Json -Compress"]);
        cmd.kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output())
            .await
            .map_err(|_| "App indexing timed out")?
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("Could not load Windows apps".into());
        }
        serde_json::from_slice::<Vec<AppEntry>>(&output.stdout).map_err(|e| e.to_string())?
    };
    #[cfg(not(windows))]
    let apps = Vec::new(); // Native app discovery adapters are the remaining platform work.
    *cache = Some(apps);
    Ok(cache.as_ref().unwrap().clone())
}
#[tauri::command]
pub async fn launch_app(state: tauri::State<'_, AppIndex>, id: String) -> Result<(), String> {
    if !state
        .0
        .lock()
        .await
        .as_ref()
        .is_some_and(|apps| apps.iter().any(|app| app.id == id))
    {
        return Err("App is not in the local index".into());
    }
    #[cfg(windows)]
    {
        hidden(Command::new("explorer.exe").arg(format!("shell:AppsFolder\\{id}")))
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err("App launching is currently supported on Windows".into())
}
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("Only HTTP(S) links are allowed".into());
    }
    #[cfg(windows)]
    let mut cmd = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = Command::new("xdg-open");
    hidden(&mut cmd)
        .arg(parsed.as_str())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn load_settings(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json");
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
#[tauri::command]
pub async fn save_settings(app: tauri::AppHandle, value: serde_json::Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    if bytes.len() > 256 * 1024 {
        return Err("Settings too large".into());
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let temp = dir.join("settings.tmp");
    tokio::fs::write(&temp, bytes)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(temp, dir.join("settings.json"))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn default_cwd(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("workspace");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
