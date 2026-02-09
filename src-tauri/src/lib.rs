use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
use tokio::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub mod smtc_worker;

//#[tauri::command]
pub async fn get_spotify_track_logic() -> Result<String, String> {
    let session = {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .map_err(|e: windows::core::Error| e.to_string())?.await
            .map_err(|e: windows::core::Error| e.to_string())?;

        let sessions = manager.GetSessions().map_err(|e: windows::core::Error| e.to_string())?;
        let mut target_session = None;

        // 优先寻找 Spotify 会话
        let session_count = sessions.Size().unwrap_or(0);
        // println!("Debug: Found {} sessions", session_count);

        for i in 0..session_count {
            if let Ok(s) = sessions.GetAt(i) {
                if let Ok(id) = s.SourceAppUserModelId() {
                    let id_str = id.to_string();
                    // println!("Debug: Session {}: {}", i, id_str);
                    if id_str.to_lowercase().contains("spotify") {
                        // println!("Debug: Match found!");
                        target_session = Some(s);
                        break;
                    }
                }
            }
        }

        // 如果找不到 Spotify，回退到系统当前会话
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
        .unwrap_or(5); // Default to Paused if failed

    let rate = playback_info.as_ref()
        .and_then(|p| p.PlaybackRate().ok())
        .and_then(|r| r.Value().ok())
        .unwrap_or(1.0);

    let title = properties.Title().unwrap_or_default().to_string();
    let artist = properties.Artist().unwrap_or_default().to_string();
    
    if title.is_empty() {
        println!("Warning: SMTC returned empty Title");
    }
    if artist.is_empty() {
        println!("Warning: SMTC returned empty Artist");
    }

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

    println!("Debug: Track info: {} - {}, duration: {}ms", title, artist, duration);

    Ok(format!(
        r#"{{"title": "{}", "artist": "{}", "position": {}, "duration": {}, "status": {}, "rate": {}, "last_updated": {}}}"#,
        title.replace('"', "\\\""), 
        artist.replace('"', "\\\""), 
        position, 
        duration,
        status,
        rate,
        last_updated_ms
    ))
}

//#[tauri::command]
pub async fn fetch_proxy_logic(url: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let res = client.get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    
    res.text().await.map_err(|e| e.to_string())
}

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
        "play" => { session.TryPlayAsync().map_err(|e: windows::core::Error| e.to_string())?.await.map_err(|e: windows::core::Error| e.to_string())?; },
        "pause" => { session.TryPauseAsync().map_err(|e: windows::core::Error| e.to_string())?.await.map_err(|e: windows::core::Error| e.to_string())?; },
        "playpause" => { session.TryTogglePlayPauseAsync().map_err(|e: windows::core::Error| e.to_string())?.await.map_err(|e: windows::core::Error| e.to_string())?; },
        "next" => { session.TrySkipNextAsync().map_err(|e: windows::core::Error| e.to_string())?.await.map_err(|e: windows::core::Error| e.to_string())?; },
        "prev" => { session.TrySkipPreviousAsync().map_err(|e: windows::core::Error| e.to_string())?.await.map_err(|e: windows::core::Error| e.to_string())?; },
        _ => return Err("Unknown command".to_string()),
    };
    
    Ok(())
}

pub async fn start_auth_server_logic() -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:8888").await.map_err(|e| e.to_string())?;
    
    // Accept only one connection
    let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
    
    let mut buffer = [0; 1024];
    let n = socket.read(&mut buffer).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buffer[..n]);
    
    // Extract code from "GET /callback?code=... HTTP/1.1"
    let code = if let Some(start) = request.find("code=") {
        let end = request[start..].find(' ').unwrap_or(request[start..].len()) + start;
        request[start+5..end].to_string()
    } else {
        return Err("No code found".to_string());
    };
    
    // Send response
    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<h1>Success! You can close this tab now.</h1><script>window.close()</script>";
    socket.write_all(response.as_bytes()).await.map_err(|e| e.to_string())?;
    
    Ok(code)
}