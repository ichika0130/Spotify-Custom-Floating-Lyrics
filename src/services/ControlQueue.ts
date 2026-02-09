
import { invoke } from "@tauri-apps/api/core";

export interface ControlConfig {
    MAX_RETRIES: number;
    INITIAL_RETRY_DELAY: number;
    MAX_RETRY_DELAY: number;
    BACKOFF_FACTOR: number;
    COOLDOWN: number;
}

export const DEFAULT_CONTROL_CONFIG: ControlConfig = {
    MAX_RETRIES: 5,
    INITIAL_RETRY_DELAY: 500,
    MAX_RETRY_DELAY: 3000,
    BACKOFF_FACTOR: 2.0,
    COOLDOWN: 1500
};

export class ControlQueue {
    private queue: string[] = [];
    private isProcessing = false;
    private isMounted = true;
    private config: ControlConfig;

    constructor(config: ControlConfig = DEFAULT_CONTROL_CONFIG) {
        this.config = config;
    }

    setMounted(mounted: boolean) {
        this.isMounted = mounted;
    }

    async push(cmd: string) {
        // Debounce: If the last item is same, don't add
        if (this.queue.length > 0 && this.queue[this.queue.length - 1] === cmd) {
            console.log(`[Control] '${cmd}' debounced (already in queue)`);
            return;
        }
        
        // Limit queue size
        if (this.queue.length >= 3) {
             console.warn(`[Control] Queue full, dropping '${cmd}'`);
             return;
        }

        this.queue.push(cmd);
        this.process();
    }

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

    private async executeCommand(cmd: string) {
        console.log(`[Control] Executing: ${cmd}`);
        
        let attempts = 0;
        let currentDelay = this.config.INITIAL_RETRY_DELAY;

        while (attempts < this.config.MAX_RETRIES) {
            if (!this.isMounted) return;
            try {
                await invoke('spotify_control', { command: cmd });
                console.log(`[Control] '${cmd}' success`);
                break;
            } catch (e: any) {
                attempts++;
                const isBusy = e?.toString().includes("0x80010002"); // RPC_E_CALL_CANCELED
                
                if (isBusy && attempts < this.config.MAX_RETRIES) {
                    console.warn(`[Control] '${cmd}' busy, retrying (${attempts}/${this.config.MAX_RETRIES}) in ${currentDelay}ms...`);
                    await new Promise(r => setTimeout(r, currentDelay));
                    // Exponential backoff
                    currentDelay = Math.min(currentDelay * this.config.BACKOFF_FACTOR, this.config.MAX_RETRY_DELAY);
                    continue;
                }
                
                console.error(`[Control] '${cmd}' failed after ${attempts} attempts:`, e);
                break;
            }
        }

        // Cooldown to let Spotify state update and SMTC recover
        if (this.isMounted) {
            console.log(`[Control] Cooldown ${this.config.COOLDOWN}ms...`);
            await new Promise(r => setTimeout(r, this.config.COOLDOWN));
        }
    }

    isBusy() {
        return this.isProcessing;
    }
}
