/**
 * Reel Download Service — Robust port of reel_download.py
 * Downloads Instagram/YouTube clips via yt-dlp (invoked as `python -m yt_dlp`).
 *
 * WHY python -m yt_dlp?
 * On this system yt-dlp is installed as a Python package (not in PATH as an exe).
 * Using `python -m yt_dlp` always works regardless of PATH setup.
 */
const path = require('path');
const fs = require('fs');
const ytDlpx = require('yt-dlp-exec');
const { ffmpegPath } = require('ffmpeg-ffprobe-static');

const SERVER_ROOT = path.join(__dirname, '..');
const WRITABLE_ROOT = process.env.YT_DATA_DIR || SERVER_ROOT;
const REELS_DIR = path.join(WRITABLE_ROOT, 'reels_downloads');
const BUFFER_DIR = path.join(WRITABLE_ROOT, 'buffer');

const YOUTUBE_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

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
/**
 * Move the downloaded video file to destination with targetName.
 */
function moveToFolderWithTargetName(destination, source, targetName) {
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

    // Rename first matching file to targetName
    const filename = files[0];
    fs.renameSync(path.join(source, filename), path.join(destination, targetName));
    console.log(`  ✅ Moved: ${filename} → ${targetName}`);
}

function extractYouTubeIdFromUrl(urlObj) {
    const host = urlObj.hostname.toLowerCase().replace(/^www\./, '');

    if (host === 'youtu.be') {
        return urlObj.pathname.split('/').filter(Boolean)[0] || '';
    }

    if (host.endsWith('youtube.com')) {
        const parts = urlObj.pathname.split('/').filter(Boolean);

        if (parts[0] === 'watch') {
            return urlObj.searchParams.get('v') || '';
        }

        if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') {
            return parts[1] || '';
        }
    }

    return '';
}

function normalizeDownloadUrl(rawUrl) {
    const trimmed = rawUrl.trim();
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    let parsed;
    try {
        parsed = new URL(withProtocol);
    } catch {
        return trimmed;
    }

    const id = extractYouTubeIdFromUrl(parsed);
    if (!id) {
        return withProtocol;
    }

    if (!YOUTUBE_ID_REGEX.test(id)) {
        throw new Error(
            `Invalid YouTube URL: could not parse a valid 11-character video ID from "${trimmed}". ` +
            `Please paste a full YouTube watch/shorts link.`
        );
    }

    // Force canonical watch URL so yt-dlp reliably uses the YouTube extractor.
    return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Download a clip using yt-dlp (via python -m yt_dlp).
 *
 * @param {string} url          - Instagram reel / YouTube video URL
 * @param {string} bufferFolder - Where to move the downloaded file
 * @param {string} targetName   - Explicit name for the output file (e.g. clip_001.mp4)
 * @returns {Promise<void>}
 */
function downloadInstagramReel(url, bufferFolder, targetName = null) {
    return new Promise(async (resolve, reject) => {
        let reelUrl;

        try {
            reelUrl = normalizeDownloadUrl(url);
        } catch (err) {
            return reject(err);
        }

        const crypto = require('crypto');
        const uniqueId = crypto.randomBytes(8).toString('hex');
        const uniqueReelsDir = path.join(WRITABLE_ROOT, `reels_downloads_${uniqueId}`);

        try {
            if (!fs.existsSync(uniqueReelsDir)) {
                fs.mkdirSync(uniqueReelsDir, { recursive: true });
            }

            console.log(`\n📥 Downloading: ${reelUrl}`);
            await ytDlpx(reelUrl, {
                noWarnings: true,
                noPlaylist: true,
                noCheckCertificates: true,
                format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
                mergeOutputFormat: 'mp4',
                output: path.join(uniqueReelsDir, '%(id)s.%(ext)s'),
                ffmpegLocation: ffmpegPath,
            });

            // If targetName not specified, name dynamically
            const finalName = targetName || `clip_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
            moveToFolderWithTargetName(bufferFolder, uniqueReelsDir, finalName);
            
            // Clean up staging folder
            try {
                fs.rmSync(uniqueReelsDir, { recursive: true, force: true });
            } catch {}
            
            console.log(`✅ Download complete → ${path.join(bufferFolder, finalName)}`);
            resolve();
        } catch (err) {
            try {
                fs.rmSync(uniqueReelsDir, { recursive: true, force: true });
            } catch {}
            reject(new Error(`yt-dlp-exec failed for URL: ${reelUrl}\n${err.message}`));
        }
    });
}

module.exports = { downloadInstagramReel, getNextBufferFolder, BUFFER_DIR };
