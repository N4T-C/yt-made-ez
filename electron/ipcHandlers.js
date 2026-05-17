/**
 * IPC Handlers — Electron main process
 *
 * Replaces the Express + Socket.IO server.
 * Every handler maps 1:1 to a former HTTP endpoint.
 *
 * Progress updates are pushed to the renderer via:
 *   mainWindow.webContents.send(`job:${jobId}`, update)
 *
 * Register all handlers by calling registerIpcHandlers(ipcMain, getMainWindow).
 */

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const { downloadInstagramReel, getNextBufferFolder } = require('./services/reelDownload');
const { combineBuffer, combineBuffer3, probeClips, sortClips } = require('./services/combine');
const { addTextToVideo, addTextToVideo3 } = require('./services/addText');
const { purgeAllVideos } = require('./services/cleanup');
const { uploadToYouTube, getAuthUrl, getTokensFromCode, getUserInfo, refreshAccessToken } = require('./services/youtubeUpload');
const { generateCaptions, getRandomCaption } = require('./services/captionGenerator');
const { classifyClip } = require('./services/classify');
const { trimVideoInPlace } = require('./services/trimVideo');
const { uploadToFilebin } = require('./services/filebinUpload');
const { startBot, stopBot, getStatus: discordGetStatus } = require('./services/discordBot');

// ── In-memory job store ───────────────────────────────────────────────────────
const jobs = {};

/**
 * Push a job update both to in-memory store AND to the renderer.
 */
function emitUpdate(getMainWindow, jobId, update) {
    Object.assign(jobs[jobId], update);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
        win.webContents.send(`job:${jobId}`, { ...jobs[jobId] });
    }
    console.log(`[job:${jobId}] ${update.message || ''} (${update.progress || 0}%)`);
}

// ── Register all handlers ─────────────────────────────────────────────────────
function registerIpcHandlers(ipcMain, getMainWindow) {

    // ── video:process (5-clip) ────────────────────────────────────────────────
    ipcMain.handle('video:process', async (_event, { videoTitle, captions, links, captionMode }) => {
        const mode = String(captionMode || 'manual').toLowerCase();
        const allowedModes = new Set(['manual', 'random', 'ai']);

        if (!allowedModes.has(mode)) throw new Error('captionMode must be one of: manual, random, ai');
        if (!videoTitle || !videoTitle.trim()) throw new Error('videoTitle is required');
        if (mode === 'manual') {
            if (!Array.isArray(captions) || captions.length !== 5 || captions.some(c => !c || !c.trim()))
                throw new Error('Exactly 5 non-empty captions are required');
        }
        if (!Array.isArray(links) || links.length !== 5 || links.some(l => !l || !l.trim()))
            throw new Error('Exactly 5 non-empty links are required');

        const jobId = uuidv4();
        jobs[jobId] = { status: 'processing', progress: 0, message: 'Starting download pipeline...', outputFile: null };

        // Fire-and-forget pipeline
        setImmediate(async () => {
            let bufferFolder = null;
            let folderName = null;
            try {
                purgeAllVideos();
                bufferFolder = getNextBufferFolder();
                folderName = path.basename(bufferFolder);

                // Phase 1: Download
                for (let i = 0; i < 5; i++) {
                    emitUpdate(getMainWindow, jobId, {
                        status: 'processing',
                        progress: Math.round(i * 8),
                        message: `📥 Downloading clip ${i + 1} of 5...`,
                    });
                    await downloadInstagramReel(links[i], bufferFolder);
                    emitUpdate(getMainWindow, jobId, {
                        status: 'processing',
                        progress: Math.round((i + 1) * 8),
                        message: `✅ Clip ${i + 1} downloaded`,
                    });
                }

                // Phase 2: Captions
                let finalCaptions = Array.isArray(captions) ? captions.map(c => String(c).trim()) : [];
                let orderedMeta = null;
                let sortMode = 'duration';

                if (mode !== 'manual') {
                    emitUpdate(getMainWindow, jobId, {
                        status: 'processing', progress: 40,
                        message: mode === 'ai' ? '🧠 Generating AI captions...' : '🎲 Generating random captions...',
                    });

                    const clipMeta = await probeClips(bufferFolder, 5);
                    sortMode = 'duration';
                    orderedMeta = sortClips(clipMeta, sortMode);

                    if (mode === 'ai') {
                        finalCaptions = [];
                        for (let i = 0; i < orderedMeta.length; i++) {
                            try {
                                const result = await classifyClip(orderedMeta[i].filePath, { fallbackCaption: getRandomCaption() });
                                let cap = result.caption;
                                if (/clip\s*\d*/i.test(cap) || cap.trim().toLowerCase() === 'clip') cap = getRandomCaption();
                                finalCaptions.push(cap);
                            } catch {
                                finalCaptions.push(getRandomCaption());
                            }
                        }
                    } else {
                        finalCaptions = generateCaptions(5);
                    }

                    if (finalCaptions.length > 5) finalCaptions = finalCaptions.slice(0, 5);
                    while (finalCaptions.length < 5) finalCaptions.push(getRandomCaption());
                }

                // Safety net
                finalCaptions = finalCaptions.map(cap => {
                    const lower = String(cap).trim().toLowerCase();
                    if (lower.includes('clip') || lower.includes('video') || lower.match(/clip\s*\d*/i)) return getRandomCaption();
                    return cap;
                });

                // Phase 3: Combine
                emitUpdate(getMainWindow, jobId, { status: 'processing', progress: 42, message: '🎬 Combining clips...' });
                const { timestamps, outputFile } = await combineBuffer(folderName, {
                    clipMeta: orderedMeta || undefined,
                    sortMode: orderedMeta ? 'provided' : sortMode,
                });
                emitUpdate(getMainWindow, jobId, { status: 'processing', progress: 65, message: '✅ Clips combined!' });

                // Phase 4: Text overlay
                emitUpdate(getMainWindow, jobId, { status: 'processing', progress: 68, message: '🖊️  Adding title & captions...' });
                const finalVideo = await addTextToVideo(outputFile, videoTitle.trim(), finalCaptions, timestamps);

                // Phase 5: Trim
                emitUpdate(getMainWindow, jobId, { status: 'processing', progress: 84, message: '✂️ Trimming to short-form length...' });
                const maxSeconds = parseInt(process.env.MAX_OUTPUT_SECONDS, 10) || 56;
                const trimmedVideo = await trimVideoInPlace(finalVideo, maxSeconds);

                emitUpdate(getMainWindow, jobId, {
                    status: 'ready', progress: 100,
                    message: '🎉 Video ready! Fill in YouTube upload details.',
                    outputFile: trimmedVideo,
                });

            } catch (error) {
                console.error(`[job:${jobId}] ERROR:`, error.message);
                emitUpdate(getMainWindow, jobId, {
                    status: 'error',
                    progress: jobs[jobId]?.progress || 0,
                    message: error.message,
                });
                purgeAllVideos();
            }
        });

        return { jobId };
    });

    // ── video:process3 (3-clip) ───────────────────────────────────────────────
    ipcMain.handle('video:process3', async (_event, { videoTitle, links, captions, captionMode }) => {
        const mode = String(captionMode || 'ai').toLowerCase();
        const allowedModes = new Set(['manual', 'random', 'ai']);

        if (!allowedModes.has(mode)) throw new Error('captionMode must be one of: manual, random, ai');
        if (!videoTitle || !videoTitle.trim()) throw new Error('videoTitle is required');
        if (mode === 'manual') {
            if (!Array.isArray(captions) || captions.length !== 3 || captions.some(c => !c || !c.trim()))
                throw new Error('Exactly 3 non-empty captions are required for manual mode');
        }
        if (!Array.isArray(links) || links.length !== 3 || links.some(l => !l || !l.trim()))
            throw new Error('Exactly 3 non-empty links are required');

        const jobId = uuidv4();
        jobs[jobId] = { status: 'processing', progress: 0, message: 'Starting 3-clip download pipeline...', outputFile: null };

        setImmediate(async () => {
            let bufferFolder = null;
            let folderName = null;
            try {
                purgeAllVideos();
                bufferFolder = getNextBufferFolder();
                folderName = path.basename(bufferFolder);

                // Phase 1: Download
                for (let i = 0; i < 3; i++) {
                    emitUpdate(getMainWindow, jobId, {
                        status: 'processing',
                        progress: Math.round(i * 12),
                        message: `📥 Downloading clip ${i + 1} of 3...`,
                    });
                    await downloadInstagramReel(links[i], bufferFolder);
                    emitUpdate(getMainWindow, jobId, {
                        status: 'processing',
                        progress: Math.round((i + 1) * 12),
                        message: `✅ Clip ${i + 1} downloaded`,
                    });
                }

                // Phase 2: Captions
                let finalCaptions = Array.isArray(captions) ? captions.map(c => String(c).trim()) : [];
                let orderedMeta = null;

                if (mode !== 'manual') {
                    emitUpdate(getMainWindow, jobId, {
                        status: 'processing', progress: 40,
                        message: mode === 'ai' ? '🧠 Generating AI captions...' : '🎲 Generating random captions...',
                    });

                    const clipMeta = await probeClips(bufferFolder, 3);
                    orderedMeta = sortClips(clipMeta, 'duration');

                    if (mode === 'ai') {
                        finalCaptions = [];
                        for (let i = 0; i < orderedMeta.length; i++) {
                            try {
                                const result = await classifyClip(orderedMeta[i].filePath, { fallbackCaption: getRandomCaption() });
                                let cap = result.caption;
                                if (/clip\s*\d*/i.test(cap) || cap.trim().toLowerCase() === 'clip') cap = getRandomCaption();
                                finalCaptions.push(cap);
                            } catch {
                                finalCaptions.push(getRandomCaption());
                            }
                        }
                    } else {
                        finalCaptions = generateCaptions(3);
                    }
                } else {
                    const clipMeta = await probeClips(bufferFolder, 3);
                    orderedMeta = sortClips(clipMeta, 'duration');
                }

                // Safety net
                finalCaptions = finalCaptions.map(cap => {
                    const lower = String(cap).trim().toLowerCase();
                    if (lower.includes('clip') || lower.includes('video') || lower.match(/clip\s*\d*/i)) return getRandomCaption();
                    return cap;
                });
                while (finalCaptions.length < 3) finalCaptions.push(getRandomCaption());
                if (finalCaptions.length > 3) finalCaptions = finalCaptions.slice(0, 3);

                // Phase 3: Combine
                emitUpdate(getMainWindow, jobId, { status: 'processing', progress: 50, message: '🎬 Combining 3 clips...' });
                const { timestamps, outputFile } = await combineBuffer3(folderName, {
                    clipMeta: orderedMeta,
                    sortMode: 'provided',
                });
                emitUpdate(getMainWindow, jobId, { status: 'processing', progress: 68, message: '✅ Clips combined!' });

                // Phase 4: Text overlay
                emitUpdate(getMainWindow, jobId, { status: 'processing', progress: 72, message: '🖊️  Adding title & captions...' });
                const finalVideo = await addTextToVideo3(outputFile, videoTitle.trim(), finalCaptions, timestamps);

                // Phase 5: Trim
                emitUpdate(getMainWindow, jobId, { status: 'processing', progress: 88, message: '✂️ Trimming to 57 seconds...' });
                const trimmedVideo = await trimVideoInPlace(finalVideo, 57);

                emitUpdate(getMainWindow, jobId, {
                    status: 'ready', progress: 100,
                    message: '🎉 3-clip video ready! Fill in YouTube upload details.',
                    outputFile: trimmedVideo,
                });

            } catch (error) {
                console.error(`[job:${jobId}] ERROR:`, error.message);
                emitUpdate(getMainWindow, jobId, {
                    status: 'error',
                    progress: jobs[jobId]?.progress || 0,
                    message: error.message,
                });
                purgeAllVideos();
            }
        });

        return { jobId };
    });

    // ── video:status ──────────────────────────────────────────────────────────
    ipcMain.handle('video:status', async (_event, { jobId }) => {
        const job = jobs[jobId];
        if (!job) throw new Error('Job not found');
        return job;
    });

    // ── video:getFilePath — returns the local absolute path of a ready video ──
    ipcMain.handle('video:getFilePath', async (_event, { jobId }) => {
        const job = jobs[jobId];
        if (!job) throw new Error('Job not found');
        if (job.status !== 'ready' || !job.outputFile) throw new Error('Video is not ready yet');
        if (!fs.existsSync(job.outputFile)) throw new Error('Video file not found on disk');
        return job.outputFile;   // absolute path — renderer uses this with file:// protocol
    });

    // ── video:upload (YouTube) ────────────────────────────────────────────────
    ipcMain.handle('video:upload', async (_event, { jobId, metadata, tokens }) => {
        if (!jobId || !metadata || !tokens) throw new Error('Missing required fields: jobId, metadata, tokens');

        const job = jobs[jobId];
        if (!job) throw new Error('Job not found');
        if (job.status !== 'ready') throw new Error(`Job is not ready (status: ${job.status})`);
        if (!job.outputFile || !fs.existsSync(job.outputFile)) throw new Error('Output video file missing. Please re-process.');

        emitUpdate(getMainWindow, jobId, { status: 'uploading', message: '📤 Uploading to YouTube...' });

        const parsedMeta = {
            ...metadata,
            tags: typeof metadata.tags === 'string'
                ? metadata.tags.split(',').map(t => t.trim()).filter(Boolean)
                : (metadata.tags || []),
        };

        const result = await uploadToYouTube(job.outputFile, parsedMeta, tokens);

        emitUpdate(getMainWindow, jobId, {
            status: 'complete',
            message: `✅ Upload complete! Video ID: ${result.id}`,
            youtubeId: result.id,
        });

        purgeAllVideos();
        return { success: true, videoId: result.id };
    });

    // ── video:share (Filebin) ─────────────────────────────────────────────────
    ipcMain.handle('video:share', async (_event, { jobId, deleteAfter }) => {
        if (!jobId) throw new Error('jobId is required');

        const job = jobs[jobId];
        if (!job) throw new Error('Job not found');
        if (job.status !== 'ready' || !job.outputFile) throw new Error('Video is not ready yet');
        if (!fs.existsSync(job.outputFile)) throw new Error('Output video file missing');

        emitUpdate(getMainWindow, jobId, { status: job.status, message: '🔗 Uploading to Filebin...' });
        const shouldDelete = deleteAfter === true || String(deleteAfter).toLowerCase() === 'true';
        const url = await uploadToFilebin(job.outputFile, { deleteAfter: shouldDelete });
        return { url };
    });

    // ── video:cleanup ─────────────────────────────────────────────────────────
    ipcMain.handle('video:cleanup', async () => {
        purgeAllVideos();
        for (const id of Object.keys(jobs)) {
            if (['ready', 'error', 'complete'].includes(jobs[id].status)) {
                delete jobs[id];
            }
        }
        return { success: true };
    });

    // ── auth:getUrl ───────────────────────────────────────────────────────────
    ipcMain.handle('auth:getUrl', async () => {
        return { url: getAuthUrl() };
    });

    // ── auth:getTokens ────────────────────────────────────────────────────────
    ipcMain.handle('auth:getTokens', async (_event, { code }) => {
        return await getTokensFromCode(code);
    });

    // ── auth:me ───────────────────────────────────────────────────────────────
    ipcMain.handle('auth:me', async (_event, { tokens }) => {
        return await getUserInfo(tokens);
    });

    // ── auth:refresh ──────────────────────────────────────────────────────────
    ipcMain.handle('auth:refresh', async (_event, { refresh_token }) => {
        if (!refresh_token) throw new Error('refresh_token is required');
        return await refreshAccessToken(refresh_token);
    });

    // ── discord:start ─────────────────────────────────────────────────────────
    ipcMain.handle('discord:start', async (_event, { token, channelId, filebinKey }) => {
        if (!token || !channelId) throw new Error('token and channelId are required');
        await startBot({ token, channelId, filebinKey });
        return { success: true, status: discordGetStatus() };
    });

    // ── discord:stop ──────────────────────────────────────────────────────────
    ipcMain.handle('discord:stop', async () => {
        await stopBot();
        return { success: true, status: discordGetStatus() };
    });

    // ── discord:status ────────────────────────────────────────────────────────
    ipcMain.handle('discord:status', async () => {
        return discordGetStatus();
    });

    // ── shell:openExternal ────────────────────────────────────────────────────
    ipcMain.handle('shell:openExternal', async (_event, url) => {
        const { shell } = require('electron');
        await shell.openExternal(url);
    });

    // ── file:download — native Save dialog ───────────────────────────────────
    ipcMain.handle('file:download', async (_event, { filePath, defaultName }) => {
        const { dialog } = require('electron');
        const { canceled, filePath: savePath } = await dialog.showSaveDialog({
            defaultPath: defaultName || path.basename(filePath),
            filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
        });
        if (!canceled && savePath) {
            fs.copyFileSync(filePath, savePath);
            return { saved: true, savePath };
        }
        return { saved: false };
    });

    console.log('✅ All IPC handlers registered.');
}

module.exports = { registerIpcHandlers };
