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
                                if let Some((wx, wy, ww, wh)) = get_window_rect(&window) {
                                    let (x, y) = get_mouse_pos();

                                    let in_window = x >= wx && x <= wx + ww && y >= wy && y <= wy + wh;
                                    if in_window != was_hovering_window || !was_locked {
                                        was_hovering_window = in_window;
                                        let _ = window.emit("hover-window", in_window);
                                    }

                                    let lock_zone_height = 80i32.min(wh);

                                    #[cfg(target_os = "windows")]
                                    let (zone_top, zone_bot) = (wy, wy + lock_zone_height);
                                    #[cfg(target_os = "macos")]
                                    let (zone_top, zone_bot) = (wy + wh, wy + wh - lock_zone_height);

                                    let in_lock_zone = x >= wx && x <= wx + ww
                                        && y >= zone_bot && y <= zone_top;

                                    if !was_locked || in_lock_zone != was_in_lock_zone {
                                        was_in_lock_zone = in_lock_zone;

                                        let _ = window.emit("hover-lock-zone", in_lock_zone);
                                        println!(
                                            "[Lock] Mouse=({},{})  Win=({},{})  {}x{}  InWin={}  InZone={}  ZoneTop={} ZoneBot={}",
                                            x, y, wx, wy, ww, wh, in_window, in_lock_zone, zone_top, zone_bot
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
mod macos_utils {
    use objc2::msg_send;
    use objc2::class;

    #[repr(C)]
    #[derive(Copy, Clone)]
    pub struct NSPoint(pub f64, pub f64);

    #[repr(C)]
    #[derive(Copy, Clone)]
    pub struct NSSize(pub f64, pub f64);

    #[repr(C)]
    #[derive(Copy, Clone)]
    pub struct NSRect(pub NSPoint, pub NSSize);

    unsafe impl objc2::encode::Encode for NSPoint {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[objc2::Encoding::Double, objc2::Encoding::Double]);
    }

    unsafe impl objc2::encode::Encode for NSSize {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGSize", &[objc2::Encoding::Double, objc2::Encoding::Double]);
    }

    unsafe impl objc2::encode::Encode for NSRect {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSSize::ENCODING]);
    }

    pub fn get_mouse_pos() -> (i32, i32) {
        let point: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
        (point.0 as i32, point.1 as i32)
    }

    /// Get real-time window frame via `[NSWindow frame]` (Cocoa screen coords).
    /// Tauri's outer_position() can return stale data; this fetches directly.
    pub fn get_window_rect(
        window: &tauri::WebviewWindow,
    ) -> Option<(i32, i32, i32, i32)> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use objc2::runtime::NSObject;
        let wh = window.window_handle().ok()?;
        let h = if let RawWindowHandle::AppKit(h) = wh.as_raw() { h } else { return None };
        unsafe {
            let view: *mut NSObject = h.ns_view.as_ptr().cast();
            let wnd: *mut NSObject = msg_send![view, window];
            let rect: NSRect = msg_send![wnd, frame];
            Some((rect.0.0 as i32, rect.0.1 as i32, rect.1.0 as i32, rect.1.1 as i32))
        }
    }
}

#[cfg(target_os = "macos")]
use macos_utils::{get_mouse_pos, get_window_rect};

#[cfg(target_os = "windows")]
fn get_mouse_pos() -> (i32, i32) {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) }.is_err() {
        return (0, 0);
    }
    (point.x, point.y)
}

#[cfg(target_os = "windows")]
fn get_window_rect(window: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some((pos.x, pos.y, size.width as i32, size.height as i32))
}
