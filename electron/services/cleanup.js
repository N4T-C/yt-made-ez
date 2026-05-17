/**
 * Cleanup Service — Electron version
 * Removes all intermediate video files.
 * Base dir is the electron/ folder (where buffer, output, etc. live).
 */
const fs = require('fs');
const path = require('path');

// In Electron, __dirname is electron/ (where this file lives in services/)
// So BASE_DIR is the electron/ folder itself.
const BASE_DIR = path.join(__dirname, '..');

/**
 * Delete all intermediate video files and working directories.
 */
function purgeAllVideos() {
    const cleaned = [];

    // 1. Clean up any video files directly in the electron root directory
    const videoExtensions = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi']);
    const files = fs.readdirSync(BASE_DIR);
    for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        const stat = fs.statSync(path.join(BASE_DIR, f));
        if (stat.isFile() && videoExtensions.has(ext)) {
            try {
                fs.unlinkSync(path.join(BASE_DIR, f));
                cleaned.push(f);
            } catch (e) { /* ignore locked files */ }
        }
    }

    // 3. reels_downloads directory
    const reelsDir = path.join(BASE_DIR, 'reels_downloads');
    if (fs.existsSync(reelsDir)) {
        fs.rmSync(reelsDir, { recursive: true, force: true });
        fs.mkdirSync(reelsDir, { recursive: true });
        cleaned.push('reels_downloads/');
    }

    // 4. buffer directory
    const bufferDir = path.join(BASE_DIR, 'buffer');
    if (fs.existsSync(bufferDir)) {
        fs.rmSync(bufferDir, { recursive: true, force: true });
        fs.mkdirSync(bufferDir, { recursive: true });
        cleaned.push('buffer/');
    }

    if (cleaned.length > 0) {
        console.log(`🧹 Cleanup complete. Removed: ${cleaned.join(', ')}`);
    } else {
        console.log('🧹 Cleanup: nothing to remove.');
    }

    return cleaned;
}

module.exports = { purgeAllVideos };
