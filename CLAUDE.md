# Spotify Custom Floating Lyrics

Tauri 2.x (Rust + TypeScript) 浮动歌词应用。跨平台：Windows / macOS / Linux (planned).

## 架构概览

- **前端**：TypeScript，通过 Tauri event 接收 `smtc-update` 更新歌词
- **后端**：Rust，平台专属 media worker + 跨平台 Tauri commands

### 平台专属模块

| 平台 | 模块 | 原理 |
|------|------|------|
| Windows | `smtc_worker.rs` | Windows SMTC 事件订阅（推送式） |
| macOS | `macos_worker.rs` | AppleScript 轮询 Spotify.app（500ms） |
| Linux/Other | lib.rs fallback | 返回 "Platform not supported" 错误，不阻塞编译 |

### Tauri Commands（跨平台）

- `get_spotify_track` → 单次拉取当前播放信息
- `fetch_proxy(url)` → HTTP 代理请求（绕过 CORS，10s 超时）
- `spotify_control(command)` → 播放控制（play/pause/next/prev）
- `start_auth_server` → Spotify OAuth 回调服务器（120s 超时）
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

## 开发命令

```bash
npm install
npm run tauri dev
```

### 编译检查

```bash
# Rust (在 src-tauri/ 下)
cargo check

# TypeScript (项目根目录)
npx tsc --noEmit
```

## macOS 关键配置

### 透明窗口

macOS 透明必须同时满足两个条件：

1. **`tauri.conf.json`** — `"macOSPrivateApi": true`（在 `app` 节点下）
2. **`Cargo.toml`** — tauri features 添加 `"macos-private-api"`

缺少任何一个都会导致 WKWebView 绘制白色背景（即使 `transparent: true` 和 CSS `background: transparent` 已设置）。

### AppleScript 轮询

- macOS worker 通过 `osascript` 调用 AppleScript 轮询 Spotify（500ms）
- AppleScript 脚本定义在 `lib.rs` 的 `MACOS_POLL_SCRIPT` 常量，`macos_worker.rs` 和 `get_spotify_track` 共用
- Spotify.app AppleScript: `player position`（秒）× 1000 = ms；`duration of current track` 已是 ms
- 数据用 `|||` 分隔：`status|||position|||duration|||title|||artist`
- `last_updated` 使用 `SystemTime::now()`（与 Windows SMTC 原生时间戳不同，但对前端锚点算法等效）
- 锁区域鼠标穿透检测仅 Windows 实现；macOS 通过托盘菜单"取消锁定"

## Linux / 其他平台

`lib.rs` 中有 `#[cfg(not(any(target_os = "windows", target_os = "macos")))]` 的 fallback stub，`get_spotify_track` 和 `spotify_control` 返回 `Err("Platform not supported")`，不影响编译。未来计划实现 MPRIS / D-Bus。

## Windows 特有说明

- `windows` crate 是 Windows-only 依赖（`target.'cfg(target_os = "windows")'.dependencies`）
- `smtc_worker.rs` 中的事件 handler **不能**在闭包里 hold session 的 clone（COM 引用循环）。需要从 `state.current_session` 动态获取
- main.rs 中锁区域鼠标穿透检测用 `#[cfg(target_os = "windows")]` 包裹
- `GetCursorPos` 失败时 `continue` 跳过本轮（不再静默使用 (0,0)）
- 锁区域宽高 clamp 到窗口尺寸：`lock_zone_width.min(ww)`

### 诊断工具（仅 Windows）

```bash
cargo run --features windows-diagnostics --bin diagnose_smtc
cargo run --features windows-diagnostics --bin mock_spotify_session
```

## 已知 Bug 修复记录

| 问题 | 修复 |
|------|------|
| smtc_worker COM 引用循环 | handler 不从闭包持有 session，改为从 state 动态获取 |
| main.rs .unwrap() panic | `set_ignore_cursor_events` 改用 `let _ =` |
| main.rs GetCursorPos 静默失败 | 检查返回值，失败时 continue |
| main.rs 线程浪费 (macOS) | 移除 `thread::spawn(\|\| {})`，改用 `#[cfg]` 条件编译导入 |
| lib.rs Linux 编译失败 | 添加 fallback stub |
| lib.rs AppleScript 重复定义 | 提取为 `MACOS_POLL_SCRIPT` 常量共享 |
| lib.rs HTTP/OAuth 无超时 | reqwest 10s 超时，OAuth accept 120s 超时 |
| lib.rs status 类型不一致 | i64 → i32 统一 |
| Cargo.toml 多余 crate-type | 移除 staticlib/cdylib，只保留 rlib |
| main.ts Tauri listen 泄漏 | 存储 unlisten，beforeunload 清理 |
| main.ts DOM listener 泄漏 | 提取命名函数，beforeunload 清理 |
| main.ts fetchAndParseLyrics 竞态 | fetchId 校验前置 |
| main.ts as boolean 不安全 | 改用 Boolean() |
| main.ts parseInt 缺 radix | 加 10 |
| main.ts rAF 未取消 | 存储 rafHandle 并在清理时 cancelAnimationFrame |
| main.ts Toast 竞态 | 用 toastActive 标志替代字符串前缀检测 |
| main.ts 重复 SpotifyAuth.init() | 移除启动时的冗余调用 |
| LyricManager saveCacheIndex 竞态 | 加 await |
| LyricManager Promise 反模式 | 用 Promise.race() 替代 new Promise(async ...) |
| LyricUIState setLrcLines([]) 残留 | 显式设为 IDLE |
| ControlQueue push 误导 | 注释标明 fire-and-forget |
| SpotifyAuth parseInt 缺 radix | 加 10 |
| SpotifyAuth 204 死代码 | 204 时调 activateFirstDevice（Spotify 204=无活动设备） |
| SpotifyAuth btoa 栈溢出风险 | 用 for 循环替代 ...spread |
| macOS 透明白底 | 启用 macOSPrivateApi + macos-private-api feature |
