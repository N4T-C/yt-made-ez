/**
 * Add Text Service — Robust port of add_text.py
 * Overlays title + numbered captions on the combined video.
 * Fixed: Windows font path escaping, dynamic title support.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER_ROOT = path.join(__dirname, '..');

/**
 * Find a usable font file.
 * Priority: .env FONT_PATH → fonts/ dir next to server → Windows system fonts → Linux fonts
 */
function getFont() {
    // 1. Try FONT_PATH env (supports relative + absolute)
    let envFont = process.env.FONT_PATH;
    if (envFont) {
        envFont = envFont.trim().replace(/['"]/g, '');
        if (!path.isAbsolute(envFont)) {
            envFont = path.resolve(SERVER_ROOT, envFont);
        }
        if (fs.existsSync(envFont)) {
            console.log('Font from .env:', envFont);
            return envFont;
        }
    }

    // 2. Bundled fonts/ folder (relative to server root)
    const bundledFonts = [
        path.join(SERVER_ROOT, 'fonts', 'OpenSansExtraBold.ttf'),
    ];
    for (const f of bundledFonts) {
        if (fs.existsSync(f)) {
            console.log('Font (bundled):', f);
            return f;
        }
    }

    // 3. Windows system fonts
    if (os.platform() === 'win32') {
        const winDir = process.env.WINDIR || 'C:\\Windows';
        const candidates = ['arial.ttf', 'Arial.ttf', 'verdana.ttf', 'tahoma.ttf', 'segoeui.ttf'];
        for (const c of candidates) {
            const p = path.join(winDir, 'Fonts', c);
            if (fs.existsSync(p)) {
                console.log('Font (Windows):', p);
                return p;
            }
        }
    }

    // 4. Linux / macOS system fonts
    const linuxFonts = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
    ];
    for (const f of linuxFonts) {
        if (fs.existsSync(f)) {
            console.log('Font (system):', f);
            return f;
        }
    }

    return null;
}

/**
 * Escape a font path for use in ffmpeg -vf drawtext=fontfile=...
 * On Windows, the colon in "C:\Windows\Fonts\arial.ttf" must be escaped as "\:".
 * Forward slashes are preferred in the path.
 */
function escapeFontPath(fontPath) {
    // Normalise to forward slashes first
    let p = fontPath.replace(/\\/g, '/');
    // Escape the drive colon: C:/Windows → C\:/Windows
    p = p.replace(/^([A-Za-z]):/, '$1\\:');
    return p;
}

/**
 * Escape text content for ffmpeg drawtext filter.
 */
function escapeText(text) {
    if (!text) return '';
    return String(text)
        .replace(/\\/g, '/')          // avoid double backslash issues
        .replace(/'/g, "\u2019")      // replace curly apostrophe (safe in drawtext)
        .replace(/:/g, '\\:')         // escape colons
        .replace(/%/g, '\\%');        // escape percent signs
}

/**
 * Add title + numbered caption overlays to a video.
 *
 * @param {string}   inputVideo - path to combined MP4
 * @param {string}   videoTitle - user-entered overlay title
 * @param {string[]} captions   - 5 caption strings
 * @param {number[]} timestamps - [0, t1, t2, t3, t4, totalSecs]
 * @returns {Promise<string>}   path to output video
 */
function addTextToVideo(inputVideo, videoTitle, captions, timestamps) {
    return new Promise((resolve, reject) => {
        const rawFont = getFont();
        if (!rawFont) {
            return reject(new Error(
                'No font file found. Please set FONT_PATH in server/.env to point to a .ttf font file.'
            ));
        }

        const fontPath = escapeFontPath(rawFont);
        console.log('Using font (escaped):', fontPath);

        const now = Date.now();
        const outputVideo = path.join(path.dirname(inputVideo), `output_${now}.mp4`);

        const captionSize = 58;
        const titleSize = 82;
        const border = 4;

        // Caption number colors (matching Python version)
        const numColors = ['yellow', 'cyan', 'red', 'green', '#C11C84'];

        const titleStr = (videoTitle || 'RANKING VIDEO').toUpperCase();
        const words = titleStr.split(' ');
        const half = Math.ceil(words.length / 2);
        const line1 = words.slice(0, half).join(' ');
        const line2 = words.slice(half).join(' ');

        const tStart = timestamps[0] || 0;
        const tEnd = timestamps[timestamps.length - 1] || 999;

        const drawtexts = [];

        // --------------- Title ---------------
        if (line1) {
            drawtexts.push(
                `drawtext=fontfile='${fontPath}'` +
                `:text='${escapeText(line1)}'` +
                `:enable='between(t,${tStart},${tEnd})'` +
                `:x=(w-text_w)/2:y=130` +
                `:fontsize=${titleSize}:borderw=${border}:bordercolor=black:fontcolor=cyan`
            );
        }
        if (line2) {
            drawtexts.push(
                `drawtext=fontfile='${fontPath}'` +
                `:text='${escapeText(line2)}'` +
                `:enable='between(t,${tStart},${tEnd})'` +
                `:x=(w-text_w)/2:y=${130 + titleSize + 12}` +
                `:fontsize=${titleSize + 8}:borderw=${border}:bordercolor=black:fontcolor=#C11C84`
            );
        }

        // --------------- Captions ---------------
        const yPositions = [535, 790, 1030, 1280, 1550];

        for (let i = 0; i < 5; i++) {
            const tReveal = timestamps[i] || 0;
            const color = numColors[i % numColors.length];

            // Number label (always visible)
            drawtexts.push(
                `drawtext=fontfile='${fontPath}'` +
                `:text='${i + 1}.'` +
                `:x=55:y=${yPositions[i]}` +
                `:fontsize=${captionSize}:borderw=${border}:bordercolor=black:fontcolor=${color}`
            );

            // Caption (revealed at clip start)
            if (captions[i]) {
                drawtexts.push(
                    `drawtext=fontfile='${fontPath}'` +
                    `:text='${escapeText(captions[i])}'` +
                    `:enable='between(t,${tReveal},${tEnd})'` +
                    `:x=130:y=${yPositions[i]}` +
                    `:fontsize=${captionSize}:borderw=${border}:bordercolor=black:fontcolor=white`
                );
            }
        }

        const vfFilter = drawtexts.join(',');

        const useGpu = (process.env.NVIDIA_GPU || 'false').trim().toLowerCase() === 'true';
        const vcodec = useGpu ? 'h264_nvenc' : 'libx264';

        const ffmpegArgs = [
            '-i', inputVideo,
            '-vf', vfFilter,
            '-vcodec', vcodec,
            '-preset', 'fast',
            '-acodec', 'aac',
            '-b:a', '192k',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-y',
            outputVideo,
        ];

        console.log('\n🖊️  Running ffmpeg text overlay...');
        const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });

        proc.on('close', code => {
            if (code !== 0) {
                const errSnippet = stderr.slice(-800);
                console.error('ffmpeg text overlay error:', errSnippet);
                return reject(new Error(`ffmpeg text overlay failed (exit ${code}):\n${errSnippet}`));
            }

            // Delete input video
            try { fs.unlinkSync(inputVideo); } catch { /* ignore */ }

            console.log('✅ Text overlay complete:', outputVideo);
            resolve(outputVideo);
        });

        proc.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    });
}

module.exports = { addTextToVideo };
