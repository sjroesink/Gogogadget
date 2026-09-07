#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod http;
mod icons;
mod platform;
mod process;
mod selection;
#[cfg(test)]
mod tests;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, ShortcutState};

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("launcher:focus", ());
    }
}
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if shortcut.key == Code::KeyT {
                            selection::open(app.clone());
                            return;
                        }
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                show(app);
                            }
                        }
                    }
                })
                .build(),
        )
        .manage(process::Processes::default())
        .manage(http::Http::default())
        .manage(platform::AppIndex::default())
        .manage(icons::Icons::default())
        .setup(|app| {
            app.global_shortcut().register("Ctrl+Alt+Space")?;
            app.global_shortcut().register("Ctrl+Alt+T")?;
            let open = MenuItem::with_id(app, "open", "Open Gogogadget", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let pixels: Vec<u8> = (0..32 * 32)
                .flat_map(|i| {
                    let (x, y) = (i % 32, i / 32);
                    if (7..25).contains(&x)
                        && (7..25).contains(&y)
                        && (x < 12 || !(12..=19).contains(&y) || (x > 19 && y > 15))
                    {
                        [189, 233, 139, 255]
                    } else {
                        [26, 29, 26, 255]
                    }
                })
                .collect();
            TrayIconBuilder::new()
                .icon(tauri::image::Image::new_owned(pixels, 32, 32))
                .tooltip("Gogogadget · Ctrl+Alt+Space")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            process::process_open,
            process::process_write,
            process::process_close,
            http::http_request,
            http::http_cancel,
            platform::list_apps,
            icons::app_icon,
            platform::launch_app,
            platform::open_url,
            platform::load_settings,
            platform::save_settings,
            platform::default_cwd,
            selection::replace_selection,
            quit
        ])
        .run(tauri::generate_context!())
        .expect("Gogogadget could not start");
}
