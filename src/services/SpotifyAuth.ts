import { invoke } from '@tauri-apps/api/core';

const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private';
const REDIRECT_URI = 'http://localhost:8888/callback';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';
const API_BASE = 'https://api.spotify.com/v1';

interface TokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
    expires_in: number;
    refresh_token: string;
}

export class SpotifyAuth {
    private static clientId = '';
    private static accessToken = '';
    private static refreshToken = '';
    private static expirationTime = 0;

    static init() {
        this.clientId = localStorage.getItem('spotify_client_id') || '';
        this.accessToken = localStorage.getItem('spotify_access_token') || '';
        this.refreshToken = localStorage.getItem('spotify_refresh_token') || '';
        this.expirationTime = parseInt(localStorage.getItem('spotify_expiration_time') || '0');
        
        if (!this.clientId) {
            console.log("Spotify Client ID not found. Running in optional mode (No Spotify Integration).");
        }
    }

    static setClientId(id: string) {
        if (!id) {
            this.clientId = '';
            localStorage.removeItem('spotify_client_id');
            this.logout(); // Clear tokens as they are useless without Client ID
            return;
        }
        this.clientId = id;
        localStorage.setItem('spotify_client_id', id);
    }

    static hasClientId(): boolean {
        return !!this.clientId;
    }

    static isLoggedIn(): boolean {
        return !!this.refreshToken;
    }

    static logout() {
        this.accessToken = '';
        this.refreshToken = '';
        this.expirationTime = 0;
        localStorage.removeItem('spotify_access_token');
        localStorage.removeItem('spotify_refresh_token');
        localStorage.removeItem('spotify_expiration_time');
        console.log("Logged out from Spotify (Local Session Cleared)");
    }

    static async checkConnection(): Promise<boolean> {
        // Guard clause for optional mode
        if (!this.hasClientId()) {
            return false;
        }

        const token = await this.getAccessToken();
        if (!token) return false;

        try {
            const res = await fetch(`${API_BASE}/me/player`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.status === 204) {
                console.warn('Spotify: Active but no content playing.');
                return true;
            }
            
            if (res.status === 404) {
                console.warn('Spotify: No active device found.');
                return await this.activateFirstDevice();
            }

            if (res.status === 401) {
                console.warn('Spotify: Token expired or invalid.');
                this.logout();
                return false;
            }

            if (res.ok) {
                const data = await res.json();
                if (!data.device) {
                    return await this.activateFirstDevice();
                }
                return true;
            }
            
            return false;
        } catch (e) {
            console.error('Spotify Connection Check Failed:', e);
            return false;
        }
    }

    static async activateFirstDevice(): Promise<boolean> {
        if (!this.hasClientId()) return false;
        
        const token = await this.getAccessToken();
        if (!token) return false;

        try {
            const devicesRes = await fetch(`${API_BASE}/me/player/devices`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (!devicesRes.ok) return false;
            
            const data = await devicesRes.json();
            const devices = data.devices || [];
            
            if (devices.length > 0) {
                const target = devices[0].id;
                console.log(`Activating device: ${devices[0].name} (${target})`);
                
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
            console.error('Device activation failed:', e);
            return false;
        }
    }

    static async login(): Promise<void> {
        if (!this.clientId) {
            throw new Error("Client ID not set");
        }

        const verifier = this.generateCodeVerifier(128);
        const challenge = await this.generateCodeChallenge(verifier);
        const state = this.generateRandomString(16);

        // Start local server to catch callback
        // This promise resolves when the code is received
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

        // Open browser
        const url = `${AUTH_ENDPOINT}?${params.toString()}`;
        window.open(url, '_blank');

        try {
            const code = await codePromise;
            await this.exchangeCodeForToken(code, verifier);
            console.log('Spotify Login Successful');
        } catch (e) {
            console.error('Login failed:', e);
            throw e;
        }
    }

    static async getAccessToken(): Promise<string | null> {
        if (!this.accessToken && !this.refreshToken) return null;

        if (Date.now() > this.expirationTime) {
            await this.refreshAccessToken();
        }

        return this.accessToken;
    }

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

        const data: TokenResponse = await res.json();
        this.saveSession(data);
    }

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

        const data = await res.json();
        this.saveSession(data);
    }

    private static saveSession(data: any) {
        this.accessToken = data.access_token;
        if (data.refresh_token) {
            this.refreshToken = data.refresh_token;
            localStorage.setItem('spotify_refresh_token', this.refreshToken);
        }
        this.expirationTime = Date.now() + (data.expires_in * 1000);
        
        localStorage.setItem('spotify_access_token', this.accessToken);
        localStorage.setItem('spotify_expiration_time', this.expirationTime.toString());
    }

    // Helper functions
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
        
        return btoa(String.fromCharCode(...new Uint8Array(digest)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }
}