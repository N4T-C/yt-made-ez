/**
 * Video Processing Routes
 * Handles the full pipeline: download → combine → text overlay → YouTube upload
 * Uses both Socket.IO events AND pollable job status for reliability.
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { downloadInstagramReel, getNextBufferFolder } = require('../services/reelDownload');
const { combineBuffer, combineBuffer3, combineAndOverlaySinglePass, probeClips, sortClips } = require('../services/combine');
const { addTextToVideo, addTextToVideo3, addTextToVideoCompile } = require('../services/addText');
const { purgeAllVideos } = require('../services/cleanup');
const { uploadToYouTube } = require('../services/youtubeUpload');
const { generateCaptions, getRandomCaption, generateCaptionForClip } = require('../services/captionGenerator');
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
    const { videoTitle, captions, links, captionMode, limitTotalDuration, trimIndividualClips, clipTrimLimit } = req.body;
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

    if (trimIndividualClips) {
        const limit = Number(clipTrimLimit);
        if (isNaN(limit) || limit < 1 || limit > 60) {
            return res.status(400).json({ error: 'Individual clip limit must be between 1 and 60 seconds' });
        }
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

            // ── Phase 1: Download 5 reels in parallel ─────────────────────
            let completedDownloads = 0;
            const downloadPromises = links.map(async (link, idx) => {
                const targetName = `clip_${String(idx + 1).padStart(3, '0')}.mp4`;
                await downloadInstagramReel(link, bufferFolder, targetName);
                completedDownloads++;
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: Math.round(completedDownloads * 8),      // 0–40%
                    message: `📥 Downloaded clip ${completedDownloads} of 5...`,
                });
            });
            await Promise.all(downloadPromises);

            // ── Phase 2: Probe, Trim and Caption ───────────────────────────
            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 40,
                message: '🔍 Probing downloaded clips...',
            });

            const clipMeta = await probeClips(bufferFolder, 5);
            const orderedMeta = sortClips(clipMeta, 'provided');

            // Trim individual clips if requested
            if (trimIndividualClips) {
                const limitSecs = Number(clipTrimLimit);
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: 41,
                    message: `✂️ Trimming clips to ${limitSecs}s...`,
                });

                for (let i = 0; i < orderedMeta.length; i++) {
                    if (orderedMeta[i].duration > limitSecs) {
                        console.log(`[process] Trimming clip ${orderedMeta[i].video} from ${orderedMeta[i].duration}s to ${limitSecs}s`);
                        await trimVideoInPlace(orderedMeta[i].filePath, limitSecs);
                        orderedMeta[i].duration = limitSecs;
                    }
                }
            }

            let finalCaptions = Array.isArray(captions) ? captions.map(c => String(c).trim()) : [];

            if (mode !== 'manual') {
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: 45,
                    message: mode === 'ai' ? '🧠 Generating AI captions...' : '🎲 Generating random captions...',
                });

                if (mode === 'ai') {
                    finalCaptions = [];
                    for (let i = 0; i < orderedMeta.length; i++) {
                        try {
                            const cap = await generateCaptionForClip(orderedMeta[i].filePath, finalCaptions);
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
                const alphanumeric = String(cap).replace(/[^a-zA-Z0-9]/g, '').trim();
                if (!cap || !alphanumeric || lower.includes('clip') || lower.includes('video') || lower.match(/clip\s*\d*/i)) {
                    return getRandomCaption();
                }
                return cap;
            });

            // ── Phase 3: Combine & Overlay Single-Pass ──────────────────────
            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 50,
                message: '🎬 Combining clips and generating text overlays...',
            });

            const { names, timestamps, outputFile } = await combineAndOverlaySinglePass(folderName, videoTitle.trim(), finalCaptions, {
                clipMeta: orderedMeta,
                sortMode: 'provided',
            });

            const limitTotal = limitTotalDuration !== false;
            let finalVideoFile = outputFile;
            if (limitTotal) {
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: 84,
                    message: '✂️ Trimming video to short-form length...',
                });

                const maxSeconds = parseInt(process.env.MAX_OUTPUT_SECONDS, 10) || 56;
                finalVideoFile = await trimVideoInPlace(outputFile, maxSeconds);
            }

            // ── Done ───────────────────────────────────────────────────────
            emitUpdate(io, jobId, {
                status: 'ready',
                progress: 100,
                message: '🎉 Video ready! Fill in YouTube upload details.',
                outputFile: finalVideoFile,
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
 * POST /api/video/process3
 * Body: { videoTitle, links: string[3] }
 * 3-clip ranking video — AI captions only, trimmed to 57 seconds.
 */
router.post('/process3', async (req, res) => {
    const { videoTitle, links, captions, captionMode, limitTotalDuration, trimIndividualClips, clipTrimLimit } = req.body;
    const io = req.app.get('io');
    const mode = String(captionMode || 'ai').toLowerCase();
    const allowedModes = new Set(['manual', 'random', 'ai']);

    if (!allowedModes.has(mode)) {
        return res.status(400).json({ error: 'captionMode must be one of: manual, random, ai' });
    }

    if (!videoTitle || typeof videoTitle !== 'string' || !videoTitle.trim()) {
        return res.status(400).json({ error: 'videoTitle is required' });
    }
    if (mode === 'manual') {
        if (!Array.isArray(captions) || captions.length !== 3 || captions.some(c => !c || !c.trim())) {
            return res.status(400).json({ error: 'Exactly 3 non-empty captions are required for manual mode' });
        }
    }
    if (!Array.isArray(links) || links.length !== 3 || links.some(l => !l || !l.trim())) {
        return res.status(400).json({ error: 'Exactly 3 non-empty links are required' });
    }

    if (trimIndividualClips) {
        const limit = Number(clipTrimLimit);
        if (isNaN(limit) || limit < 1 || limit > 60) {
            return res.status(400).json({ error: 'Individual clip limit must be between 1 and 60 seconds' });
        }
    }

    const jobId = uuidv4();

    jobs[jobId] = {
        status: 'processing',
        progress: 0,
        message: 'Starting 3-clip download pipeline...',
        outputFile: null,
    };

    res.json({ jobId });

    setImmediate(async () => {
        let bufferFolder = null;
        let folderName = null;

        try {
            purgeAllVideos();

            bufferFolder = getNextBufferFolder();
            folderName = path.basename(bufferFolder);

            // ── Phase 1: Download 3 clips in parallel ─────────────────────
            let completedDownloads = 0;
            const downloadPromises = links.map(async (link, idx) => {
                const targetName = `clip_${String(idx + 1).padStart(3, '0')}.mp4`;
                await downloadInstagramReel(link, bufferFolder, targetName);
                completedDownloads++;
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: Math.round(completedDownloads * 12),      // 0–36%
                    message: `📥 Downloaded clip ${completedDownloads} of 3...`,
                });
            });
            await Promise.all(downloadPromises);

            // ── Phase 2: Captions ─────────────────────────────────
            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 40,
                message: '🔍 Probing downloaded clips...',
            });

            const clipMeta = await probeClips(bufferFolder, 3);
            let orderedMeta = sortClips(clipMeta, 'provided');

            // Trim individual clips if requested
            if (trimIndividualClips) {
                const limitSecs = Number(clipTrimLimit);
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: 41,
                    message: `✂️ Trimming clips to ${limitSecs}s...`,
                });

                for (let i = 0; i < orderedMeta.length; i++) {
                    if (orderedMeta[i].duration > limitSecs) {
                        console.log(`[process3] Trimming clip ${orderedMeta[i].video} from ${orderedMeta[i].duration}s to ${limitSecs}s`);
                        await trimVideoInPlace(orderedMeta[i].filePath, limitSecs);
                        orderedMeta[i].duration = limitSecs;
                    }
                }
            }

            let finalCaptions = Array.isArray(captions) ? captions.map(c => String(c).trim()) : [];

            if (mode !== 'manual') {
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: 45,
                    message: mode === 'ai' ? '🧠 Generating AI captions...' : '🎲 Generating random captions...',
                });

                if (mode === 'ai') {
                    finalCaptions = [];
                    for (let i = 0; i < orderedMeta.length; i++) {
                        try {
                            const cap = await generateCaptionForClip(orderedMeta[i].filePath, finalCaptions);
                            finalCaptions.push(cap);
                        } catch (err) {
                            finalCaptions.push(getRandomCaption());
                        }
                    }
                } else {
                    finalCaptions = generateCaptions(3);
                }
            }

            // Safety net
            finalCaptions = finalCaptions.map(cap => {
                const lower = String(cap).trim().toLowerCase();
                const alphanumeric = String(cap).replace(/[^a-zA-Z0-9]/g, '').trim();
                if (!cap || !alphanumeric || lower.includes('clip') || lower.includes('video') || lower.match(/clip\s*\d*/i)) {
                    return getRandomCaption();
                }
                return cap;
            });

            while (finalCaptions.length < 3) finalCaptions.push(getRandomCaption());
            if (finalCaptions.length > 3) finalCaptions = finalCaptions.slice(0, 3);

            // ── Phase 3: Combine & Overlay Single-Pass ──────────────────────
            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 50,
                message: '🎬 Combining clips and generating text overlays...',
            });

            const { names, timestamps, outputFile } = await combineAndOverlaySinglePass(folderName, videoTitle.trim(), finalCaptions, {
                clipMeta: orderedMeta,
                sortMode: 'provided',
            });

            const limitTotal = limitTotalDuration !== false;
            let finalVideoFile = outputFile;
            if (limitTotal) {
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: 88,
                    message: '✂️ Trimming video to 57 seconds...',
                });
                finalVideoFile = await trimVideoInPlace(outputFile, 57);
            }

            // ── Done ───────────────────────────────────────────────────────
            emitUpdate(io, jobId, {
                status: 'ready',
                progress: 100,
                message: '🎉 3-clip video ready! Fill in YouTube upload details.',
                outputFile: finalVideoFile,
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
 * POST /api/video/process-compile
 * Body: { links: string[], limitTotalDuration: boolean, trimIndividualClips: boolean, clipTrimLimit?: number }
 */
router.post('/process-compile', async (req, res) => {
    const { links, limitTotalDuration, trimIndividualClips, clipTrimLimit } = req.body;
    const io = req.app.get('io');

    if (!Array.isArray(links) || links.length === 0 || links.some(l => !l || !l.trim())) {
        return res.status(400).json({ error: 'At least one valid link is required' });
    }

    if (trimIndividualClips) {
        const limit = Number(clipTrimLimit);
        if (isNaN(limit) || limit < 1 || limit > 60) {
            return res.status(400).json({ error: 'Individual clip limit must be between 1 and 60 seconds' });
        }
    }

    const jobId = uuidv4();

    jobs[jobId] = {
        status: 'processing',
        progress: 0,
        message: 'Starting compilation download pipeline...',
        outputFile: null,
    };

    res.json({ jobId });

    setImmediate(async () => {
        let bufferFolder = null;
        let folderName = null;

        try {
            purgeAllVideos();

            bufferFolder = getNextBufferFolder();
            folderName = path.basename(bufferFolder);

            const numClips = links.length;

            // ── Phase 1: Download all clips in parallel ───────────────────
            let completedDownloads = 0;
            const downloadPromises = links.map(async (link, idx) => {
                const targetName = `clip_${String(idx + 1).padStart(3, '0')}.mp4`;
                await downloadInstagramReel(link, bufferFolder, targetName);
                completedDownloads++;
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: Math.round(completedDownloads * (50 / numClips)),
                    message: `📥 Downloaded clip ${completedDownloads} of ${numClips}...`,
                });
            });
            await Promise.all(downloadPromises);

            // ── Phase 2: Probe, trim and sort clips ─────────────────────────
            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 52,
                message: '🔍 Probing downloaded clips...',
            });

            let clipMeta = await probeClips(bufferFolder, numClips);
            clipMeta = sortClips(clipMeta, 'provided');

            // Trim individual clips if requested
            if (trimIndividualClips) {
                const limitSecs = Number(clipTrimLimit);
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: 55,
                    message: `✂️ Trimming clips to ${limitSecs}s...`,
                });

                for (let i = 0; i < clipMeta.length; i++) {
                    if (clipMeta[i].duration > limitSecs) {
                        console.log(`[process-compile] Trimming clip ${clipMeta[i].video} from ${clipMeta[i].duration}s to ${limitSecs}s`);
                        await trimVideoInPlace(clipMeta[i].filePath, limitSecs);
                        clipMeta[i].duration = limitSecs;
                    }
                }
            }

            // ── Phase 3: Combine ───────────────────────────────────────────
            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 70,
                message: `🎬 Combining ${clipMeta.length} clips into compilation...`,
            });

            const { names, timestamps, outputFile } = await combineBuffer(folderName, {
                clipMeta,
                sortMode: 'provided',
            });

            emitUpdate(io, jobId, {
                status: 'processing',
                progress: 85,
                message: 'Processing compilation...',
            });

            // ── Phase 6: Limit total duration if toggle is on ─────────────
            let finalVideoFile = outputFile;
            if (limitTotalDuration) {
                emitUpdate(io, jobId, {
                    status: 'processing',
                    progress: 90,
                    message: '✂️ Trimming final compilation to 57s...',
                });
                finalVideoFile = await trimVideoInPlace(outputFile, 57);
            }

            // ── Done ───────────────────────────────────────────────────────
            emitUpdate(io, jobId, {
                status: 'ready',
                progress: 100,
                message: '🎉 Compilation ready! Set YouTube upload details.',
                outputFile: finalVideoFile,
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
 * POST /api/video/suggest-metadata
 * Body: { videoTitle, captions: string[], category: string }
 * Suggests YouTube Title, Description, and Tags using Gemini
 */
router.post('/suggest-metadata', async (req, res) => {
    const { videoTitle, captions, category } = req.body;
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();

    if (!apiKey) {
        return res.status(400).json({ error: 'No GEMINI_API_KEY set on the server.' });
    }

    try {
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey });
        const model = process.env.GEMINI_MODEL || 'gemma-4-31b-it';

        const prompt = [
            'You are a professional YouTube Shorts SEO strategist.',
            'Create search-optimized, viral metadata for a vertical video based on:',
            `- Title overlay/theme: "${videoTitle || 'Compilation'}"`,
            `- Scene Captions: ${Array.isArray(captions) ? captions.join(', ') : 'None'}`,
            `- Niche Category: "${category || 'Entertainment'}"`,
            '',
            'Provide your output in strict JSON format. Do not use markdown tags, formatting, prefix, or suffix. Only return this exact structure:',
            '{',
            '  "title": "Short title under 80 chars with #Shorts and one other hashtag",',
            '  "description": "Engaging description under 150 words with 3-5 keywords, bullet points, and popular hashtags like #viral, #Shorts",',
            '  "tags": "10 comma-separated keywords and search terms"',
            '}'
        ].join('\n');

        console.log(`[suggest-metadata] Sending prompt to ${model}...`);
        const response = await ai.models.generateContent({
            model: model,
            contents: prompt,
        });

        // Helper to strip markdown and extract JSON
        const rawText = String(response?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || response?.text || '')
            .trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

        console.log(`[suggest-metadata] Cleaned response: ${rawText}`);

        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            const m = rawText.match(/\{[^}]+\}/);
            if (m) {
                parsed = JSON.parse(m[0]);
            }
        }

        if (!parsed) {
            throw new Error('Failed to generate valid JSON metadata.');
        }

        res.json({
            title: String(parsed.title || '').trim(),
            description: String(parsed.description || '').trim(),
            tags: String(parsed.tags || '').trim(),
        });

    } catch (err) {
        console.error(`[suggest-metadata] error: ${err.message}`);
        res.status(500).json({ error: err.message });
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
