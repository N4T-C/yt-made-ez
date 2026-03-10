/**
 * Reel Download Service — Robust port of reel_download.py
 * Downloads Instagram/YouTube clips via yt-dlp (invoked as `python -m yt_dlp`).
 *
 * WHY python -m yt_dlp?
 * On this system yt-dlp is installed as a Python package (not in PATH as an exe).
 * Using `python -m yt_dlp` always works regardless of PATH setup.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER_ROOT = path.join(__dirname, '..');
const REELS_DIR = path.join(SERVER_ROOT, 'reels_downloads');
const BUFFER_DIR = path.join(SERVER_ROOT, 'buffer');

// ── yt-dlp invocation config ───────────────────────────────────────────────
// We use `spawn('python', ['-m', 'yt_dlp', ...])` which is always reliable
// when yt-dlp is installed via pip (even without it being in PATH).
// You can override the python path via PYTHON_PATH in .env.
const PYTHON_CMD = process.env.PYTHON_PATH || 'python';

/**
 * Get the next available buffer folder (numbered 1, 2, 3 …).
 */
function getNextBufferFolder() {
    if (!fs.existsSync(BUFFER_DIR)) {
        fs.mkdirSync(BUFFER_DIR, { recursive: true });
    }

    const existing = fs.readdirSync(BUFFER_DIR)
        .filter(d => {
            try { return fs.statSync(path.join(BUFFER_DIR, d)).isDirectory() && /^\d+$/.test(d); }
            catch { return false; }
        })
        .map(Number);

    const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
    const folderPath = path.join(BUFFER_DIR, String(next));
    fs.mkdirSync(folderPath, { recursive: true });
    return folderPath;
}

/**
 * Move all video files from source into destination, renaming to clip_001.mp4 etc.
 */
function moveToFolder(destination, source = REELS_DIR) {
    if (!fs.existsSync(destination)) {
        fs.mkdirSync(destination, { recursive: true });
    }

    const VIDEO_EXT = /\.(mp4|mkv|webm|mov|avi)$/i;
    const files = fs.readdirSync(source).filter(f => VIDEO_EXT.test(f));

    if (files.length === 0) {
        throw new Error(
            `No video file was downloaded to staging dir (${source}). ` +
            `Check that the link is public and accessible.`
        );
    }

    for (const filename of files) {
        const existing = fs.readdirSync(destination).filter(f => f.endsWith('.mp4'));
        const newName = `clip_${String(existing.length + 1).padStart(3, '0')}.mp4`;
        fs.renameSync(path.join(source, filename), path.join(destination, newName));
        console.log(`  ✅ Moved: ${filename} → ${newName}`);
    }
}

/**
 * Download a clip using yt-dlp (via python -m yt_dlp).
 *
 * @param {string} url          - Instagram reel / YouTube video URL
 * @param {string} bufferFolder - Where to move the downloaded file
 * @returns {Promise<void>}
 */
function downloadInstagramReel(url, bufferFolder) {
    return new Promise((resolve, reject) => {
        const reelUrl = url.trim();

        // Ensure staging directory exists and is clean
        if (!fs.existsSync(REELS_DIR)) {
            fs.mkdirSync(REELS_DIR, { recursive: true });
        }
        // Clean leftover partial files from previous attempts
        try {
            const leftovers = fs.readdirSync(REELS_DIR);
            for (const f of leftovers) {
                fs.unlinkSync(path.join(REELS_DIR, f));
            }
        } catch { /* ignore */ }

        const outputTemplate = path.join(REELS_DIR, '%(id)s.%(ext)s');

        // yt-dlp args: prefer best mp4, fall back to merge then any format
        const ytdlpArgs = [
            '-m', 'yt_dlp',
            '--no-warnings',
            '--no-playlist',
            '--no-check-certificates',
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
            '--merge-output-format', 'mp4',
            '-o', outputTemplate,
            reelUrl,
        ];

        console.log(`\n📥 Downloading: ${reelUrl}`);
        console.log(`   Using: ${PYTHON_CMD} -m yt_dlp`);

        const proc = spawn(PYTHON_CMD, ytdlpArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            timeout: 300000, // 5 minutes
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
        proc.stderr.on('data', d => { stderr += d.toString(); });

        proc.on('error', (err) => {
            reject(new Error(
                `Failed to launch yt-dlp via "${PYTHON_CMD} -m yt_dlp".\n` +
                `Make sure Python + yt-dlp are installed (pip install yt-dlp).\n` +
                `Error: ${err.message}`
            ));
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                const errMsg = (stderr + stdout).slice(-500);
                console.error('yt-dlp exit code:', code);
                console.error('yt-dlp output:', errMsg);
                return reject(new Error(
                    `yt-dlp failed (exit ${code}) for URL: ${reelUrl}\n\n` +
                    `Details: ${errMsg}`
                ));
            }

            try {
                moveToFolder(bufferFolder, REELS_DIR);

                // Wipe staging dir for next download
                fs.rmSync(REELS_DIR, { recursive: true, force: true });
                fs.mkdirSync(REELS_DIR, { recursive: true });

                console.log(`✅ Download complete → ${bufferFolder}`);
                resolve();
            } catch (moveErr) {
                reject(new Error(
                    `Download completed but file move failed: ${moveErr.message}\n` +
                    `yt-dlp stdout: ${stdout.slice(0, 200)}`
                ));
            }
        });
    });
}

module.exports = { downloadInstagramReel, getNextBufferFolder, BUFFER_DIR };
