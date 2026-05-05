# Spotify Custom Floating Lyrics

A cross-platform floating lyrics overlay for Spotify, built with Tauri 2.x (Rust + TypeScript).

## Supported Platforms

| Platform | Status | Method |
|----------|--------|--------|
| Windows  | Full   | SMTC event subscription (push-based) |
| macOS    | Full   | AppleScript polling (500ms) |
| Linux    | Planned | MPRIS / D-Bus |

## Features

- Real-time lyrics synchronization with Spotify playback
- Always-on-top floating window with transparent background
- Works with Spotify Free and Premium
- Lock mode: click-through window for non-intrusive overlay
- Customizable lyrics appearance (color, size, alignment)
- LRC cache — remembers lyrics for previously played songs
- Playback controls (play/pause, next, previous)
- Optional Spotify OAuth login for enhanced features

## Architecture

```
┌──────────────────────┐
│   TypeScript Frontend │  ← smtc-update event → lyrics display
├──────────────────────┤
│   Tauri Commands      │  get_spotify_track / spotify_control / fetch_proxy
├──────────────────────┤
│   Platform Workers    │
│   Windows: SMTC       │
│   macOS:   AppleScript│
└──────────────────────┘
```

### Event Format (`smtc-update`)

```typescript
{
  title: string,
  artist: string,
  status: number,     // 4 = Playing, 5 = Paused
  position: number,   // ms
  duration: number,   // ms
  last_updated: number // unix timestamp ms
}
```

## Development

### Prerequisites

- [Rust](https://rustup.rs) (latest stable)
- [Node.js](https://nodejs.org) (LTS)
- Spotify Desktop App

### Setup

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

## Troubleshooting

### Windows — Spotify Playback Not Detected

1. Ensure Spotify's "Show desktop overlay when using media keys" is enabled in settings.
2. This app listens via Windows System Media Transport Controls (SMTC). Supported versions:
   - Desktop (from spotify.com): `Spotify.exe`
   - Microsoft Store: `SpotifyAB.SpotifyMusic_...`

   If your Spotify was installed via Scoop, Chocolatey, or portable mode, it may have a different AUMID. Run the diagnostic tool:

   ```bash
   cd src-tauri
   cargo run --bin diagnose_smtc
   ```

3. If the diagnostic shows error `0x80010002`, the system service may be busy — retry or restart your computer.

### macOS — Spotify Playback Not Detected

1. Ensure Spotify.app is running. The app polls Spotify via AppleScript every 500ms.
2. Grant accessibility permissions if prompted — AppleScript requires it to query Spotify.
3. Lock mode shows a translucent unlock button at the top of the window (or use the tray menu "取消锁定").

## License

MIT
