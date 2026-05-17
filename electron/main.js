/**
 * Electron Main Process — YT Made EZ
 *
 * Architecture:
 *  - No Express / Socket.IO server
 *  - All backend logic runs here via ipcMain handlers
 *  - Renderer communicates exclusively through preload.js IPC bridge
 *  - Google OAuth handled via yt-made-ez:// custom URI scheme
 *  - Video playback via videofile:// custom protocol (maps to local files)
 */

const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { registerIpcHandlers } = require('./ipcHandlers');
const { purgeAllVideos } = require('./services/cleanup');
const { runStartupChecks } = require('./services/preflight');
const { getTokensFromCode, getUserInfo } = require('./services/youtubeUpload');
const { setMainWindow } = require('./services/discordBot');

// ── Custom URI scheme registration (must be before app.ready) ────────────────
// Registers yt-made-ez:// to catch Google OAuth redirect
app.setAsDefaultProtocolClient('yt-made-ez');

// ── Custom file protocol for local video playback ─────────────────────────────
// Must be registered before app is ready
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'videofile',
        privileges: { secure: true, standard: true, stream: true, bypassCSP: true },
    },
]);

let mainWindow = null;

function getMainWindow() {
    return mainWindow;
}

// ── Create the main window ────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        show: false,
        backgroundColor: '#0f0f1a',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
        },
    });

    // Register the videofile:// protocol handler for local video files
    protocol.handle('videofile', (request) => {
        const { net } = require('electron');
        const urlObj = require('url');
        
        // Remove the custom protocol prefix, and strip any leading slashes
        let filePath = decodeURIComponent(request.url.replace(/^videofile:\/\//i, '').replace(/^\/+/, ''));
        
        // On Windows, if the path looks like "c/Users/..." or "C\Users\...", restore the colon
        if (process.platform === 'win32') {
            if (/^[a-zA-Z][/\\]/.test(filePath)) {
                filePath = filePath[0] + ':' + filePath.slice(1);
            }
        }
        
        // Use net.fetch to correctly stream local files back to the renderer
        const fileUrl = urlObj.pathToFileURL(filePath).toString();
        return net.fetch(fileUrl);
    });

    // Tell discordBot service about the window for IPC push
    setMainWindow(mainWindow);

    // Load renderer
    const isDev = process.env.ELECTRON_DEV === 'true';
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        mainWindow.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
    }

    mainWindow.once('ready-to-show', () => mainWindow.show());

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ── Handle OAuth redirect via custom URI scheme ───────────────────────────────
async function handleOAuthUrl(url) {
    try {
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        const errorParam = parsed.searchParams.get('error');

        if (errorParam) {
            if (mainWindow) mainWindow.webContents.send('auth:tokensReceived', { error: errorParam });
            return;
        }
        if (!code) return;

        const tokens = await getTokensFromCode(code);
        const user = await getUserInfo(tokens);

        if (mainWindow) {
            mainWindow.webContents.send('auth:tokensReceived', { tokens, user });
            mainWindow.focus();
        }
    } catch (err) {
        console.error('OAuth callback error:', err.message);
        if (mainWindow) mainWindow.webContents.send('auth:tokensReceived', { error: err.message });
    }
}

// ── macOS: open-url event fires when app is already running ──────────────────
app.on('open-url', (event, url) => {
    event.preventDefault();
    handleOAuthUrl(url);
});

// ── Windows / Linux: second-instance with --url arg ──────────────────────────
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, argv) => {
        // In Windows, the custom URI is passed as a command-line arg
        const urlArg = argv.find(a => a.startsWith('yt-made-ez://'));
        if (urlArg) handleOAuthUrl(urlArg);
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
    // Startup checks (ffmpeg / ffprobe)
    const startupChecks = runStartupChecks();
    if (!startupChecks.ok) {
        console.error('\n❌ Startup checks failed:');
        for (const err of startupChecks.errors) {
            console.error(`  - ${err}`);
        }
        console.error('\nffmpeg / ffprobe not found. Check your installation.');
        // Show window anyway so user sees the error via the UI
    }

    // Clean up leftover video files from previous sessions
    purgeAllVideos();

    // Register all IPC handlers
    registerIpcHandlers(ipcMain, getMainWindow);

    // Create the window
    createWindow();

    // Periodic cleanup (every 30 min)
    const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS, 10) || 30 * 60 * 1000;
    setInterval(() => purgeAllVideos(), CLEANUP_INTERVAL_MS);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
