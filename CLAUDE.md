# Spotify Custom Floating Lyrics

Tauri 2.x (Rust + TypeScript) 浮动歌词应用。

## 架构概览

- **前端**：TypeScript，通过 Tauri event 接收 `smtc-update` 更新歌词
- **后端**：Rust，平台专属 media worker + 跨平台 Tauri commands

### 平台专属模块

| 平台 | 模块 | 原理 |
|------|------|------|
| Windows | `smtc_worker.rs` | Windows SMTC 事件订阅（推送式） |
| macOS | `macos_worker.rs` | AppleScript 轮询 Spotify.app（500ms） |

### Tauri Commands（跨平台）

- `get_spotify_track` → 单次拉取当前播放信息
- `fetch_proxy(url)` → HTTP 代理请求（绕过 CORS）
- `spotify_control(command)` → 播放控制（play/pause/next/prev）
- `start_auth_server` → Spotify OAuth 回调服务器
- `set_lock_state(locked)` → 窗口点击穿透锁定

### 事件格式（`smtc-update`）

```typescript
{
  title: string,
  artist: string,
  status: number,    // 4=Playing, 5=Paused
  position: number,  // ms
  duration: number,  // ms
  last_updated: number // unix timestamp ms
}
```

## 平台编译注意事项

- `windows` crate 是 Windows-only 依赖（`[target.'cfg(target_os = "windows")'.dependencies]`）
- `smtc_worker.rs` 顶部有 `#![cfg(target_os = "windows")]`
- `macos_worker.rs` 顶部有 `#![cfg(target_os = "macos")]`
- main.rs 中 Windows 专用的鼠标追踪循环用 `#[cfg(target_os = "windows")]` 包裹

## 诊断工具（仅 Windows）

```bash
# 需要启用 feature 才能编译
cargo run --features windows-diagnostics --bin diagnose_smtc
cargo run --features windows-diagnostics --bin mock_spotify_session
```

## macOS 特有说明

- macOS worker 通过 `osascript` 调用 AppleScript 轮询 Spotify
- Spotify.app AppleScript: `player position`（秒）× 1000 = ms；`duration of current track` 已是 ms
- 锁区域鼠标穿透检测目前仅 Windows 实现；macOS 可通过托盘菜单"取消锁定"

## 开发

```bash
npm install
npm run tauri dev
```
