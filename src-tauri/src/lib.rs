#[cfg(target_os = "windows")]
use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
use tokio::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use serde_json::json;

#[cfg(target_os = "windows")]
pub mod smtc_worker;
#[cfg(target_os = "macos")]
pub mod macos_worker;

#[cfg(target_os = "macos")]
pub const MACOS_POLL_SCRIPT: &str = r#"
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

// ── Windows: get track via SMTC ──────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub async fn get_spotify_track_logic() -> Result<String, String> {
    let session = {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .map_err(|e: windows::core::Error| e.to_string())?.await
            .map_err(|e: windows::core::Error| e.to_string())?;

        let sessions = manager.GetSessions().map_err(|e: windows::core::Error| e.to_string())?;
        let mut target_session = None;

        let session_count = sessions.Size().unwrap_or(0);

        for i in 0..session_count {
            if let Ok(s) = sessions.GetAt(i) {
                if let Ok(id) = s.SourceAppUserModelId() {
                    let id_str = id.to_string();
                    if id_str.to_lowercase().contains("spotify") {
                        target_session = Some(s);
                        break;
                    }
                }
            }
        }

        match target_session {
            Some(s) => s,
            None => {
                println!("Debug: No Spotify session found, trying GetCurrentSession");
                manager.GetCurrentSession().map_err(|_| "No Media".to_string())?
            },
        }
    };

    let properties = session.TryGetMediaPropertiesAsync()
        .map_err(|e: windows::core::Error| e.to_string())?.await
        .map_err(|e: windows::core::Error| e.to_string())?;

    let timeline = session.GetTimelineProperties().ok();
    let playback_info = session.GetPlaybackInfo().ok();

    let status = playback_info.as_ref()
        .and_then(|p| p.PlaybackStatus().ok())
        .map(|s| s.0)
        .unwrap_or(5);

    let rate = playback_info.as_ref()
        .and_then(|p| p.PlaybackRate().ok())
        .and_then(|r| r.Value().ok())
        .unwrap_or(1.0);

    let title = properties.Title().unwrap_or_default().to_string();
    let artist = properties.Artist().unwrap_or_default().to_string();

    let (position, duration, last_updated_ms) = if let Some(t) = timeline {
        let pos = t.Position().map(|p| p.Duration / 10000).unwrap_or(0);
        let dur = t.EndTime().map(|d| d.Duration / 10000).unwrap_or(0);
        let lut = t.LastUpdatedTime().map(|l| l.UniversalTime).unwrap_or(0);
        let lut_ms = if lut > 116444736000000000 {
            (lut - 116444736000000000) / 10000
        } else {
            0
        };
        (pos, dur, lut_ms)
    } else {
        (0, 0, 0)
    };

    let result = json!({
        "title": title,
        "artist": artist,
        "position": position,
        "duration": duration,
        "status": status,
        "rate": rate,
        "last_updated": last_updated_ms
    });
    Ok(result.to_string())
}

// ── macOS: get track via AppleScript ─────────────────────────────────────────

#[cfg(target_os = "macos")]
pub async fn get_spotify_track_logic() -> Result<String, String> {
    use tokio::process::Command;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(MACOS_POLL_SCRIPT)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        eprintln!("[macOS] get_spotify_track osascript error: {}", err.trim());
        return Err(format!("osascript: {}", err.trim()));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let result = raw.trim();

    if result == "stopped" || result.is_empty() {
        return Err("No Media".to_string());
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

    let response = json!({
        "title": title,
        "artist": artist,
        "position": position,
        "duration": duration,
        "status": status,
        "rate": 1.0,
        "last_updated": last_updated
    });
    Ok(response.to_string())
}

// ── Linux / unsupported platform stubs ─────────────────────────────────────────

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub async fn get_spotify_track_logic() -> Result<String, String> {
    Err("Platform not supported (Linux MPRIS / D-Bus support planned)".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub async fn spotify_control_logic(_command: String) -> Result<(), String> {
    Err("Platform not supported".to_string())
}

// ── Cross-platform: HTTP proxy ────────────────────────────────────────────────

pub async fn fetch_proxy_logic(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    res.text().await.map_err(|e| e.to_string())
}

// ── Windows: playback control via SMTC ───────────────────────────────────────

#[cfg(target_os = "windows")]
pub async fn spotify_control_logic(command: String) -> Result<(), String> {
    let session = {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .map_err(|e: windows::core::Error| e.to_string())?.await
            .map_err(|e: windows::core::Error| e.to_string())?;

        let sessions = manager.GetSessions().map_err(|e: windows::core::Error| e.to_string())?;
        let mut target_session = None;

        for i in 0..sessions.Size().map_err(|e: windows::core::Error| e.to_string())? {
            if let Ok(s) = sessions.GetAt(i) {
                if let Ok(id) = s.SourceAppUserModelId() {
                    if id.to_string().to_lowercase().contains("spotify") {
                        target_session = Some(s);
                        break;
                    }
                }
            }
        }

        match target_session {
            Some(s) => s,
            None => manager.GetCurrentSession().map_err(|_| "No Media Session Found".to_string())?,
        }
    };

    match command.as_str() {
        "play"      => { session.TryPlayAsync().map_err(|e: windows::core::Error| e.to_string())?.await.map_err(|e: windows::core::Error| e.to_string())?; },
        "pause"     => { session.TryPauseAsync().map_err(|e: windows::core::Error| e.to_string())?.await.map_err(|e: windows::core::Error| e.to_string())?; },
        "playpause" => { session.TryTogglePlayPauseAsync().map_err(|e: windows::core::Error| e.to_string())?.await.map_err(|e: windows::core::Error| e.to_string())?; },
        "next"      => { session.TrySkipNextAsync().map_err(|e: windows::core::Error| e.to_string())?.await.map_err(|e: windows::core::Error| e.to_string())?; },
        "prev"      => { session.TrySkipPreviousAsync().map_err(|e: windows::core::Error| e.to_string())?.await.map_err(|e: windows::core::Error| e.to_string())?; },
        _ => return Err("Unknown command".to_string()),
    };

    Ok(())
}

// ── macOS: playback control via AppleScript ───────────────────────────────────

#[cfg(target_os = "macos")]
pub async fn spotify_control_logic(command: String) -> Result<(), String> {
    use tokio::process::Command;

    let applescript_cmd = match command.as_str() {
        "play"      => "tell application \"Spotify\" to play",
        "pause"     => "tell application \"Spotify\" to pause",
        "playpause" => "tell application \"Spotify\" to playpause",
        "next"      => "tell application \"Spotify\" to next track",
        "prev"      => "tell application \"Spotify\" to previous track",
        _ => return Err("Unknown command".to_string()),
    };

    let output = Command::new("osascript")
        .arg("-e")
        .arg(applescript_cmd)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("osascript: {}", err.trim()));
    }

    Ok(())
}

// ── Cross-platform: OAuth callback server ────────────────────────────────────

pub async fn start_auth_server_logic() -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:8888").await.map_err(|e| e.to_string())?;

    let (mut socket, _) = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        listener.accept(),
    )
    .await
    .map_err(|_| "OAuth callback timed out".to_string())?
    .map_err(|e| e.to_string())?;

    let mut buffer = [0; 1024];
    let n = socket.read(&mut buffer).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buffer[..n]);

    let code = if let Some(start) = request.find("code=") {
        let rest = &request[start + 5..];
        let end = rest.find(|c| c == '&' || c == ' ').unwrap_or(rest.len());
        rest[..end].to_string()
    } else {
        return Err("No code found".to_string());
    };

    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<h1>Success! You can close this tab now.</h1><script>window.close()</script>";
    socket.write_all(response.as_bytes()).await.map_err(|e| e.to_string())?;

    Ok(code)
}
