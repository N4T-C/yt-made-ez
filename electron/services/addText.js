/**
 * Add Text Service — Electron version
 * Overlays title + numbered captions on the combined video.
 *
 * Path change vs server version:
 *   SERVER_ROOT → electron/ folder (one level up from services/)
 *   Fonts are now looked up in electron/fonts/
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFfmpegPath, getAppRoot } = require('./binaryPaths');
const cleanedFfmpegPath = getFfmpegPath();

const { app } = require('electron');
const SERVER_ROOT = app ? app.getPath('userData') : path.join(__dirname, '..');   // Writable AppData folder

/**
 * Find a usable font file.
 * Priority: .env FONT_PATH → fonts/ dir bundled with app → Windows system fonts → Linux fonts
 */
function getFont() {
    // The app's own source root (inside asar in production, electron/ folder in dev).
    // Fonts ship with the app code, NOT in the writable userData folder.
    const appRoot = getAppRoot();

    // 1. Try FONT_PATH env (supports relative + absolute)
    let envFont = process.env.FONT_PATH;
    if (envFont) {
        envFont = envFont.trim().replace(/['"]/g, '');
        if (!path.isAbsolute(envFont)) {
            // Resolve relative to the app root (where fonts/ lives), not userData
            envFont = path.resolve(appRoot, envFont);
        }
        if (fs.existsSync(envFont)) {
            console.log('Font from .env:', envFont);
            return envFont;
        }
    }

    // 2. Bundled fonts/ folder (shipped with the app)
    const bundledFonts = [
        path.join(appRoot, 'fonts', 'OpenSansExtraBold.ttf'),
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
 */
function escapeFontPath(fontPath) {
    let p = fontPath.replace(/\\/g, '/');
    p = p.replace(/^([A-Za-z]):/, '$1\\:');
    return p;
}

/**
 * Escape text content for ffmpeg drawtext filter.
 */
function escapeText(text) {
    if (!text) return '';
    return String(text)
        .replace(/\\/g, '/')
        .replace(/'/g, '\u2019')
        .replace(/:/g, '\\:')
        .replace(/%/g, '\\%');
}

/**
 * Add title + numbered caption overlays to a video (5-clip version).
 */
function addTextToVideo(inputVideo, videoTitle, captions, timestamps) {
    return new Promise((resolve, reject) => {
        const rawFont = getFont();
        if (!rawFont) {
            return reject(new Error(
                'No font file found. Please set FONT_PATH in electron/.env to point to a .ttf font file.'
            ));
        }

        const fontPath = escapeFontPath(rawFont);
        console.log('Using font (escaped):', fontPath);

        const now = Date.now();
        const outputVideo = path.join(path.dirname(inputVideo), `output_${now}.mp4`);

        const captionSize = 58;
        const titleSize = 82;
        const border = 4;

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

        for (let p = 0; p < 5; p++) {
            const clipIndex = 4 - p;
            const label = p + 1;
            const tReveal = timestamps[clipIndex] || 0;
            const color = numColors[p % numColors.length];

            drawtexts.push(
                `drawtext=fontfile='${fontPath}'` +
                `:text='${label}.'` +
                `:x=55:y=${yPositions[p]}` +
                `:fontsize=${captionSize}:borderw=${border}:bordercolor=black:fontcolor=${color}`
            );

            if (captions[clipIndex]) {
                drawtexts.push(
                    `drawtext=fontfile='${fontPath}'` +
                    `:text='${escapeText(captions[clipIndex])}'` +
                    `:enable='between(t,${tReveal},${tEnd})'` +
                    `:x=130:y=${yPositions[p]}` +
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
        const proc = spawn(cleanedFfmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });

        proc.on('close', code => {
            if (code !== 0) {
                const errSnippet = stderr.slice(-800);
                console.error('ffmpeg text overlay error:', errSnippet);
                return reject(new Error(`ffmpeg text overlay failed (exit ${code}):\n${errSnippet}`));
            }

            try { fs.unlinkSync(inputVideo); } catch { /* ignore */ }

            console.log('✅ Text overlay complete:', outputVideo);
            resolve(outputVideo);
        });

        proc.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    });
}

/**
 * Add title + numbered caption overlays for a 3-clip ranking video.
 */
function addTextToVideo3(inputVideo, videoTitle, captions, timestamps) {
    return new Promise((resolve, reject) => {
        const rawFont = getFont();
        if (!rawFont) {
            return reject(new Error(
                'No font file found. Please set FONT_PATH in electron/.env to point to a .ttf font file.'
            ));
        }

        const fontPath = escapeFontPath(rawFont);
        console.log('Using font (escaped):', fontPath);

        const now = Date.now();
        const outputVideo = path.join(path.dirname(inputVideo), `output_${now}.mp4`);

        const captionSize = 62;
        const titleSize = 82;
        const border = 4;

        const numColors = ['yellow', 'cyan', 'red'];

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

        // --------------- Captions (3 entries) ---------------
        const yPositions = [650, 980, 1310];

        for (let p = 0; p < 3; p++) {
            const clipIndex = 2 - p;
            const label = p + 1;
            const tReveal = timestamps[clipIndex] || 0;
            const color = numColors[p % numColors.length];

            drawtexts.push(
                `drawtext=fontfile='${fontPath}'` +
                `:text='${label}.'` +
                `:x=55:y=${yPositions[p]}` +
                `:fontsize=${captionSize}:borderw=${border}:bordercolor=black:fontcolor=${color}`
            );

            if (captions[clipIndex]) {
                drawtexts.push(
                    `drawtext=fontfile='${fontPath}'` +
                    `:text='${escapeText(captions[clipIndex])}'` +
                    `:enable='between(t,${tReveal},${tEnd})'` +
                    `:x=130:y=${yPositions[p]}` +
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

        console.log('\n🖊️  Running ffmpeg text overlay (3-clip)...');
        const proc = spawn(cleanedFfmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });

        proc.on('close', code => {
            if (code !== 0) {
                const errSnippet = stderr.slice(-800);
                console.error('ffmpeg text overlay error:', errSnippet);
                return reject(new Error(`ffmpeg text overlay failed (exit ${code}):\n${errSnippet}`));
            }

            try { fs.unlinkSync(inputVideo); } catch { /* ignore */ }

            console.log('✅ Text overlay complete (3-clip):', outputVideo);
            resolve(outputVideo);
        });

        proc.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    });
}

module.exports = { addTextToVideo, addTextToVideo3 };
