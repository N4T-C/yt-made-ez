/**
 * Centralized binary path resolver for Electron production builds.
 *
 * Problem: When Electron packages the app, everything goes into app.asar
 * (a read-only archive). Native binaries (yt-dlp, ffmpeg, ffprobe) cannot
 * be executed from inside an asar. electron-builder's `asarUnpack` extracts
 * them to app.asar.unpacked/, but the npm packages still resolve paths
 * pointing inside the asar.
 *
 * Solution: In production (app.isPackaged), we use process.resourcesPath
 * to construct direct paths into app.asar.unpacked/. In development,
 * we use the paths as-is from the npm packages.
 */
const path = require('path');
const { app } = require('electron');
const { ffmpegPath: rawFfmpegPath, ffprobePath: rawFfprobePath } = require('ffmpeg-ffprobe-static');

/**
 * Replace any 'app.asar' segment with 'app.asar.unpacked' so the OS
 * can actually execute the binary. Works for both forward and back slashes.
 */
function fixAsarPath(p) {
    if (p && p.includes('app.asar')) {
        return p.replace('app.asar', 'app.asar.unpacked');
    }
    return p;
}

/**
 * Resolve yt-dlp binary path.
 * The yt-dlp-exec package ships the binary under node_modules/yt-dlp-exec/bin/.
 */
function getYtDlpPath() {
    const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

    if (app && app.isPackaged) {
        // In production, go straight to the unpacked location
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'yt-dlp-exec', 'bin', binName);
    }

    // In development, resolve relative to this file's location
    return path.join(__dirname, '..', 'node_modules', 'yt-dlp-exec', 'bin', binName);
}

/**
 * Resolve ffmpeg binary path.
 */
function getFfmpegPath() {
    if (app && app.isPackaged) {
        return fixAsarPath(rawFfmpegPath);
    }
    return rawFfmpegPath;
}

/**
 * Resolve ffprobe binary path.
 */
function getFfprobePath() {
    if (app && app.isPackaged) {
        return fixAsarPath(rawFfprobePath);
    }
    return rawFfprobePath;
}

/**
 * Resolve the app's own source root (the directory containing main.js).
 * In dev this is the electron/ folder on disk.
 * In production this is inside app.asar (read-only but readable by Electron's patched fs).
 */
function getAppRoot() {
    if (app) {
        return app.getAppPath();
    }
    return path.join(__dirname, '..');
}

module.exports = { getYtDlpPath, getFfmpegPath, getFfprobePath, getAppRoot };
