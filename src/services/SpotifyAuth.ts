import { invoke } from '@tauri-apps/api/core';

/**
 * Spotify 授权范围配置
 * - user-read-playback-state: 读取当前播放状态
 * - user-modify-playback-state: 控制播放（暂停/播放/下一首）
 * - user-read-currently-playing: 获取当前播放曲目详情
 * - playlist-read-private: 读取用户歌单（用于未来的歌单匹配功能）
 */
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private';

/** 授权回调地址 (必须与 Spotify Dashboard 配置一致) */
const REDIRECT_URI = 'http://localhost:8888/callback';

/** Spotify 令牌端点 */
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

/** Spotify 授权端点 */
const AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';

/** Spotify Web API 基础地址 */
const API_BASE = 'https://api.spotify.com/v1';

/**
 * Spotify 令牌响应接口
 * 定义了 OAuth2 令牌交换返回的数据结构
 */
interface TokenResponse {
    /** 访问令牌 (Access Token) */
    access_token: string;
    /** 令牌类型 (通常为 Bearer) */
    token_type: string;
    /** 授权范围 */
    scope: string;
    /** 过期时间 (秒) */
    expires_in: number;
    /** 刷新令牌 (Refresh Token) */
    refresh_token: string;
}

/**
 * Spotify 认证服务类
 * 负责处理 OAuth2 授权流程、令牌管理和会话持久化
 * 支持无 Client ID 的可选模式 (Optional Mode)
 */
export class SpotifyAuth {
    /** Spotify 应用客户端 ID */
    private static clientId = '';
    /** 当前访问令牌 */
    private static accessToken = '';
    /** 当前刷新令牌 */
    private static refreshToken = '';
    /** 令牌过期时间戳 (毫秒) */
    private static expirationTime = 0;

    /**
     * 初始化认证服务
     * 从 localStorage 加载持久化的会话信息
     */
    static init() {
        this.clientId = localStorage.getItem('spotify_client_id') || '';
        this.accessToken = localStorage.getItem('spotify_access_token') || '';
        this.refreshToken = localStorage.getItem('spotify_refresh_token') || '';
        this.expirationTime = parseInt(localStorage.getItem('spotify_expiration_time') || '0', 10);
        
        if (!this.clientId) {
            console.log("[SpotifyAuth] 未找到 Client ID，运行在可选模式 (无 Spotify 集成)");
        }
    }

    /**
     * 设置 Client ID
     * @param id 用户输入的 Client ID
     */
    static setClientId(id: string) {
        if (!id) {
            this.clientId = '';
            localStorage.removeItem('spotify_client_id');
            this.logout(); // 清除无用的令牌
            return;
        }
        this.clientId = id;
        localStorage.setItem('spotify_client_id', id);
    }

    /**
     * 检查是否已配置 Client ID
     * @returns boolean
     */
    static hasClientId(): boolean {
        return !!this.clientId;
    }

    /**
     * 检查是否已登录 (存在刷新令牌)
     * @returns boolean
     */
    static isLoggedIn(): boolean {
        return !!this.refreshToken;
    }

    /**
     * 登出并清除本地会话
     */
    static logout() {
        this.accessToken = '';
        this.refreshToken = '';
        this.expirationTime = 0;
        localStorage.removeItem('spotify_access_token');
        localStorage.removeItem('spotify_refresh_token');
        localStorage.removeItem('spotify_expiration_time');
        console.log("[SpotifyAuth] 已登出 (本地会话已清除)");
    }

    /**
     * 检查 Spotify 连接状态
     * 验证令牌有效性并检查是否有活跃设备
     * @returns boolean 连接是否正常
     */
    static async checkConnection(): Promise<boolean> {
        // 可选模式下直接返回 false
        if (!this.hasClientId()) {
            return false;
        }

        const token = await this.getAccessToken();
        if (!token) return false;

        try {
            // 请求当前播放器状态
            const res = await fetch(`${API_BASE}/me/player`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            // 204 No Content: 认证成功但当前无播放内容（通常表示无活跃设备）
            if (res.status === 204) {
                console.warn('[SpotifyAuth] 无活跃设备，尝试激活首选设备...');
                return await this.activateFirstDevice();
            }
            
            // 404 Not Found: 无播放器状态
            if (res.status === 404) {
                console.warn('[SpotifyAuth] 未找到播放器状态');
                return false;
            }

            // 401 Unauthorized: 令牌失效
            if (res.status === 401) {
                console.warn('[SpotifyAuth] 令牌过期或无效');
                this.logout();
                return false;
            }

            // 200 OK: 正常
            if (res.ok) {
                const data = await res.json();
                if (!data.device) {
                    return await this.activateFirstDevice();
                }
                return true;
            }
            
            return false;
        } catch (e) {
            console.error('[SpotifyAuth] 连接检查失败:', e);
            return false;
        }
    }

    /**
     * 尝试激活用户设备列表中的第一个设备
     * 当没有活跃设备时调用
     */
    static async activateFirstDevice(): Promise<boolean> {
        if (!this.hasClientId()) return false;
        
        const token = await this.getAccessToken();
        if (!token) return false;

        try {
            // 获取设备列表
            const devicesRes = await fetch(`${API_BASE}/me/player/devices`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (!devicesRes.ok) return false;
            
            const data = await devicesRes.json();
            const devices = data.devices || [];
            
            if (devices.length > 0) {
                const target = devices[0].id;
                console.log(`[SpotifyAuth] 激活设备: ${devices[0].name} (${target})`);
                
                // 转移播放权
                await fetch(`${API_BASE}/me/player`, {
                    method: 'PUT',
                    headers: { 
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ device_ids: [target] })
                });
                return true;
            }
            return false;
        } catch (e) {
            console.error('[SpotifyAuth] 设备激活失败:', e);
            return false;
        }
    }

    /**
     * 启动 OAuth2 登录流程 (PKCE 模式)
     * 1. 生成 Code Verifier 和 Challenge
     * 2. 启动本地 Web 服务器接收回调
     * 3. 打开浏览器进行授权
     * 4. 换取 Access Token
     */
    static async login(): Promise<void> {
        if (!this.clientId) {
            throw new Error("Client ID 未设置");
        }

        const verifier = this.generateCodeVerifier(128);
        const challenge = await this.generateCodeChallenge(verifier);
        const state = this.generateRandomString(16);

        // 调用 Rust 后端启动本地服务器监听回调
        // 该 Promise 会在接收到 code 后 resolve
        const codePromise = invoke<string>('start_auth_server');

        const params = new URLSearchParams({
            response_type: 'code',
            client_id: this.clientId,
            scope: SCOPES,
            redirect_uri: REDIRECT_URI,
            state: state,
            code_challenge_method: 'S256',
            code_challenge: challenge,
        });

        // 打开默认浏览器
        const url = `${AUTH_ENDPOINT}?${params.toString()}`;
        window.open(url, '_blank');

        try {
            // 等待用户授权并获取 code
            const code = await codePromise;
            // 换取令牌
            await this.exchangeCodeForToken(code, verifier);
            console.log('[SpotifyAuth] 登录成功');
        } catch (e) {
            console.error('[SpotifyAuth] 登录失败:', e);
            throw e;
        }
    }

    /**
     * 获取有效的 Access Token
     * 如果当前令牌已过期，会自动刷新
     */
    static async getAccessToken(): Promise<string | null> {
        if (!this.accessToken && !this.refreshToken) return null;

        // 检查过期时间
        if (Date.now() > this.expirationTime) {
            await this.refreshAccessToken();
        }

        return this.accessToken;
    }

    /**
     * 使用授权码换取令牌
     */
    private static async exchangeCodeForToken(code: string, verifier: string) {
        const params = new URLSearchParams({
            client_id: this.clientId,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
        });

        const res = await fetch(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => res.statusText);
            throw new Error(`Token exchange failed (${res.status}): ${errText}`);
        }

        const data: TokenResponse = await res.json();
        this.saveSession(data);
    }

    /**
     * 使用 Refresh Token 刷新 Access Token
     */
    private static async refreshAccessToken() {
        if (!this.refreshToken) return;

        const params = new URLSearchParams({
            client_id: this.clientId,
            grant_type: 'refresh_token',
            refresh_token: this.refreshToken,
        });

        const res = await fetch(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });

        if (!res.ok) {
            console.error('[SpotifyAuth] Token refresh failed:', res.status, res.statusText);
            this.logout();
            return;
        }

        const data = await res.json();
        this.saveSession(data);
    }

    /**
     * 保存会话信息到 localStorage
     */
    private static saveSession(data: any) {
        this.accessToken = data.access_token;
        if (data.refresh_token) {
            this.refreshToken = data.refresh_token;
            localStorage.setItem('spotify_refresh_token', this.refreshToken);
        }
        // 计算绝对过期时间 (预留 60s 缓冲)
        this.expirationTime = Date.now() + (data.expires_in * 1000);
        
        localStorage.setItem('spotify_access_token', this.accessToken);
        localStorage.setItem('spotify_expiration_time', this.expirationTime.toString());
    }

    // --- PKCE 辅助函数 ---

    private static generateRandomString(length: number) {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < length; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private static generateCodeVerifier(length: number) {
        return this.generateRandomString(length);
    }

    private static async generateCodeChallenge(codeVerifier: string) {
        const encoder = new TextEncoder();
        const data = encoder.encode(codeVerifier);
        const digest = await window.crypto.subtle.digest('SHA-256', data);
        const bytes = new Uint8Array(digest);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }
}
