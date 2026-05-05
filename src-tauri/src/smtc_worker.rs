#![cfg(target_os = "windows")]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
};
use windows::Foundation::TypedEventHandler;

// Data structure to send to frontend
#[derive(Clone, serde::Serialize, Debug)]
struct SmtcUpdate {
    title: String,
    artist: String,
    status: i32, // 4=Playing, 5=Paused
    position: i64, // ms
    duration: i64, // ms
    last_updated: i64, // unix timestamp ms
}

// Internal state to track the current session
struct WorkerState {
    current_session: Option<GlobalSystemMediaTransportControlsSession>,
    last_update_time: Instant,
}

pub struct SmtcWorker {
    app_handle: AppHandle,
    state: Arc<Mutex<WorkerState>>,
}

impl SmtcWorker {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            state: Arc::new(Mutex::new(WorkerState {
                current_session: None,
                last_update_time: Instant::now() - Duration::from_secs(10), // Ensure first update passes
            })),
        }
    }

    pub fn start(&self) {
        let app_handle = self.app_handle.clone();
        let state = self.state.clone();

        // Spawn a dedicated thread for COM interactions to ensure MTA
        // This is critical to avoid RPC_E_CALL_CANCELED (0x80010002) or RPC_E_WRONG_THREAD
        std::thread::spawn(move || {
            // Initialize WinRT as MTA
            unsafe {
                use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
                let _ = RoInitialize(RO_INIT_MULTITHREADED);
            }
            
            println!("[SMTC] Worker thread started (MTA)");

            // Create a local Tokio runtime for this thread
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to build tokio runtime");

            rt.block_on(async {
                let mut manager = None;
                // Retry logic for RequestAsync
                for i in 1..=5 {
                    match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
                        Ok(op) => match op.await {
                            Ok(m) => {
                                manager = Some(m);
                                break;
                            }
                            Err(e) => eprintln!("[SMTC] RequestAsync await failed (attempt {}): {:?}", i, e),
                        },
                        Err(e) => eprintln!("[SMTC] RequestAsync failed (attempt {}): {:?}", i, e),
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }

                let manager = match manager {
                    Some(m) => m,
                    None => {
                        eprintln!("[SMTC] Failed to get SessionManager after retries. SMTC functionality disabled.");
                        return;
                    }
                };

                println!("[SMTC] SessionManager acquired successfully");

                // Initial session check
                Self::update_session(&manager, &state, &app_handle).await;

                // Subscribe to SessionsChanged
                // We create a scope to ensure handler is dropped and not held across awaits if strictly needed,
                // though block_on doesn't require Send for the root future.
                {
                    let state_clone = state.clone();
                    let app_handle_clone = app_handle.clone();
                    let manager_clone = manager.clone();
                    
                    let handler = TypedEventHandler::new(move |_, _| {
                        println!("[SMTC] SessionsChanged event received");
                        let state = state_clone.clone();
                        let app_handle = app_handle_clone.clone();
                        let manager = manager_clone.clone();
                        
                        // We use tauri::async_runtime::spawn to offload the work to the global pool,
                        // or we could use a local channel. Since the callback runs on a COM thread,
                        // we need to be careful. tauri::async_runtime::spawn is safe.
                        tauri::async_runtime::spawn(async move {
                             // Small delay to ensure session list is updated
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            Self::update_session(&manager, &state, &app_handle).await;
                        });
                        Ok(())
                    });

                    if let Err(e) = manager.SessionsChanged(&handler) {
                        eprintln!("[SMTC] Failed to subscribe to SessionsChanged: {:?}", e);
                    } else {
                        println!("[SMTC] Subscribed to SessionsChanged");
                    }
                }

                // Keep the thread alive and processing events if any (though COM callbacks are on their own threads)
                loop {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            });
        });
    }

    async fn update_session(
        manager: &GlobalSystemMediaTransportControlsSessionManager,
        state: &Arc<Mutex<WorkerState>>,
        app_handle: &AppHandle,
    ) {
        let mut target_session: Option<GlobalSystemMediaTransportControlsSession> = None;

        // Scope for sessions to ensure it's dropped before any await
        {
            let sessions = match manager.GetSessions() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[SMTC] Failed to get sessions: {:?}", e);
                    return;
                }
            };

            let count = sessions.Size().unwrap_or(0);
            println!("[SMTC] Scanning {} sessions...", count);

            for i in 0..count {
                if let Ok(session) = sessions.GetAt(i) {
                    if let Ok(aumid) = session.SourceAppUserModelId() {
                        let id = aumid.to_string();
                        // White list + Fallback logic
                        if id.contains("Spotify.exe") || id.contains("SpotifyAB.SpotifyMusic") {
                             println!("[SMTC] Found Spotify session (Exact Match): {}", id);
                             target_session = Some(session);
                             break;
                        } else if id.to_lowercase().contains("spotify") {
                             println!("[SMTC] Found Spotify session (Fuzzy Match): {}", id);
                             target_session = Some(session);
                             break;
                        } else {
                            println!("[SMTC] Ignoring session: {}", id);
                        }
                    }
                }
            }
        } // sessions dropped here

        let needs_hook;
        {
            let mut locked_state = state.lock().unwrap();

            needs_hook = match (&locked_state.current_session, &target_session) {
                (None, Some(_)) => true,
                (Some(_), None) => {
                    println!("[SMTC] Spotify session lost");
                    locked_state.current_session = None;
                    // TODO: Emit paused/empty state?
                    false
                },
                (Some(_), Some(_)) => {
                    // Session already hooked — do not re-register handlers to avoid duplicates.
                    // If Spotify restarts, SessionsChanged fires (Some,None) then (None,Some),
                    // which correctly triggers a fresh hook.
                    false
                },
                (None, None) => false,
            };
        } // locked_state dropped here

        if needs_hook {
            if let Some(session) = target_session {
                println!("[SMTC] Hooking into session events...");
                
                // Hook MediaPropertiesChanged
                // NOTE: Do NOT clone the session into the handler closure — it would create
                // a COM reference cycle (Session ↔ TypedEventHandler), leaking COM objects
                // every time the Spotify session changes.
                {
                    let state_clone = state.clone();
                    let app_handle_clone = app_handle.clone();
                    let prop_handler = TypedEventHandler::new(move |_, _| {
                        let state = state_clone.clone();
                        let app_handle = app_handle_clone.clone();
                        tauri::async_runtime::spawn(async move {
                            let session = {
                                let locked = state.lock().unwrap();
                                locked.current_session.clone()
                            };
                            if let Some(s) = session {
                                Self::broadcast_update(&s, &state, &app_handle, "MediaPropertiesChanged").await;
                            }
                        });
                        Ok(())
                    });
                    let _ = session.MediaPropertiesChanged(&prop_handler);
                }

                // Hook PlaybackInfoChanged
                {
                    let state_clone = state.clone();
                    let app_handle_clone = app_handle.clone();
                    let playback_handler = TypedEventHandler::new(move |_, _| {
                        let state = state_clone.clone();
                        let app_handle = app_handle_clone.clone();
                        tauri::async_runtime::spawn(async move {
                            let session = {
                                let locked = state.lock().unwrap();
                                locked.current_session.clone()
                            };
                            if let Some(s) = session {
                                Self::broadcast_update(&s, &state, &app_handle, "PlaybackInfoChanged").await;
                            }
                        });
                        Ok(())
                    });
                    let _ = session.PlaybackInfoChanged(&playback_handler);
                }

                // Initial broadcast
                Self::broadcast_update(&session, state, app_handle, "Initial").await;
                
                // Update state
                let mut locked_state = state.lock().unwrap();
                locked_state.current_session = Some(session);
            }
        }
    }

    async fn broadcast_update(
        session: &GlobalSystemMediaTransportControlsSession,
        state: &Arc<Mutex<WorkerState>>,
        app_handle: &AppHandle,
        source: &str,
    ) {
        // Debounce: 200ms
        {
            let mut locked_state = state.lock().unwrap();
            if locked_state.last_update_time.elapsed() < Duration::from_millis(200) {
                // println!("[SMTC] Skipping update from {} (Debounced)", source);
                return;
            }
            locked_state.last_update_time = Instant::now();
        }

        let properties = match session.TryGetMediaPropertiesAsync() {
            Ok(op) => match op.await {
                Ok(p) => p,
                Err(_) => return, // Graceful fail
            },
            Err(_) => return,
        };

        let title = properties.Title().unwrap_or_default().to_string();
        let artist = properties.Artist().unwrap_or_default().to_string();

        let playback_info = match session.GetPlaybackInfo() {
            Ok(p) => p,
            Err(_) => return,
        };

        let status = playback_info.PlaybackStatus().ok().map(|s| s.0).unwrap_or(5); // 5=Closed/Paused
        
        let timeline = session.GetTimelineProperties().ok();
        let (position, duration, last_updated) = if let Some(t) = timeline {
            let pos = t.Position().map(|p| p.Duration / 10000).unwrap_or(0); // 100ns -> ms
            let dur = t.EndTime().map(|d| d.Duration / 10000).unwrap_or(0);
            let lut = t.LastUpdatedTime().map(|l| l.UniversalTime).unwrap_or(0);
            
             // Convert Windows FILETIME to Unix Timestamp (ms)
             // Windows epoch: 1601-01-01
             // Unix epoch: 1970-01-01
             // Diff: 116444736000000000 ticks (100ns)
            let unix_ms = if lut > 116444736000000000 {
                (lut - 116444736000000000) / 10000
            } else {
                0
            };
            (pos, dur, unix_ms)
        } else {
            (0, 0, 0)
        };

        // Filter out empty updates if needed, or handle them gracefully
        if title.is_empty() && artist.is_empty() {
            // println!("[SMTC] Empty track info, skipping");
            return;
        }

        println!("[SMTC] Update from {}: {} - {} ({})", source, title, artist, status);

        let update = SmtcUpdate {
            title,
            artist,
            status,
            position,
            duration,
            last_updated,
        };

        let _ = app_handle.emit("smtc-update", update);
    }
}
