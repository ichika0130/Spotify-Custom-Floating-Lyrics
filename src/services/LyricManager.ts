import { BaseDirectory, exists, readTextFile, writeTextFile, mkdir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { SpotifyAuth } from './SpotifyAuth';

export interface TrackInfo {
    title: string;
    artist: string;
    duration: number; // seconds
    // Spotify ID is not available from SMTC, so we use artist-title hash or string as key
    id?: string; 
}

export class LyricManager {
    private static readonly CACHE_DIR = 'lyrics';
    
    // 初始化：确保缓存目录存在
    static async init() {
        try {
            SpotifyAuth.init();
            // 检查 lyrics 目录是否存在，不存在则创建
            const dirExists = await exists(this.CACHE_DIR, { baseDir: BaseDirectory.AppData });
            if (!dirExists) {
                await mkdir(this.CACHE_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
                console.log('Lyric cache directory created.');
            }
        } catch (e) {
            console.error('Failed to initialize lyric cache:', e);
        }
    }

    /**
     * 获取歌词的主入口
     * 1. 检查本地缓存
     * 2. ISRC 匹配 (Spotify API)
     * 3. 网络搜索 (带时长校验 & 超时)
     * 4. 写入缓存
     */
    static async getLyrics(track: TrackInfo): Promise<string | null> {
        if (!track.title || !track.artist) return null;

        const cacheKey = this.getCacheKey(track);
        
        // 1. 尝试本地缓存 (0ms 闪电加载)
        try {
            const cached = await this.loadFromCache(cacheKey);
            if (cached) {
                console.log(`[Cache Hit] Loaded lyrics for: ${cacheKey}`);
                return cached;
            }
        } catch (e) {
            console.warn('Cache read failed:', e);
        }

        // 2. ISRC 精准匹配 (如果已登录 Spotify)
        try {
            const token = await SpotifyAuth.getAccessToken();
            if (token) {
                const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.item && data.item.external_ids && data.item.external_ids.isrc) {
                        // 简单的模糊匹配，确保是同一首歌 (避免 SMTC 延迟导致不匹配)
                        const spotifyTitle = data.item.name;
                        if (track.title.toLowerCase().includes(spotifyTitle.toLowerCase()) || 
                            spotifyTitle.toLowerCase().includes(track.title.toLowerCase())) {
                            
                            const isrc = data.item.external_ids.isrc;
                            console.log(`[Spotify API] Found ISRC: ${isrc}`);
                            
                            const isrcLyrics = await this.fetchByISRC(isrc);
                            if (isrcLyrics) {
                                this.saveToCache(cacheKey, isrcLyrics).catch(e => console.error('Cache write failed:', e));
                                return isrcLyrics;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Spotify ISRC fetch failed:', e);
        }

        // 3. 网络搜索 (带超时和校验)
        console.log(`[Network] Searching lyrics for: ${track.title} - ${track.artist}`);
        try {
            const lyrics = await this.searchLrcLibWithTimeout(track, 5000);
            
            if (lyrics) {
                // 4. 写入缓存 (静默)
                this.saveToCache(cacheKey, lyrics).catch(e => console.error('Cache write failed:', e));
                return lyrics;
            }
        } catch (e) {
            console.error('Lyrics search failed:', e);
        }

        return null;
    }

    // 预加载下一首歌曲
    static async prefetchNextSong(): Promise<void> {
        try {
            const token = await SpotifyAuth.getAccessToken();
            if (!token) return;

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
                        
                        console.log(`[Prefetch] Prefetching next song: ${title} - ${artist}`);
                        
                        // 构造 TrackInfo
                        const trackInfo: TrackInfo = {
                            title,
                            artist,
                            duration
                        };
                        
                        // 检查缓存
                        const cacheKey = this.getCacheKey(trackInfo);
                        const cached = await this.loadFromCache(cacheKey);
                        if (cached) {
                            console.log(`[Prefetch] Already cached: ${cacheKey}`);
                            return;
                        }
                        
                        // 如果有 ISRC，优先尝试 ISRC
                        if (nextTrack.external_ids && nextTrack.external_ids.isrc) {
                             const isrc = nextTrack.external_ids.isrc;
                             const isrcLyrics = await this.fetchByISRC(isrc);
                             if (isrcLyrics) {
                                 await this.saveToCache(cacheKey, isrcLyrics);
                                 console.log(`[Prefetch] Saved via ISRC: ${cacheKey}`);
                                 return;
                             }
                        }

                        // 否则走常规搜索
                        const lyrics = await this.searchLrcLibWithTimeout(trackInfo, 5000);
                        if (lyrics) {
                            await this.saveToCache(cacheKey, lyrics);
                            console.log(`[Prefetch] Saved via Search: ${cacheKey}`);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Prefetch failed:', e);
        }
    }
    
    // 通过 ISRC 获取歌词
    private static async fetchByISRC(isrc: string): Promise<string | null> {
        try {
            const url = `https://lrclib.net/api/get?isrc=${isrc}`;
            const res = await invoke<string>('fetch_proxy', { url });
            const data = JSON.parse(res);
            if (data && (data.syncedLyrics || data.plainLyrics)) {
                return data.syncedLyrics || data.plainLyrics;
            }
        } catch (e) {
            // 404 is normal
        }
        return null;
    }

    // ... (rest of the file)

    // 生成缓存文件名：sanitize(Artist - Title).lrc
    private static getCacheKey(track: TrackInfo): string {
        const raw = `${track.artist} - ${track.title}`;
        // 替换非法字符
        return raw.replace(/[<>:"/\\|?*]/g, '_').trim() + '.lrc';
    }

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
            .split(' - ')[0]
            .trim();
    }

    private static async loadFromCache(filename: string): Promise<string | null> {
        const path = `${this.CACHE_DIR}/${filename}`;
        const isExist = await exists(path, { baseDir: BaseDirectory.AppData });
        if (!isExist) return null;
        
        return await readTextFile(path, { baseDir: BaseDirectory.AppData });
    }

    private static async saveToCache(filename: string, content: string): Promise<void> {
        const path = `${this.CACHE_DIR}/${filename}`;
        await writeTextFile(path, content, { baseDir: BaseDirectory.AppData });
    }

    // LrcLib 搜索 + 时长校验 + 超时控制
    private static async searchLrcLibWithTimeout(track: TrackInfo, timeoutMs: number): Promise<string | null> {
        return new Promise(async (resolve, reject) => {
            let isFinished = false;

            // 超时计时器
            const timer = setTimeout(() => {
                if (!isFinished) {
                    isFinished = true;
                    console.warn('Lyrics search timed out.');
                    reject(new Error("Timeout"));
                }
            }, timeoutMs);

            try {
                // 清洗标题，提高匹配率
                const cleanTitle = this.cleanTitle(track.title);
                // 构造搜索 URL (使用通用搜索以提高匹配率，避免 artist_name 严格匹配导致的失败)
                const query = encodeURIComponent(`${cleanTitle} ${track.artist}`);
                const url = `https://lrclib.net/api/search?q=${query}`;
                
                // 调用 Rust 代理请求 (避免 CORS)
                const res = await invoke<string>('fetch_proxy', { url });
                
                if (isFinished) return;

                const data = JSON.parse(res);
                if (Array.isArray(data) && data.length > 0) {
                    // Rust returns duration in ms, but LRCLIB uses seconds
                    // Convert to seconds if it looks like ms (> 1000 is a safe bet for a song)
                    let targetDuration = track.duration;
                    if (targetDuration > 1000) {
                        targetDuration = targetDuration / 1000;
                    }

                    // Precision Matching: 时长过滤
                    // 如果提供了有效时长，必须对比 duration，保留误差在 ±2 秒内的结果
                    if (targetDuration > 0) {
                        const bestMatch = data.find((item: any) => {
                            const itemDuration = item.duration;
                            return Math.abs(itemDuration - targetDuration) <= 3; // 放宽到 3s 以应对版本差异
                        });

                        if (bestMatch) {
                            isFinished = true;
                            clearTimeout(timer);
                            resolve(bestMatch.syncedLyrics || bestMatch.plainLyrics || null);
                            return;
                        } else {
                            console.log(`No lyrics matched duration criteria (Target: ${targetDuration}s).`);
                        }
                    } else {
                        // 如果没有时长信息，回退到首个匹配项
                        console.warn("No duration provided for filtering, using first match.");
                        const first = data[0];
                        isFinished = true;
                        clearTimeout(timer);
                        resolve(first.syncedLyrics || first.plainLyrics || null);
                        return;
                    }
                }
                
                if (!isFinished) {
                    isFinished = true;
                    clearTimeout(timer);
                    resolve(null);
                }
            } catch (e) {
                if (!isFinished) {
                    isFinished = true;
                    clearTimeout(timer);
                    reject(e);
                }
            }
        });
    }
}
