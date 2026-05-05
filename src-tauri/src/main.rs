#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, Emitter,
};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::POINT;

struct AppState {
    is_locked: bool,
}

#[tauri::command]
fn set_lock_state(state: tauri::State<Arc<Mutex<AppState>>>, locked: bool) {
    let mut s = state.lock().unwrap();
    s.is_locked = locked;
}

#[tauri::command]
async fn get_spotify_track() -> Result<String, String> {
    spotify_lyrics_lib::get_spotify_track_logic().await
}

#[tauri::command]
async fn fetch_proxy(url: String) -> Result<String, String> {
    spotify_lyrics_lib::fetch_proxy_logic(url).await
}

#[tauri::command]
async fn spotify_control(command: String) -> Result<(), String> {
    spotify_lyrics_lib::spotify_control_logic(command).await
}

#[tauri::command]
async fn start_auth_server() -> Result<String, String> {
    spotify_lyrics_lib::start_auth_server_logic().await
}

fn main() {
    let app_state = Arc::new(Mutex::new(AppState { is_locked: false }));

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .manage(app_state.clone())
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_maximizable(false);
            }

            // --- 托盘 ---
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let unlock_i = MenuItem::with_id(app, "unlock", "取消锁定", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&unlock_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app_handle, event| {
                    match event.id.as_ref() {
                        "unlock" => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.set_ignore_cursor_events(false);
                                let _ = window.emit("lock-status", false);
                                let state = app_handle.state::<Arc<Mutex<AppState>>>();
                                let mut s = state.lock().unwrap();
                                s.is_locked = false;
                            }
                        }
                        "quit" => {
                            std::process::exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            let app_handle = app.handle().clone();

            // --- 启动平台专属 media worker ---
            #[cfg(target_os = "windows")]
            {
                let smtc_worker = spotify_lyrics_lib::smtc_worker::SmtcWorker::new(app_handle.clone());
                smtc_worker.start();
            }
            #[cfg(target_os = "macos")]
            {
                let macos_worker = spotify_lyrics_lib::macos_worker::MacosWorker::new(app_handle.clone());
                macos_worker.start();
            }

            // --- 锁区域鼠标穿透检测 (Windows: GetCursorPos / macOS: NSEvent) ---
            {
                let state_clone = app_state.clone();
                let app_handle = app.handle().clone();
                thread::spawn(move || {
                    let mut was_in_lock_zone = false;
                    let mut was_hovering_window = false;
                    let mut was_locked = false;

                    loop {
                        thread::sleep(Duration::from_millis(50));

                        let is_locked = {
                            let s = state_clone.lock().unwrap();
                            s.is_locked
                        };

                        if is_locked {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                                    let (x, y) = get_mouse_pos();
                                    let wx = pos.x;
                                    let wy = pos.y;
                                    let ww = size.width as i32;
                                    let wh = size.height as i32;

                                    let in_window = x >= wx && x <= wx + ww && y >= wy && y <= wy + wh;
                                    if in_window != was_hovering_window || !was_locked {
                                        was_hovering_window = in_window;
                                        let _ = window.emit("hover-window", in_window);
                                    }

                                    let lock_zone_width = 100i32.min(ww);
                                    let lock_zone_height = 60i32.min(wh);
                                    let lock_zone_left = wx + (ww / 2) - (lock_zone_width / 2);
                                    let lock_zone_right = wx + (ww / 2) + (lock_zone_width / 2);

                                    #[cfg(target_os = "windows")]
                                    let (lock_zone_top, lock_zone_bottom) = (wy, wy + lock_zone_height);
                                    #[cfg(target_os = "macos")]
                                    let (lock_zone_top, lock_zone_bottom) = (wy + wh, wy + wh - lock_zone_height);

                                    let in_lock_zone = x >= lock_zone_left && x <= lock_zone_right
                                        && y >= lock_zone_bottom && y <= lock_zone_top;

                                    if !was_locked || in_lock_zone != was_in_lock_zone {
                                        was_in_lock_zone = in_lock_zone;

                                        let _ = window.emit("hover-lock-zone", in_lock_zone);
                                        println!(
                                            "Lock Update | Mouse: ({},{}) | Win: ({},{}) {}x{} | InLockZone: {}",
                                            x, y, wx, wy, ww, wh, in_lock_zone
                                        );
                                    }
                                } else {
                                    eprintln!("Failed to get window bounds");
                                }
                            }
                        } else {
                            was_in_lock_zone = false;
                            was_hovering_window = false;
                        }
                        was_locked = is_locked;
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_spotify_track,
            fetch_proxy,
            spotify_control,
            set_lock_state,
            start_auth_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Platform-specific mouse position: returns (x, y) in screen coordinates.
/// Cocoa (macOS): origin bottom-left, matches outer_position().
/// Windows: origin top-left, matches outer_position().
#[cfg(target_os = "windows")]
fn get_mouse_pos() -> (i32, i32) {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) }.is_err() {
        return (0, 0);
    }
    (point.x, point.y)
}

#[cfg(target_os = "macos")]
fn get_mouse_pos() -> (i32, i32) {
    use objc2::msg_send;
    use objc2::class;

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct NSPoint { x: f64, y: f64 }

    unsafe impl objc2::encode::Encode for NSPoint {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[objc2::Encoding::Double, objc2::Encoding::Double]);
    }

    let point: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
    (point.x as i32, point.y as i32)
}
