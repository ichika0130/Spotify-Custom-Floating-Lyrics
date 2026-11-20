# Spotify Custom Floating Lyrics

[简体中文](README.zh-CN.md) · English

A lightweight, always-on-top, transparent lyrics overlay for the **Spotify desktop app**, built with [Tauri 2](https://tauri.app) (Rust + TypeScript).

It reads what Spotify is playing straight from the operating system, fetches time-synced lyrics from [LRCLIB](https://lrclib.net), and shows the current line in a floating window. You can drag the window anywhere, or lock it in place and click straight through it.

<p align="center">
  <img src="docs/screenshots/overlay.png" alt="Floating lyrics window showing the current line of the playing song" width="820">
</p>

- **No Spotify account linking required.** Works with Spotify Free and Premium out of the box.
- **Optional Spotify login** improves lyric matching (exact match by ISRC).
- **Small and native.** It's a Tauri app, so it doesn't bundle Chromium.

## Features

- 🎤 Real-time synced lyrics, interpolated smoothly between playback updates
- 🪟 Frameless, transparent, always-on-top, resizable window; drag to move
- 🔒 **Lock mode:** the window becomes click-through so it never gets in the way
- ⏯ Previous / play-pause / next controls on hover
- 💾 Local lyric cache (last 200 songs) plus prefetching of the next track's lyrics
- 🔗 Optional Spotify OAuth (PKCE, your own Client ID) for ISRC-based matching
- 🧰 System tray menu: unlock window, quit

## Platform support

| Platform | Status | How it detects playback |
|----------|--------|-------------------------|
| Windows 10/11 | ✅ Supported | System Media Transport Controls (SMTC), event-driven |
| macOS | ✅ Supported | AppleScript polling of Spotify.app (every 500 ms) |
| Linux | 🚧 Planned | MPRIS / D-Bus (not implemented yet: the app builds but shows no lyrics) |

## Installation

There are no prebuilt releases yet, so build from source (see [Development](#development)). After `npm run tauri build`, installers are written to `src-tauri/target/release/bundle/`.

## Usage

1. Start the Spotify desktop app and play something.
2. Launch Spotify Custom Floating Lyrics. The current line appears in green, with the song title above it.
3. Hover over the window to reveal the controls:

   <img src="docs/screenshots/controls.png" alt="Lyrics window on hover, with the control bar at the top" width="720">

   | Button | Action |
   |--------|--------|
   | 🔗 | Connect Spotify (optional, see below) |
   | ⏮ ► ⏭ | Previous / play-pause / next |
   | 🔓 | Lock the window (click-through) |

   The window itself is transparent. The screenshots show it over a dark gradient.

4. **Drag** anywhere on the lyrics to move the window. The font scales with the window height.
5. **Locked mode:** the window ignores the mouse. To unlock, hover the top-center of the window and click 🔒, or use the tray icon → **取消锁定** (Unlock).

### Optional: connect your Spotify account

Without login, lyrics are found by searching LRCLIB by title, artist and duration (±3 s). Logging in lets the app read the track's ISRC from the Spotify Web API for an exact match, and lets it activate a device when no player is active.

1. Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. In the app's settings, add this **Redirect URI** exactly:

   ```
   http://127.0.0.1:8888/callback
   ```

   Spotify no longer accepts `localhost` here; it has to be the `127.0.0.1` loopback address.
3. Copy the app's **Client ID**.
4. In the lyrics window click 🔗, paste the Client ID, and approve the login in your browser.

Leave the prompt empty to stay in "no-Spotify mode"; you can click 🔗 again at any time. Only the Client ID is needed. The login uses PKCE, so there is no client secret. Tokens are stored locally in the app's WebView storage.

Requested scopes: `user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing`, `playlist-read-private`.

## Customization

There is no settings panel yet; appearance lives in [`src/styles.css`](src/styles.css):

- `#lrc-content`: lyric line color (default Spotify green `#1DB954`) and size
- `#info-row`: the title/artist line
- `#app:hover`: the translucent background shown on hover

Rebuild, or keep `npm run tauri dev` running, to see changes.

## Troubleshooting

### Windows: playback not detected

1. In Spotify, enable **Settings → Display → Show desktop overlay when using media keys**. This is what makes Spotify publish itself to SMTC.
2. Supported Spotify builds: the desktop installer from spotify.com (`Spotify.exe`) and the Microsoft Store version (`SpotifyAB.SpotifyMusic_…`). Scoop, Chocolatey or portable installs may register under a different AUMID. Check with the diagnostic tool:

   ```bash
   cd src-tauri
   cargo run --features windows-diagnostics --bin diagnose_smtc
   ```

3. Error `0x80010002` means the system media service is busy. The app retries with backoff automatically; if it persists, restart Spotify or reboot.

### macOS: playback not detected

1. Make sure Spotify.app (not the web player) is running.
2. On first run macOS asks whether the app may control Spotify. Allow it. If you declined, re-enable it in **System Settings → Privacy & Security → Automation**.

### Lyrics not found, or wrong

- LRCLIB is community-maintained, so some songs simply have no synced lyrics. You can [contribute them](https://lrclib.net).
- Connecting Spotify (above) gives the most accurate matches.
- To force a re-fetch, delete the song's file from the cache folder:
  - Windows: `%APPDATA%\com.lyrics.app\lyrics\`
  - macOS: `~/Library/Application Support/com.lyrics.app/lyrics/`

## How it works

```
┌──────────────────────────────┐
│ TypeScript frontend          │  sync loop → anchor-based position interpolation
│  LyricManager / ControlQueue │  → binary search for the current LRC line
├──────────────────────────────┤
│ Tauri commands (Rust)        │  get_spotify_track · spotify_control · fetch_proxy
│                              │  start_auth_server · set_lock_state
├──────────────────────────────┤
│ Platform workers             │  Windows: SMTC (smtc_worker.rs)
│                              │  macOS:   AppleScript (macos_worker.rs)
└──────────────────────────────┘
```

Lyric lookup order: in-memory cache → on-disk cache → LRCLIB by ISRC (if logged in) → LRCLIB search matched by duration. Playback commands go through a queue with debounce and exponential backoff, because SMTC rejects calls while it is busy. See [`TECHNICAL_REPORT.md`](TECHNICAL_REPORT.md) (Chinese) for the background.

## Development

### Prerequisites

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) LTS
- Tauri's platform requirements: see [Tauri prerequisites](https://tauri.app/start/prerequisites/) (WebView2 on Windows, Xcode Command Line Tools on macOS)
- The Spotify desktop app

### Commands

```bash
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # build release installers
```

```bash
npx tsc --noEmit                  # type-check the frontend
npm test -- --run                 # unit tests (Vitest)
cd src-tauri && cargo check       # check the Rust side
```

In the dev console, `runPressureTest()` runs a stress test of the control queue.

### Project layout

```
src/
  main.ts                 UI, sync loop, render loop
  styles.css              appearance
  services/
    LyricManager.ts       lookup, caching, prefetch
    SpotifyAuth.ts        optional OAuth (PKCE) and Web API calls
    ControlQueue.ts       debounced, retrying playback commands
    LyricUIState.ts       UI state machine
src-tauri/src/
  main.rs                 window, tray, lock-zone mouse tracking
  lib.rs                  Tauri commands, macOS AppleScript
  smtc_worker.rs          Windows SMTC listener
  macos_worker.rs         macOS polling worker
  bin/                    Windows diagnostic tools
```

## Contributing

Issues and pull requests are welcome. The most wanted features are Linux (MPRIS) support and a settings panel. Before opening a PR, please run the type check, unit tests and `cargo check` listed above.

## Acknowledgements

- Lyrics provided by [LRCLIB](https://lrclib.net).
- This project is not affiliated with or endorsed by Spotify AB.

## License

[MIT](LICENSE)
