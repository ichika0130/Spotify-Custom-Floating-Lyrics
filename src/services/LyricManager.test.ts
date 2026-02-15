
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LyricManager, TrackInfo } from './LyricManager';

// Mock dependencies
const mockInvoke = vi.fn();
const mockExists = vi.fn();
const mockReadTextFile = vi.fn();
const mockWriteTextFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: any[]) => mockInvoke(...args)
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { AppData: 'AppData' },
    exists: (...args: any[]) => mockExists(...args),
    readTextFile: (...args: any[]) => mockReadTextFile(...args),
    writeTextFile: (...args: any[]) => mockWriteTextFile(...args),
    mkdir: (...args: any[]) => mockMkdir(...args)
}));

vi.mock('./SpotifyAuth', () => ({
    SpotifyAuth: {
        init: vi.fn(),
        getAccessToken: vi.fn().mockResolvedValue(null), // Default to no token
        isLoggedIn: vi.fn().mockReturnValue(false)
    }
}));

describe('LyricManager Fuzzy Search', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: Cache miss
        mockExists.mockResolvedValue(false);
    });

    it('should clean title correctly', () => {
        // Access private method via casting to any
        const cleanTitle = (LyricManager as any).cleanTitle;
        
        expect(cleanTitle('Song Title (Remastered)')).toBe('Song Title');
        expect(cleanTitle('Song Title - Radio Edit')).toBe('Song Title');
        expect(cleanTitle('Song Title (Radio Edit)')).toBe('Song Title');
        expect(cleanTitle('Song Title (feat. Artist)')).toBe('Song Title');
        expect(cleanTitle('Song Title (Explicit)')).toBe('Song Title');
    });

    it('should match lyrics when duration is within tolerance (3s)', async () => {
        const track: TrackInfo = { title: 'Test Song', artist: 'Test Artist', duration: 200 };
        
        // Mock LrcLib response
        const searchResults = [
            { trackName: 'Test Song', artistName: 'Test Artist', duration: 198, plainLyrics: 'Lyrics 1' }, // diff 2s -> Match
            { trackName: 'Test Song', artistName: 'Test Artist', duration: 210, plainLyrics: 'Lyrics 2' }  // diff 10s
        ];
        
        mockInvoke.mockImplementation((cmd, _args) => {
            if (cmd === 'fetch_proxy') {
                return Promise.resolve(JSON.stringify(searchResults));
            }
            return Promise.resolve(null);
        });

        const result = await LyricManager.getLyrics(track);
        expect(result).toBe('Lyrics 1');
    });

    it('should handle duration in milliseconds (convert to seconds)', async () => {
        const track: TrackInfo = { title: 'Test Song', artist: 'Test Artist', duration: 200000 }; // 200s in ms
        
        const searchResults = [
            { trackName: 'Test Song', artistName: 'Test Artist', duration: 198, plainLyrics: 'Lyrics 1' }, // diff 2s -> Match
            { trackName: 'Test Song', artistName: 'Test Artist', duration: 210, plainLyrics: 'Lyrics 2' }
        ];
        
        mockInvoke.mockResolvedValue(JSON.stringify(searchResults));

        const result = await LyricManager.getLyrics(track);
        expect(result).toBe('Lyrics 1');
    });

    it('should fallback to first result when track duration is 0', async () => {
        const track: TrackInfo = { title: 'Test Song', artist: 'Test Artist', duration: 0 };
        
        const searchResults = [
            { trackName: 'Test Song', artistName: 'Test Artist', duration: 300, plainLyrics: 'Lyrics First' },
            { trackName: 'Test Song', artistName: 'Test Artist', duration: 300, plainLyrics: 'Lyrics Second' }
        ];
        
        mockInvoke.mockResolvedValue(JSON.stringify(searchResults));

        const result = await LyricManager.getLyrics(track);
        expect(result).toBe('Lyrics First');
    });

    it('should return null if no lyrics match duration criteria', async () => {
        const track: TrackInfo = { title: 'Test Song', artist: 'Test Artist', duration: 200 };
        
        const searchResults = [
            { trackName: 'Test Song', artistName: 'Test Artist', duration: 210, plainLyrics: 'Lyrics 1' }, // diff 10s
            { trackName: 'Test Song', artistName: 'Test Artist', duration: 190, plainLyrics: 'Lyrics 2' }  // diff 10s
        ];
        
        mockInvoke.mockResolvedValue(JSON.stringify(searchResults));

        const result = await LyricManager.getLyrics(track);
        expect(result).toBe(null);
    });
});
