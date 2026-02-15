import { BaseDirectory, exists, readTextFile, writeTextFile, mkdir, remove } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { SpotifyAuth } from './SpotifyAuth';

/**
 * 歌曲信息接口
 * 定义了获取歌词所需的基本元数据
 */
export interface TrackInfo {
    /** 歌曲标题 */
    title: string;
    /** 艺术家名称 */
    artist: string;
    /** 歌曲时长（秒） */
    duration: number;
    /** Spotify ID（可选，用于精确匹配） */
    id?: string; 
}

/**
 * 缓存索引项接口
 * 用于记录缓存文件的元数据，支持 LRU 淘汰策略
 */
interface CacheIndexItem {
    /** 缓存文件名 */
    filename: string;
    /** 最后访问时间戳 (ms) */
    lastAccess: number;
    /** 访问次数 */
    accessCount: number;
    /** 对应的歌曲标识 (Artist - Title) */
    key: string;
}

/**
 * 歌词管理器类
 * 负责歌词的获取、缓存、搜索和解析
 * 实现了多级获取策略：本地缓存 -> Spotify ISRC -> LRCLIB 模糊搜索
 * 包含智能 LRU 缓存管理机制
 */
export class LyricManager {
    /** 缓存目录名称 */
    private static readonly CACHE_DIR = 'lyrics';
    /** 缓存索引文件名 */
    private static readonly CACHE_INDEX_FILE = 'cache_index.json';
    /** 最大缓存数量限制 */
    private static readonly MAX_CACHE_SIZE = 200;
    /** 内存中的缓存索引 */
    private static cacheIndex: CacheIndexItem[] = [];
    
    /** 内存级缓存 (L1 Cache)，用于极速响应最近播放的歌曲，避免频繁 IO */
    private static memoryCache: Map<string, string> = new Map();
    /** 内存缓存最大容量 */
    private static readonly MAX_MEMORY_CACHE = 10;

    // --- 统计数据 ---
    /** 总请求次数 */
    private static totalRequests = 0;
    /** 缓存命中次数 */
    private static cacheHits = 0;

    /**
     * 获取缓存统计信息
     * @returns { total: number, hits: number, rate: string }
     */
    static getCacheStats() {
        const rate = this.totalRequests > 0 
            ? ((this.cacheHits / this.totalRequests) * 100).toFixed(2) + '%' 
            : '0.00%';
            
        return {
            total: this.totalRequests,
            hits: this.cacheHits,
            rate
        };
    }

    /**
     * 初始化歌词管理器
     * 1. 初始化 Spotify 认证模块
     * 2. 确保缓存目录存在
     * 3. 加载缓存索引
     */
    static async init() {
        try {
            SpotifyAuth.init();
            
            // 检查 lyrics 目录是否存在，不存在则创建
            const dirExists = await exists(this.CACHE_DIR, { baseDir: BaseDirectory.AppData });
            if (!dirExists) {
                await mkdir(this.CACHE_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
                console.log('[LyricManager] 歌词缓存目录已创建');
            }

            // 加载缓存索引
            await this.loadCacheIndex();
        } catch (e) {
            console.error('[LyricManager] 初始化失败:', e);
        }
    }

    /**
     * 获取歌词的主入口方法
     * 策略流程：
     * 1. 检查本地缓存 (最快)
     * 2. 尝试 Spotify ISRC 精确匹配 (如果已登录)
     * 3. 尝试 LRCLIB 网络模糊搜索 (带时长校验和重试机制)
     * 4. 成功后写入本地缓存
     * 
     * @param track 歌曲信息
     * @returns 歌词文本 (LRC 格式) 或 null
     */
    static async getLyrics(track: TrackInfo): Promise<string | null> {
        this.totalRequests++;
        
        if (!track.title || !track.artist) {
            console.warn('[LyricManager] 缺少歌曲信息，无法获取歌词');
            return null;
        }

        const cacheKey = this.getCacheKey(track);
        
        // ---------------------------------------------------------
        // 0. 尝试内存缓存 (L1 Cache - 极速)
        // ---------------------------------------------------------
        if (this.memoryCache.has(cacheKey)) {
            this.cacheHits++;
            console.log(`[Cache Hit] 命中内存缓存: ${cacheKey}`);
            return this.memoryCache.get(cacheKey) || null;
        }

        // ---------------------------------------------------------
        // 1. 尝试本地缓存 (L2 Cache - 文件系统)
        // ---------------------------------------------------------
        try {
            const cached = await this.loadFromCache(cacheKey);
            if (cached) {
                this.cacheHits++;
                console.log(`[Cache Hit] 命中本地缓存: ${cacheKey}`);
                // 回填到内存缓存
                this.updateMemoryCache(cacheKey, cached);
                return cached;
            }
        } catch (e) {
            console.warn('[LyricManager] 读取缓存失败:', e);
        }

        // ---------------------------------------------------------
        // 2. ISRC 精准匹配 (依赖 Spotify 集成)
        // ---------------------------------------------------------
        try {
            const token = await SpotifyAuth.getAccessToken();
            if (token) {
                // 获取当前播放状态以提取 ISRC
                const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (res.ok) {
                    const data = await res.json();
                    // 确保获取到的是同一首歌（防止本地 SMTC 延迟导致的匹配错误）
                    if (data && data.item && data.item.external_ids && data.item.external_ids.isrc) {
                        const spotifyTitle = data.item.name || "";
                        // 简单的模糊匹配标题
                        if (track.title.toLowerCase().includes(spotifyTitle.toLowerCase()) || 
                            spotifyTitle.toLowerCase().includes(track.title.toLowerCase())) {
                            
                            const isrc = data.item.external_ids.isrc;
                            console.log(`[Spotify API] 获取到 ISRC: ${isrc}`);
                            
                            const isrcLyrics = await this.fetchByISRC(isrc);
                            if (isrcLyrics) {
                                await this.saveToCache(cacheKey, isrcLyrics);
                                return isrcLyrics;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[LyricManager] Spotify ISRC 获取失败:', e);
        }

        // ---------------------------------------------------------
        // 3. 网络搜索 (带超时、重试和时长校验)
        // ---------------------------------------------------------
        console.log(`[Network] 开始网络搜索: ${track.title} - ${track.artist}`);
        try {
            // 尝试最多 3 次
            const maxRetries = 3;
            let lastError;
            
            for (let i = 0; i < maxRetries; i++) {
                try {
                    if (i > 0) console.log(`[Network] 重试第 ${i + 1} 次...`);
                    const lyrics = await this.searchLrcLibWithTimeout(track, 5000); // 5秒超时
                    
                    if (lyrics) {
                        // 4. 写入缓存 (异步执行，不阻塞 UI)
                        this.saveToCache(cacheKey, lyrics).catch(e => console.error('[Cache] 写入失败:', e));
                        return lyrics;
                    } else {
                        // 如果明确返回 null (无匹配)，通常不需要重试，除非网络错误
                        // 这里我们假设 searchLrcLibWithTimeout 只有在网络错误时抛出异常
                        break; 
                    }
                } catch (e) {
                    lastError = e;
                    console.warn(`[Network] 搜索尝试 ${i + 1} 失败:`, e);
                    // 简单的指数退避
                    await new Promise(r => setTimeout(r, 500 * (2 ** i)));
                }
            }
            
            if (lastError) {
                console.error('[LyricManager] 所有重试均失败', lastError);
            }
            
        } catch (e) {
            console.error('[LyricManager] 歌词搜索流程异常:', e);
        }

        return null;
    }

    /**
     * 预加载下一首歌曲的歌词
     * 当当前歌曲播放进度超过 90% 时调用
     */
    static async prefetchNextSong(): Promise<void> {
        try {
            const token = await SpotifyAuth.getAccessToken();
            if (!token) return;

            // 获取 Spotify 播放队列
            const res = await fetch('https://api.spotify.com/v1/me/player/queue', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.ok) {
                const data = await res.json();
                if (data && data.queue && data.queue.length > 0) {
                    const nextTrack = data.queue[0];
                    if (nextTrack && nextTrack.name && nextTrack.artists) {
                        const artist = nextTrack.artists[0].name;
                        const title = nextTrack.name;
                        const duration = nextTrack.duration_ms / 1000;
                        
                        console.log(`[Prefetch] 预加载下一首: ${title} - ${artist}`);
                        
                        // 构造 TrackInfo
                        const trackInfo: TrackInfo = {
                            title,
                            artist,
                            duration
                        };
                        
                        // 检查是否已缓存
                        const cacheKey = this.getCacheKey(trackInfo);
                        const cached = await this.loadFromCache(cacheKey); // 这会更新 LRU
                        if (cached) {
                            console.log(`[Prefetch] 已存在于缓存: ${cacheKey}`);
                            return;
                        }
                        
                        // 如果有 ISRC，优先尝试 ISRC
                        if (nextTrack.external_ids && nextTrack.external_ids.isrc) {
                             const isrc = nextTrack.external_ids.isrc;
                             const isrcLyrics = await this.fetchByISRC(isrc);
                             if (isrcLyrics) {
                                 await this.saveToCache(cacheKey, isrcLyrics);
                                 console.log(`[Prefetch] 通过 ISRC 预加载成功: ${cacheKey}`);
                                 return;
                             }
                        }

                        // 否则走常规搜索
                        const lyrics = await this.searchLrcLibWithTimeout(trackInfo, 5000);
                        if (lyrics) {
                            await this.saveToCache(cacheKey, lyrics);
                            console.log(`[Prefetch] 通过搜索预加载成功: ${cacheKey}`);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[Prefetch] 预加载失败:', e);
        }
    }
    
    /**
     * 通过 ISRC 获取歌词 (LRCLIB API)
     * @param isrc 国际标准录音代码
     */
    private static async fetchByISRC(isrc: string): Promise<string | null> {
        try {
            const url = `https://lrclib.net/api/get?isrc=${isrc}`;
            // 使用 Rust 后端代理请求以避免 CORS 问题
            const res = await invoke<string>('fetch_proxy', { url });
            const data = JSON.parse(res);
            if (data && (data.syncedLyrics || data.plainLyrics)) {
                return data.syncedLyrics || data.plainLyrics;
            }
        } catch (e) {
            // 404 是正常现象，表示未找到
        }
        return null;
    }

    /**
     * 生成标准化的缓存文件名
     * 规则：sanitize(Artist - Title).lrc
     * 增强过滤：移除控制字符、非法符号，确保 Windows 文件名安全
     */
    private static getCacheKey(track: TrackInfo): string {
        const raw = `${track.artist} - ${track.title}`;
        // 1. 替换 Windows 非法字符: < > : " / \ | ? *
        // 2. 替换控制字符 (ASCII 0-31)
        // 3. 替换结尾的点和空格 (Windows 不允许)
        return raw
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // 非法字符和控制字符 -> 下划线
            .replace(/[\s.]+$/g, '')                // 移除末尾空格和点
            .trim() + '.lrc';
    }

    /**
     * 清理歌曲标题，移除干扰搜索的元数据
     * 例如：(feat. X), (Remastered), - Radio Edit 等
     */
    private static cleanTitle(title: string): string {
        return title
            .replace(/\(feat\..*?\)/gi, '')
            .replace(/\(with.*?\)/gi, '')
            .replace(/\(Remastered.*?\)/gi, '')
            .replace(/\(Explicit\)/gi, '')
            .replace(/\(Radio Edit.*?\)/gi, '')
            .replace(/- .*?Version/gi, '')
            .replace(/- .*?Remaster/gi, '')
            .replace(/- .*?Radio Edit/gi, '')
            .split(' - ')[0] // 有些标题直接带 " - Remastered"
            .trim();
    }

    /**
     * 加载缓存索引文件到内存
     */
    private static async loadCacheIndex() {
        try {
            const path = `${this.CACHE_DIR}/${this.CACHE_INDEX_FILE}`;
            const existsIndex = await exists(path, { baseDir: BaseDirectory.AppData });
            if (existsIndex) {
                const content = await readTextFile(path, { baseDir: BaseDirectory.AppData });
                this.cacheIndex = JSON.parse(content);
                console.log(`[Cache] 索引加载成功，共 ${this.cacheIndex.length} 条记录`);
            } else {
                this.cacheIndex = [];
            }
        } catch (e) {
            console.warn('[Cache] 索引加载失败，重置为空:', e);
            this.cacheIndex = [];
        }
    }

    /**
     * 保存缓存索引文件到磁盘
     */
    private static async saveCacheIndex() {
        try {
            const path = `${this.CACHE_DIR}/${this.CACHE_INDEX_FILE}`;
            await writeTextFile(path, JSON.stringify(this.cacheIndex), { baseDir: BaseDirectory.AppData });
        } catch (e) {
            console.error('[Cache] 索引保存失败:', e);
        }
    }

    /**
     * 从本地缓存读取歌词
     * 同时更新 LRU 索引（最后访问时间）
     * @param filename 缓存文件名
     */
    private static async loadFromCache(filename: string): Promise<string | null> {
        const path = `${this.CACHE_DIR}/${filename}`;
        
        try {
            // 直接尝试读取文件，利用 try-catch 处理不存在的情况，比先 exists 更可靠且少一次 IO
            const content = await readTextFile(path, { baseDir: BaseDirectory.AppData });
            
            // 读取成功，更新索引
            const indexItem = this.cacheIndex.find(i => i.filename === filename);
            if (indexItem) {
                indexItem.lastAccess = Date.now();
                indexItem.accessCount = (indexItem.accessCount || 0) + 1;
            } else {
                // 如果文件存在但索引不存在（可能是手动添加的文件），补充索引
                this.cacheIndex.push({
                    filename,
                    lastAccess: Date.now(),
                    accessCount: 1,
                    key: filename.replace('.lrc', '')
                });
            }
            // 异步保存索引更新
            this.saveCacheIndex();

            return content;
        } catch (e) {
            // 文件不存在或读取错误
            // console.debug(`[Cache] 本地未命中: ${filename}`); // 降低日志级别
            return null;
        }
    }

    /**
     * 更新内存缓存 (LIFO / LRU 简单实现)
     */
    private static updateMemoryCache(key: string, content: string) {
        // 如果已存在，先删除以更新位置（最近使用）
        if (this.memoryCache.has(key)) {
            this.memoryCache.delete(key);
        }
        
        this.memoryCache.set(key, content);
        
        // 维持容量
        if (this.memoryCache.size > this.MAX_MEMORY_CACHE) {
            // Map 的 keys() 返回迭代器，按插入顺序排列，第一个是最早插入的
            const firstKey = this.memoryCache.keys().next().value;
            if (firstKey) this.memoryCache.delete(firstKey);
        }
    }

    /**
     * 保存歌词到本地缓存
     * 执行 LRU 淘汰策略
     */
    private static async saveToCache(filename: string, content: string): Promise<void> {
        // 1. 更新内存缓存
        this.updateMemoryCache(filename, content);

        try {
            const path = `${this.CACHE_DIR}/${filename}`;
            
            // 尝试写入文件
            try {
                await writeTextFile(path, content, { baseDir: BaseDirectory.AppData });
            } catch (err) {
                // 如果写入失败，可能是目录不存在，尝试重新创建目录
                console.warn('[Cache] 写入失败，尝试重建目录:', err);
                await mkdir(this.CACHE_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
                // 重试写入
                await writeTextFile(path, content, { baseDir: BaseDirectory.AppData });
            }
            
            console.log(`[Cache] 写入成功: ${filename}`);

            // 更新或添加索引
            const index = this.cacheIndex.findIndex(i => i.filename === filename);
            if (index !== -1) {
                this.cacheIndex[index].lastAccess = Date.now();
                this.cacheIndex[index].accessCount++;
            } else {
                this.cacheIndex.push({
                    filename,
                    lastAccess: Date.now(),
                    accessCount: 1,
                    key: filename.replace('.lrc', '')
                });
            }

            // LRU 淘汰：如果超过最大限制，删除最久未使用的
            if (this.cacheIndex.length > this.MAX_CACHE_SIZE) {
                // 按最后访问时间排序 (升序，最老的在前)
                this.cacheIndex.sort((a, b) => a.lastAccess - b.lastAccess);
                
                // 删除超出的部分
                const toRemoveCount = this.cacheIndex.length - this.MAX_CACHE_SIZE;
                const toRemove = this.cacheIndex.splice(0, toRemoveCount);
                
                console.log(`[Cache] 触发 LRU 清理，删除 ${toRemoveCount} 个旧文件`);
                
                // 从磁盘删除文件
                for (const item of toRemove) {
                    try {
                        const rmPath = `${this.CACHE_DIR}/${item.filename}`;
                        await remove(rmPath, { baseDir: BaseDirectory.AppData });
                        console.log(`[Cache] 已删除: ${item.filename}`);
                    } catch (err) {
                        console.warn(`[Cache] 删除文件失败: ${item.filename}`, err);
                    }
                }
            }

            await this.saveCacheIndex();
        } catch (e) {
            console.error('[Cache] 写入失败:', e);
        }
    }

    /**
     * 执行 LrcLib 搜索
     * 包含超时控制、时长校验和详细日志
     * @param track 歌曲信息
     * @param timeoutMs 超时时间（毫秒）
     */
    private static async searchLrcLibWithTimeout(track: TrackInfo, timeoutMs: number): Promise<string | null> {
        return new Promise(async (resolve, reject) => {
            let isFinished = false;

            // 设置超时计时器
            const timer = setTimeout(() => {
                if (!isFinished) {
                    isFinished = true;
                    console.warn(`[Network] 搜索超时 (${timeoutMs}ms): ${track.title}`);
                    reject(new Error("Timeout"));
                }
            }, timeoutMs);

            try {
                // 1. 清洗标题，移除无关信息以提高匹配率
                const cleanTitle = this.cleanTitle(track.title);
                
                // 2. 构造搜索 URL
                // 使用通用搜索 q=Title Artist 而不是字段匹配，因为元数据可能不一致
                const query = encodeURIComponent(`${cleanTitle} ${track.artist}`);
                const url = `https://lrclib.net/api/search?q=${query}`;
                
                console.log(`[Network] 请求 URL: ${url}`);
                
                // 3. 通过 Rust 后端发起请求
                const res = await invoke<string>('fetch_proxy', { url });
                
                if (isFinished) return; // 如果已超时，丢弃结果

                const data = JSON.parse(res);
                
                if (Array.isArray(data) && data.length > 0) {
                    // LRCLIB 返回的 duration 是秒，但有时可能是毫秒（取决于 API 版本，目前主要是秒）
                    // 我们的 track.duration 是秒
                    // 简单判断：如果 API 返回 > 1000，认为是毫秒，转换为秒
                    let targetDuration = track.duration;
                    
                    // 4. 时长校验逻辑
                    if (targetDuration > 0) {
                        // 在结果中寻找时长匹配的项 (误差 ±3秒)
                        const bestMatch = data.find((item: any) => {
                            let itemDuration = item.duration;
                            // 归一化为秒
                            // if (itemDuration > 1000) itemDuration /= 1000; 
                            // 实际上 LRCLIB 文档说是秒，但保持防御性编程
                            
                            const diff = Math.abs(itemDuration - targetDuration);
                            return diff <= 3;
                        });

                        if (bestMatch) {
                            isFinished = true;
                            clearTimeout(timer);
                            console.log(`[Network] 找到匹配歌词 (时长差: ${Math.abs(bestMatch.duration - targetDuration).toFixed(2)}s)`);
                            resolve(bestMatch.syncedLyrics || bestMatch.plainLyrics || null);
                            return;
                        } else {
                            console.log(`[Network] 未找到时长匹配的歌词 (目标: ${targetDuration}s)`);
                        }
                    } else {
                        // 如果没有提供时长，只能回退到第一个结果
                        console.warn("[Network] 无时长信息，使用第一个搜索结果");
                        const first = data[0];
                        isFinished = true;
                        clearTimeout(timer);
                        resolve(first.syncedLyrics || first.plainLyrics || null);
                        return;
                    }
                } else {
                    console.log("[Network] API 返回空数组");
                }
                
                // 未找到
                if (!isFinished) {
                    isFinished = true;
                    clearTimeout(timer);
                    resolve(null);
                }
            } catch (e) {
                if (!isFinished) {
                    isFinished = true;
                    clearTimeout(timer);
                    console.error("[Network] 请求异常:", e);
                    reject(e);
                }
            }
        });
    }
}
