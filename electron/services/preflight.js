const { spawnSync } = require('child_process');
const { getFfmpegPath, getFfprobePath } = require('./binaryPaths');

function checkCommand(cmd, args) {
    const result = spawnSync(cmd, args, {
        windowsHide: true,
        timeout: 10000,
        encoding: 'utf8',
    });

    if (result.error) {
        return { ok: false, reason: result.error.message };
    }

    if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        return { ok: false, reason: stderr || `exit ${result.status}` };
    }

    return { ok: true };
}

function runStartupChecks() {
    const errors = [];

    const cleanedFfmpegPath = getFfmpegPath();
    const ffmpeg = checkCommand(cleanedFfmpegPath, ['-version']);
    if (!ffmpeg.ok) {
        errors.push(`ffmpeg not available at ${cleanedFfmpegPath} (${ffmpeg.reason})`);
    }

    const cleanedFfprobePath = getFfprobePath();
    const ffprobe = checkCommand(cleanedFfprobePath, ['-version']);
    if (!ffprobe.ok) {
        errors.push(`ffprobe not available at ${cleanedFfprobePath} (${ffprobe.reason})`);
    }

    return {
        ok: errors.length === 0,
        errors,
    };
}

module.exports = { runStartupChecks };
