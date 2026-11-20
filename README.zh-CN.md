# Spotify Custom Floating Lyrics

简体中文 · [English](README.md)

一个给 **Spotify 桌面版**用的轻量浮动歌词：置顶、透明、可锁定穿透。基于 [Tauri 2](https://tauri.app)（Rust + TypeScript）。

它直接从操作系统读取 Spotify 正在播放的歌曲，从 [LRCLIB](https://lrclib.net) 获取逐行同步歌词，把当前这一句显示在一个悬浮窗里。窗口可以随意拖动，也可以锁定后让鼠标直接穿透。

<p align="center">
  <img src="docs/screenshots/overlay.png" alt="浮动歌词窗口，显示正在播放歌曲的当前歌词" width="820">
</p>

- **不需要绑定 Spotify 账号**，Free 和 Premium 都能直接用。
- **可选登录 Spotify**，用 ISRC 精确匹配歌词。
- **小而原生**：Tauri 应用，不打包 Chromium。

## 功能

- 🎤 实时同步歌词，在两次播放状态更新之间平滑插值
- 🪟 无边框、透明、置顶、可缩放的窗口，拖动即可移动
- 🔒 **锁定模式**：窗口变为鼠标穿透，不挡操作
- ⏯ 悬停显示 上一首 / 播放暂停 / 下一首
- 💾 本地歌词缓存（最近 200 首），并预加载下一首的歌词
- 🔗 可选 Spotify OAuth（PKCE，使用你自己的 Client ID），用于 ISRC 匹配
- 🧰 系统托盘菜单：取消锁定、退出

## 平台支持

| 平台 | 状态 | 获取播放状态的方式 |
|------|------|--------------------|
| Windows 10/11 | ✅ 支持 | 系统媒体传输控件（SMTC），事件推送 |
| macOS | ✅ 支持 | AppleScript 轮询 Spotify.app（500 ms） |
| Linux | 🚧 计划中 | MPRIS / D-Bus（尚未实现：能编译，但不会显示歌词） |

## 安装

目前还没有预编译的发布包，请从源码构建（见[开发](#开发)）。`npm run tauri build` 之后，安装包在 `src-tauri/target/release/bundle/`。

## 使用

1. 打开 Spotify 桌面版并开始播放。
2. 启动本应用。当前歌词以绿色显示，上方是歌名。
3. 鼠标悬停在窗口上会出现控制按钮：

   <img src="docs/screenshots/controls.png" alt="悬停时的歌词窗口，顶部显示控制栏" width="720">

   | 按钮 | 作用 |
   |------|------|
   | 🔗 | 连接 Spotify（可选，见下文） |
   | ⏮ ► ⏭ | 上一首 / 播放暂停 / 下一首 |
   | 🔓 | 锁定窗口（鼠标穿透） |

   窗口本身是透明的，截图里把它放在了深色渐变背景上。

4. 在歌词上**按住拖动**即可移动窗口，字号随窗口高度缩放。
5. **锁定后**窗口不响应鼠标。解锁方法：把鼠标移到窗口顶部中央，点 🔒；或者托盘图标 → **取消锁定**。

### 可选：连接 Spotify 账号

不登录时，按歌名、歌手和时长（±3 秒）在 LRCLIB 搜索歌词。登录后可以通过 Spotify Web API 拿到歌曲的 ISRC 做精确匹配；没有活动播放设备时，也能自动激活一个。

1. 在 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) 创建一个应用。
2. 在应用设置里添加 **Redirect URI**，必须一字不差：

   ```
   http://127.0.0.1:8888/callback
   ```

   Spotify 已不再接受 `localhost`，这里必须写回环地址 `127.0.0.1`。
3. 复制应用的 **Client ID**。
4. 在歌词窗口点 🔗，粘贴 Client ID，然后在浏览器里同意授权。

弹窗留空即进入「无 Spotify 模式」，之后随时可以再点 🔗 配置。只需要 Client ID：登录走 PKCE，不需要 Client Secret。令牌保存在本机的 WebView 存储里。

申请的权限：`user-read-playback-state`、`user-modify-playback-state`、`user-read-currently-playing`、`playlist-read-private`。

## 自定义外观

暂时没有设置面板，外观都在 [`src/styles.css`](src/styles.css)：

- `#lrc-content`：歌词颜色（默认 Spotify 绿 `#1DB954`）与字号
- `#info-row`：歌名/歌手那一行
- `#app:hover`：悬停时的半透明背景

改完重新构建，或者开着 `npm run tauri dev` 实时看效果。

## 常见问题

### Windows：检测不到播放

1. 在 Spotify 里打开 **设置 → 显示 → 使用媒体键时显示桌面叠加层**。Spotify 要打开这个选项才会接入 SMTC。
2. 支持的 Spotify 版本：官网安装版（`Spotify.exe`）和微软商店版（`SpotifyAB.SpotifyMusic_…`）。Scoop、Chocolatey 或便携版可能使用不同的 AUMID，可以用诊断工具检查：

   ```bash
   cd src-tauri
   cargo run --features windows-diagnostics --bin diagnose_smtc
   ```

3. 报错 `0x80010002` 表示系统媒体服务繁忙。应用会自动退避重试；如果一直出现，重启 Spotify 或电脑。

### macOS：检测不到播放

1. 确认运行的是 Spotify.app，而不是网页版。
2. 第一次运行时 macOS 会询问是否允许本应用控制 Spotify，请选择允许。如果之前拒绝了，到 **系统设置 → 隐私与安全性 → 自动化** 里重新打开。

### 找不到歌词或歌词不对

- LRCLIB 由社区维护，有些歌确实没有同步歌词，欢迎去 [贡献](https://lrclib.net)。
- 连接 Spotify（见上文）匹配最准。
- 想强制重新获取，删掉缓存目录里对应歌曲的文件：
  - Windows：`%APPDATA%\com.lyrics.app\lyrics\`
  - macOS：`~/Library/Application Support/com.lyrics.app/lyrics/`

## 工作原理

```
┌──────────────────────────────┐
│ TypeScript 前端              │  同步循环 → 锚点法推算播放进度
│  LyricManager / ControlQueue │  → 二分查找当前 LRC 行
├──────────────────────────────┤
│ Tauri 命令（Rust）           │  get_spotify_track · spotify_control · fetch_proxy
│                              │  start_auth_server · set_lock_state
├──────────────────────────────┤
│ 平台 worker                  │  Windows：SMTC（smtc_worker.rs）
│                              │  macOS：AppleScript（macos_worker.rs）
└──────────────────────────────┘
```

歌词查找顺序：内存缓存 → 磁盘缓存 → LRCLIB 按 ISRC（已登录时）→ LRCLIB 搜索并按时长匹配。SMTC 繁忙时会拒绝调用，所以播放控制指令走一个带防抖和指数退避的队列。背景分析见 [`TECHNICAL_REPORT.md`](TECHNICAL_REPORT.md)。

## 开发

### 环境要求

- [Rust](https://rustup.rs)（stable）
- [Node.js](https://nodejs.org) LTS
- Tauri 的平台依赖，见 [Tauri prerequisites](https://tauri.app/start/prerequisites/)（Windows 需要 WebView2，macOS 需要 Xcode Command Line Tools）
- Spotify 桌面版

### 常用命令

```bash
npm install
npm run tauri dev      # 开发运行（热重载）
npm run tauri build    # 打包安装程序
```

```bash
npx tsc --noEmit                  # 前端类型检查
npm test -- --run                 # 单元测试（Vitest）
cd src-tauri && cargo check       # Rust 检查
```

开发者控制台里输入 `runPressureTest()` 可以对控制队列做压力测试。

### 目录结构

```
src/
  main.ts                 UI、同步循环、渲染循环
  styles.css              外观
  services/
    LyricManager.ts       歌词查找、缓存、预加载
    SpotifyAuth.ts        可选 OAuth（PKCE）与 Web API 调用
    ControlQueue.ts       带防抖和重试的播放控制
    LyricUIState.ts       UI 状态机
src-tauri/src/
  main.rs                 窗口、托盘、锁定区域鼠标检测
  lib.rs                  Tauri 命令、macOS AppleScript
  smtc_worker.rs          Windows SMTC 监听
  macos_worker.rs         macOS 轮询 worker
  bin/                    Windows 诊断工具
```

## 参与贡献

欢迎提 issue 和 PR。最需要的是 Linux（MPRIS）支持和设置面板。提 PR 前请先跑一遍上面的类型检查、单元测试和 `cargo check`。

## 致谢

- 歌词来自 [LRCLIB](https://lrclib.net)。
- 本项目与 Spotify AB 无关，也未获其认可。

## 许可证

[MIT](LICENSE)
