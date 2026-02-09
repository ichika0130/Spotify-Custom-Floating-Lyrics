# Spotify Lyrics

A lightweight Spotify lyrics application built with Tauri and React.

## Features

- Real-time lyrics synchronization
- Works with Spotify Free and Premium
- No login required (Optional Mode)
- Support for desktop and Windows Store versions of Spotify

## Development

### Prerequisites

- Rust (latest stable)
- Node.js (LTS)
- Spotify Desktop App

### Setup

```bash
npm install
npm run tauri dev
```

## 故障排查 (Troubleshooting)

### Spotify 播放状态无法获取 (Spotify Playback Not Detected)

如果应用无法显示当前播放的歌曲，请检查以下几点：

1. **系统媒体覆盖 (SMTC)**
   确保 Spotify 设置中开启了“显示桌面浮窗” (Show desktop overlay when using media keys) 或类似系统媒体集成选项。
   
2. **应用 ID (AUMID) 匹配**
   本应用通过 Windows 系统媒体传输控制 (SMTC) 监听 Spotify。支持以下版本：
   - 桌面版 (官网下载): `Spotify.exe`
   - Windows Store 版: `SpotifyAB.SpotifyMusic_...`
   
   如果您的 Spotify 是通过其他方式安装（如 Scoop, Chocolatey 或便携版），可能会有不同的 AUMID。
   请尝试运行 `diagnose_smtc` 工具查看您的 Spotify 会话 ID：
   ```bash
   cd src-tauri
   cargo run --bin diagnose_smtc
   ```

3. **SMTC 诊断**
   如果遇到问题，可以运行诊断工具查看系统是否能检测到 Spotify 会话：
   ```bash
   # 在项目根目录
   cd src-tauri
   cargo run --bin diagnose_smtc
   ```
   如果输出中包含 `AUMID: Spotify.exe` 或类似项，说明系统识别正常。如果报错 `0x80010002`，可能是系统服务繁忙，请重试或重启电脑。
