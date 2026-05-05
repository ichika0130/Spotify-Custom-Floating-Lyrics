#![cfg(target_os = "macos")]

use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::process::Command;

#[derive(Clone, serde::Serialize, Debug)]
struct TrackUpdate {
    title: String,
    artist: String,
    status: i32,       // 4=Playing, 5=Paused
    position: i64,     // ms
    duration: i64,     // ms
    last_updated: i64, // unix timestamp ms
}

pub struct MacosWorker {
    app_handle: AppHandle,
}

impl MacosWorker {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }

    pub fn start(&self) {
        let app_handle = self.app_handle.clone();

        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(500));
            let mut last_title = String::new();
            let mut last_status = -1i32;

            loop {
                interval.tick().await;

                match Self::poll().await {
                    Ok(update) => {
                        let changed = update.title != last_title || update.status != last_status;
                        let playing = update.status == 4;

                        if changed || playing {
                            last_title = update.title.clone();
                            last_status = update.status;
                            let _ = app_handle.emit("smtc-update", &update);
                        }
                    }
                    Err(e) => {
                        eprintln!("[macOS] poll error: {}", e);
                    }
                }
            }
        });
    }

    async fn poll() -> Result<TrackUpdate, String> {
        // "|||" as separator — unlikely in track names; splitn(5) lets artist safely contain it.
        // try/on error handles Spotify not running without an if-it-is-running block,
        // which caused parse errors on some macOS versions.
        let script = r#"
try
    tell application "Spotify"
        set trackState to player state
        set trackPos to player position
        set trackTitle to name of current track
        set trackArtist to artist of current track
        set trackDur to duration of current track
        if trackState is playing then
            set statusCode to "4"
        else
            set statusCode to "5"
        end if
        set posNum to round (trackPos * 1000)
        set posMs to posNum as string
        set durMs to trackDur as string
        return statusCode & "|||" & posMs & "|||" & durMs & "|||" & trackTitle & "|||" & trackArtist
    end tell
on error
    return "stopped"
end try
"#;

        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .await
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("osascript: {}", err.trim()));
        }

        let raw = String::from_utf8_lossy(&output.stdout);
        let result = raw.trim();

        if result == "stopped" || result.is_empty() {
            return Err("Spotify not running".to_string());
        }

        let parts: Vec<&str> = result.splitn(5, "|||").collect();
        if parts.len() < 5 {
            return Err(format!("unexpected output: {}", result));
        }

        let status: i32 = parts[0].trim().parse().unwrap_or(5);
        let position: i64 = parts[1].trim().parse().unwrap_or(0);
        let duration: i64 = parts[2].trim().parse().unwrap_or(0);
        let title = parts[3].trim().to_string();
        let artist = parts[4].trim().to_string();

        let last_updated = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        Ok(TrackUpdate { title, artist, status, position, duration, last_updated })
    }
}
