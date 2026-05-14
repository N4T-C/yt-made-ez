/**
 * Reel Download Service — Robust port of reel_download.py
 * Downloads Instagram/YouTube clips via yt-dlp (invoked as `python -m yt_dlp`).
 *
 * WHY python -m yt_dlp?
 * On this system yt-dlp is installed as a Python package (not in PATH as an exe).
 * Using `python -m yt_dlp` always works regardless of PATH setup.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ytDlpx = require('yt-dlp-exec');

const SERVER_ROOT = path.join(__dirname, '..');
const REELS_DIR = path.join(SERVER_ROOT, 'reels_downloads');
const BUFFER_DIR = path.join(SERVER_ROOT, 'buffer');

const YOUTUBE_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

// ── yt-dlp invocation config ───────────────────────────────────────────────
// Resolve a working launcher at runtime so Windows/WSL/Linux all work.
let cachedLauncher = null;

function getLauncherCandidates() {
    const candidates = [];
    const envPython = (process.env.PYTHON_PATH || '').trim();

    if (envPython) {
        candidates.push({ cmd: envPython, prefix: ['-m', 'yt_dlp'], display: `${envPython} -m yt_dlp` });
    }

    if (os.platform() === 'win32') {
        candidates.push({ cmd: 'py', prefix: ['-3', '-m', 'yt_dlp'], display: 'py -3 -m yt_dlp' });
        candidates.push({ cmd: 'py', prefix: ['-m', 'yt_dlp'], display: 'py -m yt_dlp' });
    }

    candidates.push({ cmd: 'python3', prefix: ['-m', 'yt_dlp'], display: 'python3 -m yt_dlp' });
    candidates.push({ cmd: 'python', prefix: ['-m', 'yt_dlp'], display: 'python -m yt_dlp' });
    candidates.push({ cmd: 'yt-dlp', prefix: [], display: 'yt-dlp' });

    return candidates;
}

function canRunYtDlp(candidate) {
    const checkArgs = [...candidate.prefix, '--version'];
    const result = spawnSync(candidate.cmd, checkArgs, {
        windowsHide: true,
        timeout: 10000,
        encoding: 'utf8',
    });

    if (result.error) return false;
    return result.status === 0;
}

function resolveYtDlpLauncher() {
    if (cachedLauncher) return cachedLauncher;

    const candidates = getLauncherCandidates();
    for (const candidate of candidates) {
        if (canRunYtDlp(candidate)) {
            cachedLauncher = candidate;
            return candidate;
        }
    }

    const tried = candidates.map(c => c.display).join(', ');
    throw new Error(
        `yt-dlp is not available. Tried: ${tried}. ` +
        `Install with: python -m pip install yt-dlp (or pip3 install yt-dlp), ` +
        `or set PYTHON_PATH in server/.env to a working Python executable.`
    );
}

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
 * @returns {Promise<void>}
 */
function downloadInstagramReel(url, bufferFolder) {
    return new Promise(async (resolve, reject) => {
        let reelUrl;
        let launcher;

        try {
            reelUrl = normalizeDownloadUrl(url);
        } catch (err) {
            return reject(err);
        }

        // Use yt-dlp-exec for YouTube downloads to remove direct Python dependency
        if (reelUrl.includes('youtube.com/watch?v=')) {
            try {
                if (!fs.existsSync(REELS_DIR)) {
                    fs.mkdirSync(REELS_DIR, { recursive: true });
                }
                try {
                    const leftovers = fs.readdirSync(REELS_DIR);
                    for (const f of leftovers) {
                        fs.unlinkSync(path.join(REELS_DIR, f));
                    }
                } catch { /* ignore */ }

                console.log(`\n📥 Downloading YouTube: ${reelUrl}`);
                await ytDlpx(reelUrl, {
                    noWarnings: true,
                    noPlaylist: true,
                    noCheckCertificates: true,
                    format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
                    mergeOutputFormat: 'mp4',
                    output: path.join(REELS_DIR, '%(id)s.%(ext)s'),
                });

                moveToFolder(bufferFolder, REELS_DIR);
                fs.rmSync(REELS_DIR, { recursive: true, force: true });
                fs.mkdirSync(REELS_DIR, { recursive: true });
                console.log(`✅ YouTube Download complete → ${bufferFolder}`);
                return resolve();
            } catch (err) {
                return reject(new Error(`yt-dlp-exec failed for YouTube URL: ${reelUrl}\n${err.message}`));
            }
        }

        try {
            launcher = resolveYtDlpLauncher();
        } catch (err) {
            return reject(err);
        }

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
            ...launcher.prefix,
            '--no-warnings',
            '--no-playlist',
            '--no-check-certificates',
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
            '--merge-output-format', 'mp4',
            '-o', outputTemplate,
            reelUrl,
        ];

        console.log(`\n📥 Downloading: ${reelUrl}`);
        console.log(`   Using: ${launcher.display}`);

        const proc = spawn(launcher.cmd, ytdlpArgs, {
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
                `Failed to launch yt-dlp via "${launcher.display}".\n` +
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

module.exports = { downloadInstagramReel, getNextBufferFolder, BUFFER_DIR, resolveYtDlpLauncher };
