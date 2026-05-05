import "./styles.css"; // 引入全局样式文件
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { LyricManager } from "./services/LyricManager";
import { SpotifyAuth } from "./services/SpotifyAuth";
import { ControlQueue, DEFAULT_CONTROL_CONFIG } from "./services/ControlQueue";
import { LyricUIState, SearchStatus } from "./services/LyricUIState";
import { PressureTest } from "./services/PressureTest";

console.log("Main.ts loaded and starting...");

// 暴露测试工具到全局对象
(window as any).runPressureTest = () => PressureTest.run();
console.log("提示: 在控制台输入 'runPressureTest()' 可运行压力测试");

// ============================================================================
// 1. 初始化与全局变量
// ============================================================================

// 初始化歌词管理器（包含缓存目录检查等）
LyricManager.init();

// 获取 UI 状态管理器单例实例
const uiState = LyricUIState.getInstance();

// 强力正则：兼容 [00:12] [00:12.3] [00:12.34] [00:12.345] 等多种时间戳格式
const LRC_REGEX = /\[(\d+):(\d+)(?:[:.](\d+))?\](.*)/;

// 获取 Tauri 窗口实例
const appWindow = getCurrentWindow();
const appElement = document.getElementById('app');

// 歌词偏移量（毫秒），用于手动微调
let lyricOffset = 0; 

// --- 播放状态与平滑插值相关变量 ---
let isPlaying = false;        // 是否正在播放
let lastAnchorPosition = 0;   // 上一次同步时的进度位置 (ms)
let lastAnchorTime = 0;       // 上一次同步时的系统时间戳 (ms)
let playbackSpeed = 1.0;      // 播放速率

// --- 渲染与并发控制 ---
let lastFetchId = 0;          // 请求 ID，用于废弃过期的异步请求
let lastDisplayedLineIndex = -1; // 上一次渲染的歌词行索引，用于防抖
let lastRenderPos = 0;        // 上一次渲染的时间位置
let hasPrefetched = false;    // 防止对同一首歌重复预加载

// ============================================================================
// 2. 交互事件处理 (拖拽、锁定、双击)
// ============================================================================

// Track cleanup handles for event listeners
const unlistenFns: (() => void)[] = [];

/**
 * 自定义拖拽逻辑 (替代 data-tauri-drag-region)
 * 允许在非交互区域拖动窗口，但在锁定模式下禁用
 */
const onMouseDown = async (e: MouseEvent) => {
  // 如果点击的是按钮、输入框或链接，不触发拖拽
  const target = e.target as HTMLElement;
  if (['BUTTON', 'INPUT', 'A'].includes(target.tagName) || target.closest('button')) {
    return;
  }
  
  // 锁定状态下禁止拖拽
  if (uiState.isLocked) {
      e.preventDefault(); 
      return;
  }

  // 只有鼠标左键点击才触发拖拽
  if (e.button === 0) {
    await appWindow.startDragging();
  }
};
document.addEventListener('mousedown', onMouseDown);

/**
 * 监听来自 Rust 后端的锁定状态变更事件
 * (例如通过系统托盘操作)
 */
listen('lock-status', async (event) => {
  const locked = Boolean(event.payload);
  uiState.setLocked(locked);
  
  if (locked) {
    appElement?.classList.add('locked');
    appElement?.removeAttribute('data-tauri-drag-region');
    try { await appWindow.setIgnoreCursorEvents(true); } catch (e) { console.error(e); }
  } else {
    appElement?.classList.remove('locked');
    try { await appWindow.setIgnoreCursorEvents(false); } catch (e) { console.error(e); }
    console.log("窗口已解锁");
  }
}).then((unlisten) => { unlistenFns.push(unlisten); });

/**
 * 监听 Rust 发来的鼠标区域状态 (整个窗口)
 * 用于在锁定模式下显示半透明背景等提示
 */
listen('hover-window', (event) => {
  const inWindow = Boolean(event.payload);
  if (uiState.isLocked) {
    if (inWindow) {
      appElement?.classList.add('mouse-in');
    } else {
      appElement?.classList.remove('mouse-in');
    }
  }
}).then((unlisten) => { unlistenFns.push(unlisten); });

/**
 * 监听 Rust 发来的“解锁区域”悬停事件 (窗口顶部)
 * 用于在锁定模式下，当鼠标悬停在特定区域时临时允许交互（显示解锁按钮）
 */
listen('hover-lock-zone', (event) => {
  const inLockZone = Boolean(event.payload);
  if (uiState.isLocked) {
    if (inLockZone) {
      appElement?.classList.add('mouse-in-lock');
      appWindow.setIgnoreCursorEvents(false).catch(() => {});
    } else {
      appElement?.classList.remove('mouse-in-lock');
      appWindow.setIgnoreCursorEvents(true).catch(() => {});
    }
  }
}).then((unlisten) => { unlistenFns.push(unlisten); });

/**
 * 拦截双击事件，防止触发默认的全屏/最大化行为
 */
const preventMax = (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  return false;
};
window.addEventListener('dblclick', preventMax, true);
document.getElementById('app')?.addEventListener('dblclick', preventMax, true);

// 收集 DOM listener 清理信息
const domCleanups: (() => void)[] = [
  () => window.removeEventListener('dblclick', preventMax, true),
  () => document.getElementById('app')?.removeEventListener('dblclick', preventMax, true),
  () => document.removeEventListener('mousedown', onMouseDown),
];

// ============================================================================
// 3. Spotify 认证与登录 UI
// ============================================================================

const loginBtn = document.getElementById('spotify-login');
if (loginBtn) {
    // 初始化时检查登录状态
    if (SpotifyAuth.isLoggedIn()) {
        loginBtn.style.color = '#1db954'; // Spotify 品牌绿
        loginBtn.title = "Spotify 已连接";
    }

    // 登录按钮点击事件
    loginBtn.onclick = async () => {
        if (SpotifyAuth.isLoggedIn()) {
            if (!confirm('已连接 Spotify。是否重新登录？')) return;
        }

        let clientId = localStorage.getItem('spotify_client_id');
        if (!clientId) {
            // 引导用户输入 Client ID
            const input = prompt(
                '请输入您的 Spotify Client ID (需要在 developer.spotify.com 创建应用)。\n' +
                '如果不需要 Spotify 集成（歌单、精准控制），请直接点击“取消”或留空以跳过。'
            );
            
            if (input && input.trim().length > 0) {
                clientId = input.trim();
                SpotifyAuth.setClientId(clientId);
            } else {
                // 用户选择跳过，进入“无 Spotify 模式”
                console.log("用户跳过了 Spotify 设置");
                alert("已启用【无 Spotify 模式】。\n仅使用系统媒体中心 (SMTC) 进行歌词匹配。\n如需启用 Spotify 集成，请随时点击左下角链接图标。");
                SpotifyAuth.setClientId('');
                
                // 更新 UI 为禁用状态
                loginBtn.style.opacity = '0.5';
                loginBtn.title = "Spotify 集成已禁用 (点击配置)";
                return;
            }
        }
        
        try {
            loginBtn.innerText = "⏳"; // 显示加载中
            await SpotifyAuth.login();
            alert('Spotify 连接成功！');
            loginBtn.style.color = '#1db954';
            loginBtn.innerText = "🔗";
            loginBtn.title = "Spotify 已连接";
            loginBtn.style.opacity = '1.0';
        } catch (e) {
            alert('登录失败: ' + e);
            loginBtn.innerText = "🔗";
            loginBtn.style.color = '';
        }
    };
}

// 启动时如果未配置 Client ID，设置按钮为半透明
if (!SpotifyAuth.hasClientId()) {
    const loginBtn = document.getElementById('spotify-login');
    if (loginBtn) {
        loginBtn.style.opacity = '0.5';
        loginBtn.title = "Spotify 集成已禁用 (点击配置)";
    }
}

// ============================================================================
// 4. 播放控制逻辑 (上一首、播放/暂停、下一首)
// ============================================================================

// 状态机配置：定义同步频率和退避策略
const CONFIG = {
    SYNC: {
        INITIAL_INTERVAL: 1000, // 初始同步间隔 1s
        MAX_INTERVAL: 10000,    // 最大同步间隔 10s
        BACKOFF_FACTOR: 1.5,    // 退避因子
        BUSY_THRESHOLD: 3000,
        CIRCUIT_BREAKER_THRESHOLD: 3
    },
    CONTROL: DEFAULT_CONTROL_CONFIG
};

// 实例化控制队列
const controlQueue = new ControlQueue(CONFIG.CONTROL);

/**
 * 安全执行控制命令
 * 将命令推入队列，避免并发冲突
 */
async function safeControl(cmd: string) {
    await controlQueue.push(cmd);
}

// 绑定控制按钮事件
const onPrevClick = (e: Event) => { e.stopPropagation(); safeControl('prev'); };
const onPlayPauseClick = (e: Event) => { e.stopPropagation(); safeControl('playpause'); };
const onNextClick = (e: Event) => { e.stopPropagation(); safeControl('next'); };

document.getElementById('prev')?.addEventListener('click', onPrevClick);
document.getElementById('play-pause')?.addEventListener('click', onPlayPauseClick);
document.getElementById('next')?.addEventListener('click', onNextClick);

domCleanups.push(
  () => document.getElementById('prev')?.removeEventListener('click', onPrevClick),
  () => document.getElementById('play-pause')?.removeEventListener('click', onPlayPauseClick),
  () => document.getElementById('next')?.removeEventListener('click', onNextClick),
);

// 解锁按钮事件
const onUnlockClick = async (e: Event) => {
  e.stopPropagation();
  if (uiState.isLocked) {
    uiState.setLocked(false);
    appElement?.classList.remove('locked');
    try { await appWindow.setIgnoreCursorEvents(false); } catch (err) { console.error(err); }
    invoke('set_lock_state', { locked: false }).catch(console.error);
    console.log("已解锁");
  }
};
document.getElementById('unlock-btn')?.addEventListener('click', onUnlockClick);
domCleanups.push(() => document.getElementById('unlock-btn')?.removeEventListener('click', onUnlockClick));

// 锁定按钮事件
const onLockClick = async (e: Event) => {
  e.stopPropagation();
  
  uiState.setLocked(true);
  appElement?.classList.add('locked');
  
  invoke('set_lock_state', { locked: true }).catch(console.error);

  console.log("已锁定。鼠标悬停窗口顶部中间可解锁。");
  showToast("已锁定：鼠标悬停窗口顶部解锁");
};
document.getElementById('lock-btn')?.addEventListener('click', onLockClick);
domCleanups.push(() => document.getElementById('lock-btn')?.removeEventListener('click', onLockClick));

/**
 * 显示临时的 Toast 提示消息
 * @param msg 消息内容
 */
function showToast(msg: string) {
  const toast = document.getElementById("toast");
  if (toast) {
    toast.innerText = msg;
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, 3000);
  } else {
    const infoEl = document.getElementById("info-row");
    if (infoEl) {
        const original = infoEl.innerText;
        toastActive = true;
        infoEl.innerText = msg;
        setTimeout(() => {
          if (infoEl.innerText === msg) infoEl.innerText = original;
          toastActive = false;
        }, 2000);
    }
  }
}

// ============================================================================
// 5. 核心同步循环 (Sync Loop)
// ============================================================================

/**
 * 同步歌词与播放状态的核心函数
 * 负责调用 Rust 后端获取 SMTC 状态，并更新 UI
 */
async function syncLyrics() {
  try {
    // 从 Rust 后端获取当前媒体状态
    const res = await invoke<string>("get_spotify_track");
    const data = JSON.parse(res);
    const { title, artist, position, duration, status, rate, last_updated } = data; // status: 4=Playing, 5=Paused

    // 更新播放状态
    const now = Date.now();
    const wasPlaying = isPlaying;
    isPlaying = (status === 4);
    
    // 更新播放/暂停按钮图标
    const playPauseBtn = document.getElementById("play-pause");
    if (playPauseBtn) {
        playPauseBtn.innerText = isPlaying ? "❚❚" : "►";
    }

    playbackSpeed = rate || 1.0;

    // --- 锚点同步算法 (Anchor Sync) ---
    // 核心思想：RealStartTime = LastUpdatedTime - Position
    // 当前进度 = Date.now() - RealStartTime
    // 只有在播放状态下才使用锚点算法；暂停时直接使用 position
    
    if (last_updated > 0 && isPlaying) {
        // 计算这首歌的“理论开始时间” (锚点)
        const calculatedAnchor = last_updated - position;
        
        // 只有当锚点发生显著变化时（>500ms，如暂停、拖动、切歌）才更新
        // 这可以平滑由于 API 轮询带来的微小时间抖动
        if (!wasPlaying || Math.abs(calculatedAnchor - lastAnchorTime) > 500) {
             lastAnchorTime = calculatedAnchor;
             lastAnchorPosition = 0; // 对于此算法，基准位置始终为 0
             console.log("Anchor Update (Time Sync):", calculatedAnchor);
        }
    } else {
        // 降级方案：如果没有 last_updated，回退到估算逻辑
        const estimatedPos = wasPlaying ? (lastAnchorPosition + (now - lastAnchorTime) * playbackSpeed) : lastAnchorPosition;
        const diff = position - estimatedPos; 

        // 如果偏差过大，强制重置
        if (!wasPlaying || status !== 4 || Math.abs(diff) > 3000) {
           lastAnchorPosition = position;
           lastAnchorTime = now;
        } else {
           // 小幅修正
           if (diff > 300 || diff < -2000) {
               lastAnchorPosition = position;
               lastAnchorTime = now;
           }
        }
    }

    // 更新歌曲信息显示
    updateInfoDisplay(title, artist);

    // --- 切歌检测 ---
    // 使用 UI State 更新 Track 信息，如果返回 true 说明发生了切歌
    if (uiState.updateTrack(title, artist, duration)) {
      // 标记旧请求作废
      lastFetchId++; 
      lastDisplayedLineIndex = -1; // 重置 UI 过滤器
      lyricOffset = 0; // 重置偏移
      hasPrefetched = false; // 重置预加载标志
      
      // 立即触发歌词获取 (不使用 await，避免阻塞主同步循环)
      fetchAndParseLyrics(title, artist, duration, lastFetchId).catch(console.error);
    }

    // --- 预加载逻辑 ---
    // 当播放进度超过 90% 时，尝试预加载下一首
    if (isPlaying && duration > 0 && (position / duration > 0.9) && !hasPrefetched) {
        hasPrefetched = true;
        LyricManager.prefetchNextSong().catch(console.error);
    }

  } catch (e: any) {
    // 忽略 COM "Message Filter Cancelled" 错误 (0x80010002) - 系统繁忙
    if (e?.toString().includes("0x80010002") || e?.toString().includes("消息筛选器取消了调用")) {
        throw new Error("SMTC_BUSY");
    }

    // 处理 "No Media" 或其他错误
    isPlaying = false;
    updateInfoDisplay("", "");
    
    // 如果没有媒体播放，显示提示
    const lrcEl = document.getElementById("lrc-content");
    if (lrcEl && uiState.lrcLines.length === 0) {
        if (e?.toString().includes("No Media")) {
             lrcEl.innerHTML = `
                 <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center;">
                     <div style="font-size: 16px; margin-bottom: 8px;">等待播放...</div>
                     <div style="font-size: 12px; opacity: 0.6; max-width: 80%;">
                         请在 Spotify 中播放音乐
                     </div>
                 </div>
             `;
        } else {
             lrcEl.innerText = `Error: ${e}`;
        }
    }
  }
}

// ============================================================================
// 6. UI 更新与渲染
// ============================================================================

/**
 * 更新顶部歌曲信息栏
 */
let toastActive = false;
function updateInfoDisplay(title: string, artist: string) {
  const infoEl = document.getElementById("info-row");
  if (!infoEl) return;
  
  if (toastActive) return;

  const combinedText = (title && artist) ? `${title} - ${artist}` : "未在播放";
  if (infoEl.innerText !== combinedText) {
    infoEl.innerText = combinedText;
  }
}

/**
 * 更新歌词显示 (高频调用)
 * 根据当前播放进度计算并显示对应的歌词行
 * @param rawPosition 当前播放进度 (ms)
 */
function updateLyricDisplay(rawPosition: number) {
  const lrcEl = document.getElementById("lrc-content");
  if (!lrcEl) return;

  // 1. 处理加载/搜索状态
  if (uiState.searchStatus === SearchStatus.SEARCHING) {
      lrcEl.innerText = "正在搜索歌词...";
      return;
  }
  
  if (uiState.searchStatus === SearchStatus.NOT_FOUND) {
      lrcEl.innerText = "暂无歌词";
      return;
  }

  if (uiState.lrcLines.length === 0) {
    if (uiState.currentTrack) {
      const fallback = `${uiState.currentTrack.title} - ${uiState.currentTrack.artist}`;
      if (lrcEl.innerText !== fallback) {
        lrcEl.innerText = fallback;
      }
    }
    return;
  }

  // 2. 应用偏移
  const position = rawPosition + lyricOffset;

  // 检测手动回退 (Seek)：如果进度突然回退超过 500ms，重置过滤器
  if (position < lastRenderPos - 500) {
      lastDisplayedLineIndex = -1;
  }
  lastRenderPos = position;

  // 3. 二分查找当前歌词行
  // 找到最后一个 time <= position 的行
  let low = 0;
  let high = uiState.lrcLines.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (uiState.lrcLines[mid].time <= position) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // 4. 单调递增过滤 (防止抖动)
  if (lastDisplayedLineIndex !== -1 && high < lastDisplayedLineIndex) {
      high = lastDisplayedLineIndex;
  }
  lastDisplayedLineIndex = high;

  const currentLine = high >= 0 ? uiState.lrcLines[high] : null;
  
  // 5. 显示逻辑优化
  if (currentLine) {
      // 正常显示歌词
      if (lrcEl.innerText !== currentLine.text) {
        lrcEl.innerText = currentLine.text;
      }
  } else {
      // 关键修复：歌词已找到，但当前进度还没到第一句歌词 (Intro 阶段)
      // 此时不应显示 "正在搜索"，而应显示歌曲信息或 "Intro"
      if (uiState.currentTrack) {
          const introText = `${uiState.currentTrack.title} - ${uiState.currentTrack.artist}`;
          if (lrcEl.innerText !== introText) {
              lrcEl.innerText = introText;
          }
      }
  }
}

/**
 * 异步获取并解析歌词
 */
async function fetchAndParseLyrics(title: string, artist: string, duration: number, fetchId: number) {
  if (fetchId !== lastFetchId) return;

  uiState.setSearchStatus(SearchStatus.SEARCHING);
  uiState.setLrcLines([]);

  try {
    const rawLrc = await LyricManager.getLyrics({
        title,
        artist,
        duration: duration / 1000
    });

    if (fetchId !== lastFetchId) return;

    if (!rawLrc) {
      uiState.setSearchStatus(SearchStatus.NOT_FOUND);
      return;
    }

    // 解析 LRC 格式
    const newLines = rawLrc.split('\n')
      .map(line => {
        const match = line.match(LRC_REGEX);
        if (match) {
          const min = parseInt(match[1], 10);
          const sec = parseInt(match[2], 10);
          let msStr = match[3] || "0";
          if (msStr.length === 1) msStr += "00";
          else if (msStr.length === 2) msStr += "0";
          const ms = parseInt(msStr, 10);
          
          return { 
            time: min * 60000 + sec * 1000 + ms, 
            text: match[4].trim() 
          };
        }
        return null;
      })
      .filter((l): l is {time: number, text: string} => l !== null && l.text !== "")
      .sort((a, b) => a.time - b.time); // 确保按时间排序

    if (fetchId === lastFetchId) {
        if (newLines.length > 0) {
            uiState.setLrcLines(newLines);
            // setLrcLines 会自动设置状态为 FOUND
        } else {
            // 解析后无内容（可能是空 LRC 文件）
            uiState.setSearchStatus(SearchStatus.NOT_FOUND);
        }
    }
  } catch (e) {
    if (fetchId === lastFetchId) {
        console.error(e);
        uiState.setSearchStatus(SearchStatus.ERROR);
    }
  }
}

// ============================================================================
// 7. 渲染循环与主循环
// ============================================================================

/**
 * 渲染循环 (RequestAnimationFrame)
 * 负责高频更新歌词位置，确保视觉流畅
 */
function renderLoop() {
    const now = Date.now();
    let currentPos = lastAnchorPosition;

    if (isPlaying) {
        // 根据系统时间差和播放速率推算当前进度
        currentPos += (now - lastAnchorTime) * playbackSpeed;
    }

    updateLyricDisplay(currentPos);
    rafHandle = requestAnimationFrame(renderLoop);
}

// 启动渲染循环
let rafHandle = requestAnimationFrame(renderLoop);

// 主同步循环控制器
let isMounted = true;
class BackoffController {
    private currentInterval: number;
    
    constructor() {
        this.currentInterval = CONFIG.SYNC.INITIAL_INTERVAL;
    }

    reset() {
        this.currentInterval = CONFIG.SYNC.INITIAL_INTERVAL;
    }

    backoff() {
        this.currentInterval = Math.min(
            this.currentInterval * CONFIG.SYNC.BACKOFF_FACTOR, 
            CONFIG.SYNC.MAX_INTERVAL
        );
    }

    getInterval() {
        return this.currentInterval;
    }
}
const syncBackoff = new BackoffController();

/**
 * 动态轮询循环
 * 控制 syncLyrics 的调用频率
 */
async function syncLoop() {
    if (!isMounted) return;

    // 如果控制队列繁忙，暂停一轮
    if (controlQueue.isBusy()) {
        setTimeout(syncLoop, 500);
        return;
    }

    try {
        await syncLyrics();
        syncBackoff.reset(); // 成功则重置频率
    } catch (e: any) {
        if (e.message === "SMTC_BUSY") {
            syncBackoff.backoff(); // 繁忙则降低频率
        } else {
            // 其他错误也适当延时
            console.error("Sync Error:", e);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    setTimeout(syncLoop, syncBackoff.getInterval());
}

// 启动主循环
syncLoop();

// 页面卸载清理
window.addEventListener('beforeunload', () => {
    isMounted = false;
    controlQueue.setMounted(false);
    cancelAnimationFrame(rafHandle);
    unlistenFns.forEach(fn => fn());
    domCleanups.forEach(fn => fn());
});

// 启动时的连接检查
(async () => {
    if (SpotifyAuth.isLoggedIn()) {
        const active = await SpotifyAuth.checkConnection();
        if (!active) {
            const infoEl = document.getElementById("info-row");
            if (infoEl) infoEl.innerText = "Spotify 未激活 (请在设备上播放)";
        }
    }
})();
