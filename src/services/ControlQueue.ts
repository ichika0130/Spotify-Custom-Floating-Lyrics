
import { invoke } from "@tauri-apps/api/core";

/**
 * 控制队列配置接口
 * 定义了重试、退避和冷却策略的参数
 */
export interface ControlConfig {
    /** 最大重试次数 */
    MAX_RETRIES: number;
    /** 初始重试延迟 (ms) */
    INITIAL_RETRY_DELAY: number;
    /** 最大重试延迟 (ms) */
    MAX_RETRY_DELAY: number;
    /** 退避因子 (每次重试延迟乘以该系数) */
    BACKOFF_FACTOR: number;
    /** 操作冷却时间 (ms) */
    COOLDOWN: number;
}

/** 默认控制配置 */
export const DEFAULT_CONTROL_CONFIG: ControlConfig = {
    MAX_RETRIES: 5,
    INITIAL_RETRY_DELAY: 500,
    MAX_RETRY_DELAY: 3000,
    BACKOFF_FACTOR: 2.0,
    COOLDOWN: 1500
};

/**
 * 播放控制命令队列管理器
 * 负责串行执行 Spotify/SMTC 控制命令 (如播放、暂停、切歌)
 * 解决了并发调用导致的冲突和系统忙 (0x80010002) 问题
 */
export class ControlQueue {
    /** 命令队列 */
    private queue: string[] = [];
    /** 是否正在处理队列 */
    private isProcessing = false;
    /** 组件是否已挂载 (防止在卸载后执行) */
    private isMounted = true;
    /** 配置参数 */
    private config: ControlConfig;

    /**
     * 构造函数
     * @param config 配置对象，默认为 DEFAULT_CONTROL_CONFIG
     */
    constructor(config: ControlConfig = DEFAULT_CONTROL_CONFIG) {
        this.config = config;
    }

    /**
     * 设置挂载状态
     * @param mounted 是否挂载
     */
    setMounted(mounted: boolean) {
        this.isMounted = mounted;
    }

    /**
     * 将命令推入队列并等待执行完成 (fire-and-forget queue, resolves once enqueued)
     * 包含防抖逻辑：如果队尾已经是相同命令，则忽略
     * @param cmd 控制命令 ('play', 'pause', 'next', 'prev', 'playpause')
     */
    async push(cmd: string) {
        if (this.queue.length > 0 && this.queue[this.queue.length - 1] === cmd) {
            console.log(`[Control] '${cmd}' 被防抖 (已在队列中)`);
            return;
        }
        
        if (this.queue.length >= 3) {
             console.warn(`[Control] 队列已满，丢弃命令 '${cmd}'`);
             return;
        }

        this.queue.push(cmd);
        if (!this.isProcessing) {
            this.process();
        }
    }

    /**
     * 处理队列中的命令
     * 串行执行，直到队列为空
     */
    private async process() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0 && this.isMounted) {
            const cmd = this.queue.shift();
            if (cmd) {
                await this.executeCommand(cmd);
            }
        }

        this.isProcessing = false;
    }

    /**
     * 执行单个命令
     * 包含重试机制和错误处理
     * @param cmd 命令字符串
     */
    private async executeCommand(cmd: string) {
        console.log(`[Control] 执行命令: ${cmd}`);
        
        let attempts = 0;
        let currentDelay = this.config.INITIAL_RETRY_DELAY;

        while (attempts < this.config.MAX_RETRIES) {
            if (!this.isMounted) return;
            try {
                // 调用 Rust 后端接口
                await invoke('spotify_control', { command: cmd });
                console.log(`[Control] '${cmd}' 执行成功`);
                break;
            } catch (e: any) {
                attempts++;
                // 检查是否为 COM 繁忙错误 (RPC_E_CALL_CANCELED)
                const isBusy = e?.toString().includes("0x80010002"); 
                
                if (isBusy && attempts < this.config.MAX_RETRIES) {
                    console.warn(`[Control] '${cmd}' 系统繁忙，重试 (${attempts}/${this.config.MAX_RETRIES})，延迟 ${currentDelay}ms...`);
                    await new Promise(r => setTimeout(r, currentDelay));
                    // 指数退避
                    currentDelay = Math.min(currentDelay * this.config.BACKOFF_FACTOR, this.config.MAX_RETRY_DELAY);
                    continue;
                }
                
                console.error(`[Control] '${cmd}' 失败 (重试 ${attempts} 次):`, e);
                break;
            }
        }

        // 冷却时间：等待 Spotify 状态更新和 SMTC 恢复
        if (this.isMounted) {
            console.log(`[Control] 冷却 ${this.config.COOLDOWN}ms...`);
            await new Promise(r => setTimeout(r, this.config.COOLDOWN));
        }
    }

    /**
     * 检查队列是否忙碌
     */
    isBusy() {
        return this.isProcessing;
    }
}
