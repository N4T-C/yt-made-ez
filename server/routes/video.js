/**
 * Video Processing Routes
 * Handles the full pipeline: download → combine → text overlay → YouTube upload
 * Uses both Socket.IO events AND pollable job status for reliability.
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { downloadInstagramReel, getNextBufferFolder } = require('../services/reelDownload');
const { combineBuffer, probeClips, sortClips } = require('../services/combine');
const { addTextToVideo } = require('../services/addText');
const { purgeAllVideos } = require('../services/cleanup');
const { uploadToYouTube } = require('../services/youtubeUpload');
const { generateCaptions, getRandomCaption } = require('../services/captionGenerator');
const { classifyClip } = require('../services/classify');
const { trimVideoInPlace } = require('../services/trimVideo');
const { uploadToFilebin } = require('../services/filebinUpload');
const path = require('path');
const fs = require('fs');

// In-memory job store — shared across requests
const jobs = {};

/**
 * Emit a job update both to Socket.IO and update in-memory store.
 * This way the client can get updates either via WebSocket OR polling.
 */
function emitUpdate(io, jobId, update) {
    Object.assign(jobs[jobId], update);
    io.emit(`job:${jobId}`, { ...jobs[jobId] });
    console.log(`[job:${jobId}] ${update.message || ''} (${update.progress || 0}%)`);
}

/**
 * POST /api/video/process
 * Body: { videoTitle, captions: string[5], links: string[5] }
 * Returns: { jobId }
 */
router.post('/process', async (req, res) => {
    const { videoTitle, captions, links, captionMode } = req.body;
    const io = req.app.get('io');
    const mode = String(captionMode || 'manual').toLowerCase();
    const allowedModes = new Set(['manual', 'random', 'ai']);

    if (!allowedModes.has(mode)) {
        return res.status(400).json({ error: 'captionMode must be one of: manual, random, ai' });
    }

    if (!videoTitle || typeof videoTitle !== 'string' || !videoTitle.trim()) {
        return res.status(400).json({ error: 'videoTitle is required' });
    }
    if (mode === 'manual') {
        if (!Array.isArray(captions) || captions.length !== 5 || captions.some(c => !c || !c.trim())) {
            return res.status(400).json({ error: 'Exactly 5 non-empty captions are required' });
        }
    }
    if (!Array.isArray(links) || links.length !== 5 || links.some(l => !l || !l.trim())) {
        return res.status(400).json({ error: 'Exactly 5 non-empty links are required' });
    }

    const jobId = uuidv4();

    // Create job record BEFORE responding so status/:jobId works immediately
    jobs[jobId] = {
        status: 'processing',
        progress: 0,
        message: 'Starting download pipeline...',
        outputFile: null,
    };

    // Respond immediately with jobId
    res.json({ jobId });

    // Run the pipeline async — errors are caught and stored in jobs[jobId]
    setImmediate(async () => {
        let bufferFolder = null;
        let folderName = null;

        try {
            // Clean up any leftover files from previous jobs
            purgeAllVideos();

            bufferFolder = getNextBufferFolder();
            folderName = path.basename(bufferFolder);

            // ── Phase 1: Download 5 reels ──────────────────────────────────
            for (let i = 0; i < 5; i++) {
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: Math.round(i * 8),      // 0–40%
                    message: `📥 Downloading clip ${i + 1} of 5...`,
                });

                await downloadInstagramReel(links[i], bufferFolder);

                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: Math.round((i + 1) * 8),
                    message: `✅ Clip ${i + 1} downloaded`,
                });
            }

            // ── Phase 2: Optional auto-caption ─────────────────────────────
            let finalCaptions = Array.isArray(captions) ? captions.map(c => String(c).trim()) : [];
            let orderedMeta = null;
            let sortMode = 'duration';

            if (mode !== 'manual') {
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: 40,
                    message: mode === 'ai' ? '🧠 Generating AI captions...' : '🎲 Generating random captions...',
                });

                const clipMeta = await probeClips(bufferFolder, 5);
                sortMode = 'duration';
                orderedMeta = sortClips(clipMeta, sortMode);

                if (mode === 'ai') {
                    finalCaptions = [];
                    for (let i = 0; i < orderedMeta.length; i++) {
                        try {
                            const result = await classifyClip(orderedMeta[i].filePath, {
                                fallbackCaption: getRandomCaption(),
                            });
                            let cap = result.caption;
                            // Enforce strict filter: If Gemma spits out "Clip 1" or "Clip 2", override it!
                            if (/clip\s*\d*/i.test(cap) || cap.trim().toLowerCase() === 'clip') {
                                cap = getRandomCaption();
                            }
                            finalCaptions.push(cap);
                        } catch (err) {
                            finalCaptions.push(getRandomCaption());
                        }
                    }
                } else {
                    finalCaptions = generateCaptions(5);
                }

                if (finalCaptions.length > 5) {
                    finalCaptions = finalCaptions.slice(0, 5);
                }
                while (finalCaptions.length < 5) {
                    finalCaptions.push(getRandomCaption());
                }
            }

            // Global safety net for ALL modes (including manual):
            // If any caption says "Clip 1", "clip 2", etc., forcefully override it.
            // Viewers hate seeing generic "Clip X" labels!
            finalCaptions = finalCaptions.map(cap => {
                const lower = String(cap).trim().toLowerCase();
                if (lower.includes('clip') || lower.includes('video') || lower.match(/clip\s*\d*/i)) {
                    return getRandomCaption();
                }
                return cap;
            });

            // ── Phase 3: Combine ───────────────────────────────────────────
            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 42,
                message: '🎬 Combining clips into one video...',
            });

            const { names, timestamps, outputFile } = await combineBuffer(folderName, {
                clipMeta: orderedMeta || undefined,
                sortMode: orderedMeta ? 'provided' : sortMode,
            });

            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 65,
                message: '✅ Clips combined!',
            });

            // ── Phase 3: Text overlay ──────────────────────────────────────
            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 68,
                message: '🖊️  Adding title & caption overlays...',
            });

            const finalVideo = await addTextToVideo(
                outputFile,
                videoTitle.trim(),
                finalCaptions,
                timestamps
            );

            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 84,
                message: '✂️ Trimming video to short-form length...',
            });

            const maxSeconds = parseInt(process.env.MAX_OUTPUT_SECONDS, 10) || 56;
            const trimmedVideo = await trimVideoInPlace(finalVideo, maxSeconds);

            // ── Done ───────────────────────────────────────────────────────
            emitUpdate(io, jobId, {
                status: 'ready',
                progress: 100,
                message: '🎉 Video ready! Fill in YouTube upload details.',
                outputFile: trimmedVideo,
            });

        } catch (error) {
            console.error(`[job:${jobId}] ERROR:`, error.message);
            emitUpdate(io, jobId, {
                status: 'error',
                progress: jobs[jobId]?.progress || 0,
                message: error.message,
            });
            purgeAllVideos();
        }
    });
});

/**
 * GET /api/video/status/:jobId
 * Poll-based fallback for when Socket.IO events are missed.
 */
router.get('/status/:jobId', (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
});

/**
 * GET /api/video/download/:jobId
 * Streams the finished video file to the client.
 * Supports HTTP range requests so the browser <video> element can seek.
 */
router.get('/download/:jobId', (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'ready' || !job.outputFile) {
        return res.status(400).json({ error: 'Video is not ready yet' });
    }
    const filePath = path.resolve(job.outputFile);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Video file not found on server' });
    }
    res.sendFile(filePath);
});

/**
 * POST /api/video/upload
 * Body: { jobId, metadata, tokens }
 */
router.post('/upload', async (req, res) => {
    const { jobId, metadata, tokens } = req.body;
    const io = req.app.get('io');

    if (!jobId || !metadata || !tokens) {
        return res.status(400).json({ error: 'Missing required fields: jobId, metadata, tokens' });
    }

    const job = jobs[jobId];
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'ready') {
        return res.status(400).json({ error: `Job is not ready (status: ${job.status})` });
    }
    if (!job.outputFile || !fs.existsSync(job.outputFile)) {
        return res.status(400).json({ error: 'Output video file missing. Please re-process.' });
    }

    try {
        emitUpdate(io, jobId, { status: 'uploading', message: '📤 Uploading to YouTube...' });

        // Parse tags if string
        const parsedMeta = {
            ...metadata,
            tags: typeof metadata.tags === 'string'
                ? metadata.tags.split(',').map(t => t.trim()).filter(Boolean)
                : (metadata.tags || []),
        };

        const result = await uploadToYouTube(job.outputFile, parsedMeta, tokens);

        emitUpdate(io, jobId, {
            status: 'complete',
            message: `✅ Upload complete! Video ID: ${result.id}`,
            youtubeId: result.id,
        });

        purgeAllVideos();
        res.json({ success: true, videoId: result.id });

    } catch (error) {
        console.error('Upload error:', error.message);
        emitUpdate(io, jobId, { status: 'error', message: `Upload failed: ${error.message}` });
        purgeAllVideos();
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/video/share
 * Body: { jobId, deleteAfter?: boolean }
 * Uploads the finished video to Filebin and returns a shareable URL.
 */
router.post('/share', async (req, res) => {
    const { jobId, deleteAfter } = req.body;
    const io = req.app.get('io');

    if (!jobId) {
        return res.status(400).json({ error: 'jobId is required' });
    }

    const job = jobs[jobId];
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'ready' || !job.outputFile) {
        return res.status(400).json({ error: 'Video is not ready yet' });
    }
    if (!fs.existsSync(job.outputFile)) {
        return res.status(404).json({ error: 'Output video file missing' });
    }

    try {
        emitUpdate(io, jobId, { status: job.status, message: '🔗 Uploading to Filebin...' });
        const shouldDelete = deleteAfter === true || String(deleteAfter).toLowerCase() === 'true';
        const url = await uploadToFilebin(job.outputFile, { deleteAfter: shouldDelete });
        res.json({ url });
    } catch (error) {
        console.error('Filebin upload error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/video/cleanup
 * Cleans up all intermediate video files.
 * Called when the user closes the wizard without uploading.
 */
router.post('/cleanup', (req, res) => {
    purgeAllVideos();
    // Clear jobs in 'ready' or 'error' state
    for (const id of Object.keys(jobs)) {
        if (jobs[id].status === 'ready' || jobs[id].status === 'error' || jobs[id].status === 'complete') {
            delete jobs[id];
        }
    }
    res.json({ success: true });
});

module.exports = router;
