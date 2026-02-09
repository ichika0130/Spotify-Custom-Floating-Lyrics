import "./styles.css"; // 直接导入样式
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { LyricManager } from "./services/LyricManager";
import { SpotifyAuth } from "./services/SpotifyAuth";
import { ControlQueue, DEFAULT_CONTROL_CONFIG } from "./services/ControlQueue";

console.log("Main.ts loaded and starting...");

// 初始化歌词管理器
LyricManager.init();

// 强力正则：兼容 [00:12] [00:12.3] [00:12.34] [00:12.345] 等格式
const LRC_REGEX = /\[(\d+):(\d+)(?:[:.](\d+))?\](.*)/;
const appWindow = getCurrentWindow();
const appElement = document.getElementById('app');
let isLocked = false;
let lrcLines: { time: number; text: string }[] = [];
let currentTrackId = "";
let lyricOffset = 0; // 歌词偏移量（毫秒）

// 播放状态与平滑插值
let isPlaying = false;
let lastAnchorPosition = 0;
let lastAnchorTime = 0;
let playbackSpeed = 1.0; 


// 并发控制：防止多次 fetch 互相覆盖
let lastFetchId = 0;
let lastDisplayedLineIndex = -1;
let lastRenderPos = 0;
let hasPrefetched = false; // 防止重复预加载

// 替代 data-tauri-drag-region 的手动拖拽逻辑
document.addEventListener('mousedown', async (e) => {
  // 如果点击的是按钮或交互元素，不触发拖拽
  const target = e.target as HTMLElement;
  if (['BUTTON', 'INPUT', 'A'].includes(target.tagName) || target.closest('button')) {
    return;
  }
  
  // 锁定状态下禁止拖拽
  if (isLocked) {
      e.preventDefault(); 
      return;
  }

  // 只有左键点击触发拖拽
  if (e.button === 0) {
    await appWindow.startDragging();
  }
});

// 监听来自 Rust 托盘的解锁信号
listen('lock-status', async (event) => {
  const locked = event.payload as boolean;
  isLocked = locked;
  if (locked) {
    appElement?.classList.add('locked');
    appElement?.removeAttribute('data-tauri-drag-region');
    await appWindow.setIgnoreCursorEvents(true);
  } else {
    appElement?.classList.remove('locked');
    // 恢复拖拽区域
    // appElement?.setAttribute('data-tauri-drag-region', '');
    await appWindow.setIgnoreCursorEvents(false);
    console.log("窗口已解锁");
  }
});

// 监听 Rust 发来的鼠标区域状态
listen('hover-window', (event) => {
  const inWindow = event.payload as boolean;
  // console.log("Hover Window:", inWindow); // Debug
  if (isLocked) {
    if (inWindow) {
      appElement?.classList.add('mouse-in');
    } else {
      appElement?.classList.remove('mouse-in');
    }
  }
});

listen('hover-lock-zone', (event) => {
  const inLockZone = event.payload as boolean;
  if (isLocked) {
    if (inLockZone) {
      appElement?.classList.add('mouse-in-lock');
    } else {
      appElement?.classList.remove('mouse-in-lock');
    }
  }
});

// 拦截双击，防止全屏
// 除了 window 级别，还要在 app 级别拦截，因为 data-tauri-drag-region 可能会有些特殊行为
const preventMax = (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  return false;
};
window.addEventListener('dblclick', preventMax, true);
document.getElementById('app')?.addEventListener('dblclick', preventMax, true);

// 绑定 Spotify 登录按钮
const loginBtn = document.getElementById('spotify-login');
if (loginBtn) {
    // 检查登录状态并更新图标/样式
    if (SpotifyAuth.isLoggedIn()) {
        loginBtn.style.color = '#1db954'; // Spotify Green
        loginBtn.title = "Spotify Connected";
    }

    loginBtn.onclick = async () => {
        if (SpotifyAuth.isLoggedIn()) {
            if (!confirm('已连接 Spotify。是否重新登录？')) return;
        }

        let clientId = localStorage.getItem('spotify_client_id');
        if (!clientId) {
            // 提供“跳过”选项
            const input = prompt(
                '请输入您的 Spotify Client ID (需要在 developer.spotify.com 创建应用)。\n' +
                '如果不需要 Spotify 集成（歌单、精准控制），请直接点击“取消”或留空以跳过。'
            );
            
            if (input && input.trim().length > 0) {
                clientId = input.trim();
                SpotifyAuth.setClientId(clientId);
            } else {
                // 用户选择跳过
                console.log("User skipped Spotify setup.");
                alert("已启用【无 Spotify 模式】。\n仅使用系统媒体中心 (SMTC) 进行歌词匹配。\n如需启用 Spotify 集成，请随时点击左下角链接图标。");
                // 确保清除旧 ID（如果有）
                SpotifyAuth.setClientId('');
                
                // 更新 UI 状态
                loginBtn.style.opacity = '0.5';
                loginBtn.title = "Spotify Integration Disabled (Click to Setup)";
                return;
            }
        }
        
        try {
            loginBtn.innerText = "⏳";
            await SpotifyAuth.login();
            alert('Spotify 连接成功！');
            loginBtn.style.color = '#1db954';
            loginBtn.innerText = "🔗";
            loginBtn.title = "Spotify Connected";
            loginBtn.style.opacity = '1.0';
        } catch (e) {
            alert('登录失败: ' + e);
            loginBtn.innerText = "🔗";
            loginBtn.style.color = '';
            // 如果登录失败，保留 ID 以便重试，或者清除？
            // 这里保留 ID，方便用户检查是否输入错误，但如果 ID 格式明显错误可能导致死循环
        }
    };
}

// 启动时根据 Client ID 状态初始化 UI
if (!SpotifyAuth.hasClientId()) {
    const loginBtn = document.getElementById('spotify-login');
    if (loginBtn) {
        loginBtn.style.opacity = '0.5';
        loginBtn.title = "Spotify Integration Disabled (Click to Setup)";
    }
}

// 状态机配置
const CONFIG = {
    SYNC: {
        INITIAL_INTERVAL: 1000,
        MAX_INTERVAL: 10000,
        BACKOFF_FACTOR: 1.5,
        BUSY_THRESHOLD: 3000,
        CIRCUIT_BREAKER_THRESHOLD: 3
    },
    CONTROL: DEFAULT_CONTROL_CONFIG
};

class BackoffController {
    private currentInterval: number;
    private consecutiveWebAPIFailures: number = 0;
    
    constructor() {
        this.currentInterval = CONFIG.SYNC.INITIAL_INTERVAL;
    }

    reset() {
        if (this.currentInterval !== CONFIG.SYNC.INITIAL_INTERVAL) {
            this.currentInterval = CONFIG.SYNC.INITIAL_INTERVAL;
            console.log(`SMTC recovered, interval reset to ${this.currentInterval}ms`);
        }
        this.consecutiveWebAPIFailures = 0;
    }

    backoff() {
        const old = this.currentInterval;
        this.currentInterval = Math.min(
            this.currentInterval * CONFIG.SYNC.BACKOFF_FACTOR, 
            CONFIG.SYNC.MAX_INTERVAL
        );
        if (old !== this.currentInterval) {
            console.warn(`SMTC Busy: Backing off ${old}ms -> ${this.currentInterval}ms`);
        }
    }

    recordWebAPIFailure() {
        this.consecutiveWebAPIFailures++;
        return this.consecutiveWebAPIFailures;
    }

    getInterval() {
        return this.currentInterval;
    }
}

const syncBackoff = new BackoffController();
let isMounted = true;

const controlQueue = new ControlQueue(CONFIG.CONTROL);

// 页面卸载时取消所有异步操作
window.addEventListener('beforeunload', () => {
    isMounted = false;
    controlQueue.setMounted(false);
    // 可以在这里调用 Rust 侧的清理命令（如果有）
    console.log("Page unloading, stopping loops.");
});

// 辅助函数：带重试与强制重置的控制命令
async function safeControl(cmd: string) {
    await controlQueue.push(cmd);
}

// 启动时的连接检查
(async () => {
    SpotifyAuth.init();
    if (SpotifyAuth.isLoggedIn()) {
        const active = await SpotifyAuth.checkConnection();
        if (!active) {
            const infoEl = document.getElementById("info-row");
            if (infoEl) infoEl.innerText = "Spotify 未激活 (请在设备上播放)";
        }
    }
})();


document.getElementById('prev')?.addEventListener('click', (e) => {
  e.stopPropagation();
  safeControl('prev');
});

document.getElementById('play-pause')?.addEventListener('click', (e) => {
  e.stopPropagation();
  safeControl('playpause');
});

document.getElementById('next')?.addEventListener('click', (e) => {
  e.stopPropagation();
  safeControl('next');
});

/* Delay 按钮已移除
// 歌词偏移调整
document.getElementById('offset-minus')?.addEventListener('click', (e) => {
  e.stopPropagation();
  lyricOffset -= 500;
  showToast(`Offset: ${lyricOffset}ms`);
});

document.getElementById('offset-plus')?.addEventListener('click', (e) => {
  e.stopPropagation();
  lyricOffset += 500;
  showToast(`Offset: ${lyricOffset}ms`);
});
*/

// 解锁按钮（仅在锁定状态下显示/有效）
document.getElementById('unlock-btn')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (isLocked) {
    isLocked = false;
    appElement?.classList.remove('locked');
    // 恢复拖拽 (不再需要 attribute)
    // appElement?.setAttribute('data-tauri-drag-region', '');
    // 恢复鼠标响应
    await appWindow.setIgnoreCursorEvents(false);
    // 同步给 Rust
    invoke('set_lock_state', { locked: false }).catch(console.error);
    console.log("已解锁");
  }
});

// 锁定按钮
document.getElementById('lock-btn')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  
  isLocked = true;
  appElement?.classList.add('locked');
  // 移除拖拽区域 (不再需要)
  // appElement?.removeAttribute('data-tauri-drag-region');
  
  // 物理锁定：设置鼠标穿透
  await appWindow.setIgnoreCursorEvents(true);
  // 同步状态给 Rust
  invoke('set_lock_state', { locked: true }).catch(console.error);

  console.log("已锁定。鼠标悬停窗口顶部中间可解锁。");
});

// function showToast(msg: string) {
//   const infoEl = document.getElementById("info-row");
//   if (infoEl) {
//     const originalText = infoEl.innerText;
//     infoEl.innerText = msg;
//     setTimeout(() => {
//       if (infoEl.innerText === msg) {
//         infoEl.innerText = originalText; // 简单恢复，实际会被 updateInfoDisplay 覆盖
//       }
//     }, 1500);
//   }
// }

async function syncLyrics() {
  try {
    const res = await invoke<string>("get_spotify_track");
    const data = JSON.parse(res);
    const { title, artist, position, duration, status, rate, last_updated } = data; // status: 4=Playing, 5=Paused

    // 更新状态
    const now = Date.now();
    const wasPlaying = isPlaying;
    isPlaying = (status === 4);
    
    // 更新播放/暂停按钮图标
    const playPauseBtn = document.getElementById("play-pause");
    if (playPauseBtn) {
        // 使用纯文本字符，避免 Emoji 风格不一致
        playPauseBtn.innerText = isPlaying ? "❚❚" : "►";
    }

    // currentDuration = duration; // Removed unused variable causing ReferenceError
    playbackSpeed = rate || 1.0;

    // 锚点同步算法 (Anchor Sync)
    // 核心思想：RealStartTime = LastUpdatedTime - Position
    // 无论何时，当前进度 = Date.now() - RealStartTime
    // 注意：last_updated 是 Unix Timestamp (ms)
    // 只有在播放状态下才使用锚点算法；暂停时直接使用 position
    
    if (last_updated > 0 && isPlaying) {
        // 如果后端提供了有效的时间戳
        // 计算这首歌的“理论开始时间” (锚点)
        const calculatedAnchor = last_updated - position;
        
        // 我们只在锚点发生显著变化时更新它 (例如暂停、拖动进度条、切歌)
        // 允许 500ms 的误差（应对系统时钟和 API 抖动）
        if (!wasPlaying || Math.abs(calculatedAnchor - lastAnchorTime) > 500) {
             lastAnchorTime = calculatedAnchor;
             // 注意：这里 lastAnchorPosition 变成了 "歌曲开始时的偏移"，对于这种算法，它其实总是 0
             // 但为了兼容 renderLoop 的逻辑：currentPos = lastAnchorPosition + (now - lastAnchorTime) * speed
             // 我们令 lastAnchorPosition = 0，lastAnchorTime = calculatedAnchor
             lastAnchorPosition = 0;
             console.log("Anchor Update:", calculatedAnchor);
        }
    } else {
        // 降级方案：如果没有 last_updated，回退到旧逻辑
        // 防抖逻辑...
        const estimatedPos = wasPlaying ? (lastAnchorPosition + (now - lastAnchorTime) * playbackSpeed) : lastAnchorPosition;
        const diff = position - estimatedPos; 

        if (!wasPlaying || status !== 4 || Math.abs(diff) > 3000) {
           lastAnchorPosition = position;
           lastAnchorTime = now;
        } else {
           if (diff > 300) {
               lastAnchorPosition = position;
               lastAnchorTime = now;
           } else if (diff < -2000) {
               lastAnchorPosition = position;
               lastAnchorTime = now;
           }
        }
    }

    // 使用新函数
    updateInfoDisplay(title, artist);

    const trackId = `${title}-${artist}`;
    if (trackId !== currentTrackId && title) {
      currentTrackId = trackId;
      // 不要立即清空 lrcLines，防止闪烁，等到 fetch 开始后再处理
      // 增加 fetchId，标记之前的请求作废
      lastFetchId++; 
      lastDisplayedLineIndex = -1; // 切歌重置 UI 过滤器
      lyricOffset = 0; // 切歌重置偏移
      hasPrefetched = false; // 重置预加载标志
      await fetchAndParseLyrics(title, artist, duration, lastFetchId);
    }

    // 预加载逻辑 (Progress > 90%)
    if (isPlaying && duration > 0 && (position / duration > 0.9) && !hasPrefetched) {
        hasPrefetched = true;
        // 尝试预加载下一首 (目前仅打印日志)
        LyricManager.prefetchNextSong().catch(console.error);
    }

    // updateLyricDisplay 移到 renderLoop 中调用
  } catch (e: any) {
    // 忽略 COM "Message Filter Cancelled" 错误 (0x80010002)
    // 这通常发生在系统繁忙或 Spotify 暂时未响应时，下一次轮询会自动恢复
    if (e?.toString().includes("0x80010002") || e?.toString().includes("消息筛选器取消了调用")) {
        // console.warn("SMTC Busy (0x80010002), retrying next cycle...");
        // 遇到繁忙错误，抛出以便外层捕获并调整频率
        throw new Error("SMTC_BUSY");
    }

    // 处理 "No Media" 或其他错误，重置 UI 状态
    isPlaying = false;
    updateInfoDisplay("", "");
    // 如果之前有歌词，可以保留或清空？这里选择清空状态提示
    const lrcEl = document.getElementById("lrc-content");
    if (lrcEl && lrcLines.length === 0) {
        if (e?.toString().includes("No Media")) {
             lrcEl.innerHTML = `
                 <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center;">
                     <div style="font-size: 16px; margin-bottom: 8px;">等待播放...</div>
                     <div style="font-size: 12px; opacity: 0.6; max-width: 80%;">
                         如长时间无响应，请确保 Spotify 设置中<br/>
                         <strong>"在使用媒体键时显示桌面浮层"</strong> 已开启
                     </div>
                 </div>
             `;
        } else {
             lrcEl.innerText = `Error: ${e}`;
        }
    }
    
    // 不要把 No Media 打印为错误，这是正常状态
    if (!e?.toString().includes("No Media")) {
        console.error(e);
        const infoEl = document.getElementById("info-row");
        if (infoEl) infoEl.innerText = `System Error: ${e}`;
    }
  }
}

// 渲染循环：负责高帧率更新歌词位置
function renderLoop() {
    const now = Date.now();
    let currentPos = lastAnchorPosition;

    if (isPlaying) {
        currentPos += (now - lastAnchorTime) * playbackSpeed;
    }

    updateLyricDisplay(currentPos);
    
    requestAnimationFrame(renderLoop);
}

// 启动渲染循环
requestAnimationFrame(renderLoop);

function updateInfoDisplay(title: string, artist: string) {
  const infoEl = document.getElementById("info-row");
  if (!infoEl) return;
  
  // 如果正在显示 Toast（例如 Offset 提示），暂时不更新
  if (infoEl.innerText.startsWith("Offset:")) return;

  const combinedText = (title && artist) ? `${title} - ${artist}` : "未在播放";
  
  if (infoEl.innerText !== combinedText) {
    infoEl.innerText = combinedText;
  }
}

function updateLyricDisplay(rawPosition: number) {
  if (lrcLines.length === 0) return;
  
  // 应用偏移
  // 移除硬编码延迟补偿，使用锚点算法自动对齐
  const position = rawPosition + lyricOffset;

  // 检测手动回退（Seek）：如果进度突然回退超过 500ms，重置过滤器
  if (position < lastRenderPos - 500) {
      lastDisplayedLineIndex = -1;
  }
  lastRenderPos = position;

  // 二分查找：找到最后一个时间小于等于当前位置的行
  let low = 0;
  let high = lrcLines.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lrcLines[mid].time <= position) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // 单调递增过滤器：防止因系统时间抖动导致的歌词回退
  // 如果新计算的行号比上一帧显示的行号小，且不是手动回退，强制保持上一帧的行号
  if (lastDisplayedLineIndex !== -1 && high < lastDisplayedLineIndex) {
      high = lastDisplayedLineIndex;
  }
  lastDisplayedLineIndex = high;

  const currentLine = high >= 0 ? lrcLines[high] : null;
  const lrcEl = document.getElementById("lrc-content");
  
  if (lrcEl && currentLine && lrcEl.innerText !== currentLine.text) {
    lrcEl.innerText = currentLine.text;
  }
}

async function fetchAndParseLyrics(title: string, artist: string, duration: number, fetchId: number) {
  // 如果这是过期的请求，直接忽略
  if (fetchId !== lastFetchId) return;

  const lrcEl = document.getElementById("lrc-content");
  if (lrcEl) {
      lrcLines = []; // 清空当前歌词
      lrcEl.innerText = "正在搜索歌词...";
  }

  try {
    // 调用 LyricManager 获取歌词
    // 注意：LyricManager 内部已包含缓存、超时、时长校验
    const rawLrc = await LyricManager.getLyrics({
        title,
        artist,
        // lib.rs: duration = timeline.EndTime().Duration / 10000; (ms)
        // 所以这里必须 / 1000
        duration: duration / 1000
    });

    if (fetchId !== lastFetchId) return;

    if (!rawLrc) {
      if (lrcEl && fetchId === lastFetchId) {
          // 区分显示：如果是纯音乐（有 title 但无歌词）显示暂无歌词
          // 如果是搜索超时，LyricManager 会返回 null，这里统一显示暂无歌词
          // 可以在 LyricManager 里区分 null 和 'TIMEOUT' 吗？目前不行
          lrcEl.innerText = "暂无歌词";
      }
      return;
    }

    // 高精度解析
    const newLines = rawLrc.split('\n')
      .map(line => {
        const match = line.match(LRC_REGEX);
        if (match) {
          const min = parseInt(match[1]);
          const sec = parseInt(match[2]);
          let msStr = match[3] || "0";
          // 补齐位数：.3 -> 300, .34 -> 340
          if (msStr.length === 1) msStr += "00";
          else if (msStr.length === 2) msStr += "0";
          const ms = parseInt(msStr);
          
          return { 
            time: min * 60000 + sec * 1000 + ms, 
            text: match[4].trim() 
          };
        }
        return null;
      })
      .filter((l): l is {time: number, text: string} => l !== null && l.text !== "")
      .sort((a, b) => a.time - b.time); // 确保有序

    // 只有当 ID 依旧匹配时，才更新全局 lrcLines
    if (fetchId === lastFetchId) {
        lrcLines = newLines;
        if (lrcLines.length === 0 && lrcEl) lrcEl.innerText = "纯音乐";
    }
  } catch (e) {
    if (lrcEl && fetchId === lastFetchId) {
        if (e?.toString().includes("Timeout")) {
            lrcEl.innerText = "搜索超时";
        } else {
            lrcEl.innerText = "搜索失败";
        }
    }
    console.error(e);
  }
}

// 动态轮询循环
async function syncLoop() {
    if (!isMounted) return;

    // 如果正在控制，暂停一轮
    if (controlQueue.isBusy()) {
        setTimeout(syncLoop, 500);
        return;
    }

    try {
        await syncLyrics();
        syncBackoff.reset(); // 成功则重置
    } catch (e: any) {
        if (e.message === "SMTC_BUSY") {
            syncBackoff.backoff(); // 繁忙则退避
        } else {
            console.error("Sync loop error:", e);
            
            // 发生非繁忙错误时，检查 Web API 连接状态
            // 这符合 "连续 3 次 /me/player 失败即暂停" 的要求
            try {
                if (SpotifyAuth.hasClientId()) {
                    const isConnected = await SpotifyAuth.checkConnection();
                    if (!isConnected) {
                        const fails = syncBackoff.recordWebAPIFailure();
                        if (fails >= CONFIG.SYNC.CIRCUIT_BREAKER_THRESHOLD) {
                            console.warn(`Circuit breaker triggered (${fails} failures). Pausing for 30s.`);
                            
                            const lrcEl = document.getElementById("lrc-content");
                            if (lrcEl) {
                                lrcEl.innerHTML = `
                                    <div>连接断开，30秒后重试...</div>
                                    <button onclick="location.reload()" style="pointer-events:auto; margin-top:10px; padding:5px 10px;">立即重载</button>
                                `;
                            }

                            // 暂停 30s
                            await new Promise(r => setTimeout(r, 30000));
                            syncBackoff.reset(); // 恢复尝试
                        }
                    } else {
                        // 连接正常，可能是其他偶发错误，重置计数器
                        syncBackoff.reset();
                    }
                }
            } catch (connErr) {
                console.error("Circuit breaker check failed:", connErr);
            }
        }
    } finally {
        if (isMounted) {
            setTimeout(syncLoop, syncBackoff.getInterval());
        }
    }
}

// 启动循环
syncLoop();