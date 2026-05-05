/**
 * 歌词搜索状态枚举
 * 用于区分 UI 的不同展示阶段
 */
export enum SearchStatus {
    IDLE = 'IDLE',           // 空闲
    SEARCHING = 'SEARCHING', // 搜索中
    FOUND = 'FOUND',         // 已找到歌词
    NOT_FOUND = 'NOT_FOUND', // 未找到歌词
    ERROR = 'ERROR'          // 发生错误
}

/**
 * 当前播放歌曲的状态接口
 */
export interface TrackState {
    title: string;
    artist: string;
    duration: number;
    id: string; // 唯一标识 (Artist - Title)
}

/**
 * 歌词 UI 状态管理器 (单例模式)
 * 统一管理歌词显示、搜索状态、锁定状态等
 * 确保 UI 组件与业务逻辑的状态同步
 */
export class LyricUIState {
    private static instance: LyricUIState;

    // --- 状态变量 ---
    
    /** 当前搜索状态 */
    public searchStatus: SearchStatus = SearchStatus.IDLE;
    
    /** 当前加载的歌词行 */
    public lrcLines: { time: number; text: string }[] = [];
    
    /** 当前播放的歌曲信息 */
    public currentTrack: TrackState | null = null;
    
    /** 窗口是否锁定 */
    public isLocked: boolean = false;
    
    /** 状态转换日志 (用于调试) */
    private stateLog: string[] = [];

    /**
     * 私有构造函数，强制单例
     */
    private constructor() {}

    /**
     * 获取单例实例
     */
    public static getInstance(): LyricUIState {
        if (!LyricUIState.instance) {
            LyricUIState.instance = new LyricUIState();
        }
        return LyricUIState.instance;
    }

    /**
     * 重置状态（用于切歌时）
     */
    public resetForNewSong() {
        this.logTransition(`Resetting for new song`);
        this.searchStatus = SearchStatus.IDLE;
        this.lrcLines = [];
        // currentTrack 不在这里重置，而是由 updateTrack 更新
    }

    /**
     * 更新当前歌曲信息
     * 如果检测到切歌，会自动触发重置
     * @returns boolean 是否发生了切歌
     */
    public updateTrack(title: string, artist: string, duration: number): boolean {
        const newId = `${artist} - ${title}`;
        
        if (!this.currentTrack || this.currentTrack.id !== newId) {
            this.logTransition(`Track Changed: ${this.currentTrack?.id} -> ${newId}`);
            this.currentTrack = {
                title,
                artist,
                duration,
                id: newId
            };
            this.resetForNewSong();
            return true;
        }
        return false;
    }

    /**
     * 设置搜索状态
     */
    public setSearchStatus(status: SearchStatus) {
        if (this.searchStatus !== status) {
            this.logTransition(`Search Status: ${this.searchStatus} -> ${status}`);
            this.searchStatus = status;
        }
    }

    /**
     * 设置歌词行数据
     */
    public setLrcLines(lines: { time: number; text: string }[]) {
        this.lrcLines = lines;
        if (lines.length > 0) {
            this.setSearchStatus(SearchStatus.FOUND);
        }
    }

    /**
     * 设置锁定状态
     */
    public setLocked(locked: boolean) {
        if (this.isLocked !== locked) {
            this.logTransition(`Lock State: ${this.isLocked} -> ${locked}`);
            this.isLocked = locked;
        }
    }

    /**
     * 记录状态转换日志
     */
    private logTransition(msg: string) {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
        const logEntry = `[${timestamp}] ${msg}`;
        this.stateLog.push(logEntry);
        // 保持日志长度适中
        if (this.stateLog.length > 50) {
            this.stateLog.shift();
        }
        console.log(`[UIState] ${msg}`);
    }

    /**
     * 获取最近的日志
     */
    public getLog(): string[] {
        return [...this.stateLog];
    }
}
