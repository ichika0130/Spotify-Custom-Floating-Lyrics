import { describe, test, expect, beforeEach, vi } from 'vitest';
import { SpotifyAuth } from './SpotifyAuth';

// Mock fetch and localStorage
const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockLocalStorage = {
    store: {} as Record<string, string>,
    getItem: (key: string) => mockLocalStorage.store[key] || null,
    setItem: (key: string, value: string) => { mockLocalStorage.store[key] = value; },
    clear: () => { mockLocalStorage.store = {}; },
    removeItem: (key: string) => { delete mockLocalStorage.store[key]; }
};

// Mock global objects
global.localStorage = mockLocalStorage as any;
global.window = {
    location: { href: '' },
    close: vi.fn()
} as any;

describe('SpotifyAuth Connectivity', () => {
    beforeEach(() => {
        mockFetch.mockClear();
        mockLocalStorage.clear();
        SpotifyAuth.init();
    });

    test('should handle token expiration (401) by returning false', async () => {
        mockLocalStorage.setItem('spotify_client_id', 'test_client_id');
        mockLocalStorage.setItem('spotify_access_token', 'expired_token');
        mockLocalStorage.setItem('spotify_refresh_token', 'valid_refresh');
        mockLocalStorage.setItem('spotify_expiration_time', (Date.now() + 10000).toString());
        SpotifyAuth.init();
        
        // Mock /me/player returning 401
        mockFetch.mockResolvedValueOnce({
            status: 401,
            ok: false
        });

        const result = await SpotifyAuth.checkConnection();
        expect(result).toBe(false);
        // Should log warning about expiration
    });

    test('should attempt device activation when no active device found (404)', async () => {
        mockLocalStorage.setItem('spotify_client_id', 'test_client_id');
        mockLocalStorage.setItem('spotify_access_token', 'valid_token');
        mockLocalStorage.setItem('spotify_expiration_time', (Date.now() + 10000).toString());
        SpotifyAuth.init();
        
        // First call: 404 No Active Device
        mockFetch.mockResolvedValueOnce({
            status: 404,
            ok: false
        });

        // Second call: getDevices
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ devices: [{ id: 'dev1', name: 'PC' }] })
        });

        // Third call: PUT /me/player (activate)
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 204
        });

        const result = await SpotifyAuth.checkConnection();
        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    test('should handle network failure gracefully', async () => {
        mockLocalStorage.setItem('spotify_client_id', 'test_client_id'); // Ensure ID exists for this test
        mockLocalStorage.setItem('spotify_access_token', 'valid_token');
        mockLocalStorage.setItem('spotify_expiration_time', (Date.now() + 10000).toString());
        SpotifyAuth.init();
        mockFetch.mockRejectedValue(new Error('Network Error'));

        const result = await SpotifyAuth.checkConnection();
        expect(result).toBe(false);
    });

    test('should return false immediately if Client ID is missing (Optional Mode)', async () => {
        // Ensure no Client ID
        mockLocalStorage.removeItem('spotify_client_id');
        SpotifyAuth.init();

        const result = await SpotifyAuth.checkConnection();
        expect(result).toBe(false);
        // Should not call fetch
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
