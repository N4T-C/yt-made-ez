/**
 * Combine Service — Robust port of combine.py
 * Concatenates 5 video clips into one 1080×1920 vertical video using ffmpeg.
 * Fixed: silent audio index calculation, proper concat filter construction.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVER_ROOT = path.join(__dirname, '..');
const BUFFER_DIR = path.join(SERVER_ROOT, 'buffer');

const TARGET_W = 1080;
const TARGET_H = 1920;

/**
 * Probe a video file using ffprobe.
 */
function probeVideo(filePath) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath,
        ];

        const proc = spawn('ffprobe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
            if (code !== 0) {
                return reject(new Error(`ffprobe failed on ${path.basename(filePath)}: ${stderr.slice(-200)}`));
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(new Error(`ffprobe JSON parse error: ${e.message}`));
            }
        });
        proc.on('error', reject);
    });
}

/**
 * Combine 5 clips into one 1080×1920 video.
 * Exactly matches the Python combine.py logic.
 *
 * @param {string} folderName - subfolder name inside buffer/ (e.g. "1")
 * @returns {Promise<{names: string[], timestamps: number[], outputFile: string}>}
 */
async function combineBuffer(folderName) {
    const bufferFolder = path.join(BUFFER_DIR, folderName);
    const outputFile = path.join(SERVER_ROOT, `combined_${folderName}.mp4`);

    if (!fs.existsSync(bufferFolder)) {
        throw new Error(`Buffer folder not found: ${bufferFolder}`);
    }

    // Sort videos so clip_001 < clip_002 etc.
    const allFiles = fs.readdirSync(bufferFolder)
        .filter(f => /\.(mp4|mov|mkv|webm|avi)$/i.test(f))
        .sort();

    console.log(`Found clips in ${bufferFolder}:`, allFiles);

    if (allFiles.length < 5) {
        throw new Error(
            `Need exactly 5 clips, found ${allFiles.length} in ${bufferFolder}. ` +
            `Files: ${allFiles.join(', ')}`
        );
    }

    const clips = allFiles.slice(0, 5);

    // Probe all clips
    const namesArray = [];
    const timestamps = [0];
    let totalTime = 0;
    const probes = [];

    for (const video of clips) {
        const filePath = path.join(bufferFolder, video);
        console.log(`Probing: ${video}`);
        const meta = await probeVideo(filePath);
        const duration = parseFloat(meta.format.duration);
        const hasAudio = meta.streams.some(s => s.codec_type === 'audio');

        if (isNaN(duration) || duration <= 0) {
            throw new Error(`Invalid duration for ${video}: ${meta.format.duration}`);
        }

        totalTime += duration;
        timestamps.push(Math.round(totalTime));
        namesArray.push(video);
        probes.push({ filePath, video, duration, hasAudio });
        console.log(`  ${video}: ${duration.toFixed(2)}s, audio: ${hasAudio}`);
    }

    return new Promise((resolve, reject) => {
        const useGpu = (process.env.NVIDIA_GPU || 'false').trim().toLowerCase() === 'true';
        const vcodec = useGpu ? 'h264_nvenc' : 'libx264';

        /**
         * Build the ffmpeg input list and filter_complex string.
         *
         * Strategy (mirrors Python combine.py):
         *  - Each real clip is input [0], [1], ... [N-1]
         *  - Clips missing audio get a lavfi anullsrc input APPENDED after all real clips
         *  - We track the next available input index as we go
         */
        const inputArgs = [];
        const filterParts = [];
        const concatParts = []; // e.g. "[v0][a0][v1][a1]..."

        // First: add all real clip inputs
        for (const probe of probes) {
            inputArgs.push('-i', probe.filePath);
        }

        let extraInputIdx = probes.length; // silent audio inputs start here

        for (let i = 0; i < probes.length; i++) {
            const probe = probes[i];

            // Normalize video: scale to fit 9:16, pad to 1080×1920
            filterParts.push(
                `[${i}:v]` +
                `scale='if(gt(iw/ih,9/16),${TARGET_W},-2)':'if(gt(iw/ih,9/16),-2,${TARGET_H})',` +
                `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:black,` +
                `setsar=1` +
                `[v${i}]`
            );

            if (probe.hasAudio) {
                filterParts.push(
                    `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`
                );
            } else {
                // Append a silent audio source input for this clip
                inputArgs.push(
                    '-f', 'lavfi',
                    '-t', String(probe.duration),
                    '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`
                );
                filterParts.push(
                    `[${extraInputIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`
                );
                extraInputIdx++;
            }

            concatParts.push(`[v${i}][a${i}]`);
        }

        // Concat filter
        filterParts.push(`${concatParts.join('')}concat=n=5:v=1:a=1[outv][outa]`);
        const filterComplex = filterParts.join(';');

        const ffmpegArgs = [
            ...inputArgs,
            '-filter_complex', filterComplex,
            '-map', '[outv]',
            '-map', '[outa]',
            '-vcodec', vcodec,
            '-preset', 'fast',
            '-acodec', 'aac',
            '-b:a', '128k',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-y',
            outputFile,
        ];

        console.log('\n🎬 Running ffmpeg concat...');
        console.log('Output:', outputFile);

        const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });

        proc.on('close', code => {
            if (code !== 0) {
                const errSnippet = stderr.slice(-800);
                console.error('ffmpeg concat error:', errSnippet);
                return reject(new Error(`ffmpeg concat failed (exit ${code}):\n${errSnippet}`));
            }

            // Delete processed source clips and folder
            for (const video of namesArray) {
                try { fs.unlinkSync(path.join(bufferFolder, video)); } catch { /* ignore */ }
            }
            try { fs.rmdirSync(bufferFolder); } catch { /* ignore */ }

            console.log(`✅ Combined video: ${outputFile}`);
            resolve({ names: namesArray, timestamps, outputFile });
        });

        proc.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    });
}

module.exports = { combineBuffer };
