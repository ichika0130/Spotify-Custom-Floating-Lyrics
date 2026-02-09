#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, Emitter,
};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use windows::Win32::Foundation::POINT;

// 状态管理
struct AppState {
    is_locked: bool,
}

#[tauri::command]
fn set_lock_state(state: tauri::State<Arc<Mutex<AppState>>>, locked: bool) {
    let mut s = state.lock().unwrap();
    s.is_locked = locked;
}

// 包装器：这里定义命令，名字叫 get_spotify_track，供前端调用
#[tauri::command]
async fn get_spotify_track() -> Result<String, String> {
    // 调用 lib 里的逻辑函数
    spotify_lyrics_lib::get_spotify_track_logic().await
}

// 包装器：这里定义命令，名字叫 fetch_proxy，供前端调用
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
        .manage(app_state.clone()) // 注册状态
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_maximizable(false);
            }
            
            // --- 托盘逻辑开始 ---
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
                                window.set_ignore_cursor_events(false).unwrap();
                                let _ = window.emit("lock-status", false);
                                // 更新状态
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
            // --- 托盘逻辑结束 ---

            // --- 开启监控线程 ---
            let app_handle = app.handle().clone();
            
            // Start SMTC Worker
            let smtc_worker = spotify_lyrics_lib::smtc_worker::SmtcWorker::new(app_handle.clone());
            smtc_worker.start();

            let state_clone = app_state.clone();
            
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
                            // 获取窗口位置和大小（使用 Tauri API，更可靠）
                            if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                                // 获取鼠标位置（全局）
                                let mut point = POINT::default();
                                let _ = unsafe { GetCursorPos(&mut point) };
                                
                                let x = point.x;
                                let y = point.y;
                                
                                // 转换为 i32 进行比较
                                let wx = pos.x;
                                let wy = pos.y;
                                let ww = size.width as i32;
                                let wh = size.height as i32;

                                // 1. 判断是否在窗口范围内
                                let in_window = x >= wx && x <= wx + ww && y >= wy && y <= wy + wh;

                                if in_window != was_hovering_window || !was_locked {
                                    was_hovering_window = in_window;
                                    let _ = window.emit("hover-window", in_window);
                                    // println!("Hover Window Update: {}", in_window);
                                }

                                // 2. 判断是否在“锁按钮”区域
                                // 缩小锁区域：避免遮挡用户操作背景
                                // 宽度 100px，高度 60px
                                let lock_zone_width = 100;
                                let lock_zone_height = 60;
                                
                                let lock_zone_left = wx + (ww / 2) - (lock_zone_width / 2);
                                let lock_zone_right = wx + (ww / 2) + (lock_zone_width / 2);
                                let lock_zone_top = wy;
                                let lock_zone_bottom = wy + lock_zone_height;

                                let in_lock_zone = x >= lock_zone_left && x <= lock_zone_right &&
                                                 y >= lock_zone_top && y <= lock_zone_bottom;

                                // 如果刚进入锁定状态，或者锁区域状态改变，强制更新穿透状态
                                if !was_locked || in_lock_zone != was_in_lock_zone {
                                    was_in_lock_zone = in_lock_zone;
                                    
                                    // 关键：在主线程执行 set_ignore_cursor_events 以确保生效
                                    // 这里我们是在 spawn 的线程中，直接调用应该也会分发到主线程，但加上 run_on_main_thread 更稳妥？
                                    // 不，Tauri 的 window 方法已经是线程安全的。
                                    
                                    let res = window.set_ignore_cursor_events(!in_lock_zone);
                                    let _ = window.emit("hover-lock-zone", in_lock_zone);
                                    
                                    println!(
                                        "Lock Update | Mouse: ({},{}) | Win: ({},{}) {}x{} | InLockZone: {} | Ignore: {} | Res: {:?}",
                                        x, y, wx, wy, ww, wh, in_lock_zone, !in_lock_zone, res
                                    );
                                }
                            } else {
                                eprintln!("Failed to get window bounds");
                            }
                        }
                    } else {
                        // 未锁定状态重置
                        was_in_lock_zone = false;
                        was_hovering_window = false;
                    }
                    was_locked = is_locked;
                }
            });

            Ok(())
        }) // 注意：这里没有分号！
        .invoke_handler(tauri::generate_handler![
            get_spotify_track, // 注册上面定义的包装函数
            fetch_proxy,
            spotify_control,
            set_lock_state,
            start_auth_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}