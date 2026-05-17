/**
 * Electron Preload Script
 *
 * Exposes a safe, typed `window.electronAPI` bridge to the renderer.
 * The renderer (React app) calls these methods instead of axios/socket.io.
 * OAuth flow: main process handles Google redirect via custom URI scheme
 * and pushes tokens to renderer via 'auth:tokensReceived'.
 *
 * All IPC calls use ipcRenderer.invoke (async request/reply).
 * Push events from the main process arrive via ipcRenderer.on.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // ── Video processing ────────────────────────────────────────────────────
    /**
     * Start 5-clip processing pipeline.
     * @returns {Promise<{jobId: string}>}
     */
    processVideo: (args) => ipcRenderer.invoke('video:process', args),

    /**
     * Start 3-clip processing pipeline.
     * @returns {Promise<{jobId: string}>}
     */
    processVideo3: (args) => ipcRenderer.invoke('video:process3', args),

    /**
     * Poll a job's current status.
     * @returns {Promise<{status, progress, message, outputFile?}>}
     */
    getJobStatus: (jobId) => ipcRenderer.invoke('video:status', { jobId }),

    /**
     * Get the absolute local path of the finished video file.
     * Use with the custom `videofile://` protocol to play it.
     * @returns {Promise<string>} absolute file path
     */
    getVideoFilePath: (jobId) => ipcRenderer.invoke('video:getFilePath', { jobId }),

    /**
     * Upload the finished video to YouTube.
     * @returns {Promise<{success: boolean, videoId: string}>}
     */
    uploadToYouTube: (args) => ipcRenderer.invoke('video:upload', args),

    /**
     * Share the finished video via Filebin.
     * @returns {Promise<{url: string}>}
     */
    shareVideo: (args) => ipcRenderer.invoke('video:share', args),

    /**
     * Clean up all temporary video files.
     */
    cleanupVideos: () => ipcRenderer.invoke('video:cleanup'),

    // ── Auth (Google OAuth via googleapis, no Firebase) ─────────────────────
    /**
     * Get the Google OAuth consent URL.
     * @returns {Promise<{url: string}>}
     */
    getAuthUrl: () => ipcRenderer.invoke('auth:getUrl'),

    /**
     * Exchange auth code for tokens (called after OAuth redirect).
     * @returns {Promise<object>} Google OAuth tokens
     */
    getTokens: (code) => ipcRenderer.invoke('auth:getTokens', { code }),

    /**
     * Get user info from stored tokens.
     * @returns {Promise<{name, email, picture}>}
     */
    getMe: (tokens) => ipcRenderer.invoke('auth:me', { tokens }),

    /**
     * Refresh an expired access token.
     * @returns {Promise<object>} fresh credentials
     */
    refreshToken: (refresh_token) => ipcRenderer.invoke('auth:refresh', { refresh_token }),

    // ── Discord bot ─────────────────────────────────────────────────────────
    /**
     * Start the Discord bot.
     * @returns {Promise<{success, status}>}
     */
    discordStart: (args) => ipcRenderer.invoke('discord:start', args),

    /**
     * Stop the Discord bot.
     */
    discordStop: () => ipcRenderer.invoke('discord:stop'),

    /**
     * Get current Discord bot status.
     * @returns {Promise<{running, logs}>}
     */
    discordStatus: () => ipcRenderer.invoke('discord:status'),

    // ── Event listeners (main → renderer push) ──────────────────────────────
    /**
     * Subscribe to job progress updates.
     * The callback receives the full job state object.
     * Returns an unsubscribe function.
     */
    onJobUpdate: (jobId, callback) => {
        const channel = `job:${jobId}`;
        const listener = (_event, data) => callback(data);
        ipcRenderer.on(channel, listener);
        // Return cleanup function
        return () => ipcRenderer.removeListener(channel, listener);
    },

    /**
     * Subscribe to Discord bot status updates pushed by the main process.
     * Returns an unsubscribe function.
     */
    onDiscordStatus: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('discord:status', listener);
        return () => ipcRenderer.removeListener('discord:status', listener);
    },

    /**
     * Subscribe to OAuth token delivery from main process.
     * Called after user completes Google sign-in in system browser.
     * Returns an unsubscribe function.
     */
    onAuthTokens: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('auth:tokensReceived', listener);
        return () => ipcRenderer.removeListener('auth:tokensReceived', listener);
    },

    /**
     * Open a URL in the system browser (for OAuth sign-in).
     */
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

    /**
     * Trigger a native Save dialog and copy the video to the chosen location.
     * @returns {Promise<{saved: boolean, savePath?: string}>}
     */
    downloadFile: (args) => ipcRenderer.invoke('file:download', args),
});
