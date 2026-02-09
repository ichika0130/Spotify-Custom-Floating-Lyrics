import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { ControlQueue, DEFAULT_CONTROL_CONFIG } from './ControlQueue';

// Mock Tauri invoke
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
    invoke: (cmd: string, args: any) => mockInvoke(cmd, args)
}));

describe('ControlQueue', () => {
    let queue: ControlQueue;
    
    beforeEach(() => {
        vi.clearAllMocks();
        // Use faster config for tests
        queue = new ControlQueue({
            ...DEFAULT_CONTROL_CONFIG,
            INITIAL_RETRY_DELAY: 10,
            COOLDOWN: 10
        });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('should execute command successfully', async () => {
        mockInvoke.mockResolvedValueOnce(undefined);
        
        const promise = queue.push('playpause');
        
        // Wait for async execution
        await vi.runAllTimersAsync();
        await promise;

        expect(mockInvoke).toHaveBeenCalledWith('spotify_control', { command: 'playpause' });
        expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    test('should debounce duplicate commands', async () => {
        mockInvoke.mockResolvedValue(undefined);
        
        // Push twice quickly
        queue.push('next');
        queue.push('next');
        
        // Advance time enough for processing + cooldowns
        await vi.advanceTimersByTimeAsync(1000);
        
        expect(mockInvoke).toHaveBeenCalledTimes(2); 
    });
    
    test('should debounce when queue is busy', async () => {
        // Mock invoke to be slow (50ms)
        mockInvoke.mockImplementation(() => new Promise(r => setTimeout(r, 50)));
        
        queue.push('prev'); 
        queue.push('prev'); 
        queue.push('prev'); 
        
        // Advance time: 
        // 1st execute (50ms) + Cooldown (10ms)
        // 2nd execute (50ms) + Cooldown (10ms)
        await vi.advanceTimersByTimeAsync(500);
        
        expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    test('should retry on SMTC Busy (0x80010002)', async () => {
        // First 2 fail with Busy, 3rd succeeds
        mockInvoke
            .mockRejectedValueOnce("Error: 0x80010002 Message Filter Cancelled")
            .mockRejectedValueOnce("Error: 0x80010002 Message Filter Cancelled")
            .mockResolvedValueOnce(undefined);

        queue.push('playpause');
        
        // Initial (0) + Retry1 (10) + Retry2 (20) + Success + Cooldown (10)
        await vi.advanceTimersByTimeAsync(1000);
        
        expect(mockInvoke).toHaveBeenCalledTimes(3);
    });
});
