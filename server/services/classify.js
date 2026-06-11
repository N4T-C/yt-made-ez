/**
 * Classify & Caption Service
 * Sends a muted (audio-stripped) video clip to Gemma (gemma-4-31b-it) to
 * generate an accurate, content-specific 1-2 word caption.
 *
 * Key constraints:
 *  - Gemma only handles videos under 1 minute → cap at 56 s
 *  - Audio must be removed before sending (requirement from Gemma video API)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { GoogleGenAI } = require('@google/genai');
const { ffmpegPath, ffprobePath } = require('ffmpeg-ffprobe-static');

const MODEL = 'gemma-4-31b-it';
const MAX_DURATION = 56; // seconds — Gemma/Gemini hard limit is 60 s; use 56 for safety


// ── Helpers ──────────────────────────────────────────────────────────────────

function parseCategories() {
    const raw = String(process.env.CATEGORIES || '').trim();
    if (!raw) return ['other'];
    return raw.split(',').map(c => c.trim()).filter(Boolean);
}

function parseTitleMap() {
    try {
        const raw = String(process.env.TITLE || '').trim();
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function cleanModelText(text) {
    return String(text || '')
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
}

/**
 * Probe a video to get its duration in seconds.
 */
function probeDuration(filePath) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ffprobePath, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath,
        ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
            if (code !== 0) return reject(new Error(`ffprobe failed: ${stderr.slice(-200)}`));
            const dur = parseFloat(stdout.trim());
            resolve(isNaN(dur) || dur <= 0 ? 5 : dur);
        });
        proc.on('error', err => reject(new Error(`ffprobe spawn error: ${err.message}`)));
    });
}

/**
 * Strip audio (and optionally cap duration) from a clip using ffmpeg.
 * Returns the Buffer of the processed mp4.
 */
function processClipForGemma(filePath, duration) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-i', filePath,
        ];

        // Cap at MAX_DURATION if needed
        if (duration > MAX_DURATION) {
            args.push('-t', String(MAX_DURATION));
        }

        args.push(
            '-an',                              // strip audio
            '-vf', 'scale=320:-2,fps=10',       // downscale and reduce framerate to make buffer tiny
            '-vcodec', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'ultrafast',
            '-crf', '32',
            '-f', 'mp4',
            '-movflags', 'frag_keyframe+empty_moov', // fragmented mp4 for piping
            'pipe:1',
        );

        const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const chunks = [];
        let stderr = '';

        proc.stdout.on('data', d => chunks.push(d));
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
            if (code !== 0 || chunks.length === 0) {
                return reject(new Error(`ffmpeg clip processing failed: ${stderr.slice(-300)}`));
            }
            resolve(Buffer.concat(chunks));
        });
        proc.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Classify a video clip and generate a short, descriptive caption using Gemma.
 *
 * @param {string} filePath - absolute path to the video clip
 * @param {object} options
 * @param {string} options.fallbackCaption - caption to use if AI fails
 * @returns {Promise<{category: string, caption: string, titleMap: object}>}
 */
async function classifyClip(filePath, options = {}) {
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
    const categories = parseCategories();
    const fallback = options.fallbackCaption || 'Epic';

    if (!apiKey) {
        console.warn('[classify] No GEMINI_API_KEY set — using fallback caption.');
        return { category: categories[0] || 'other', caption: fallback };
    }

    if (!fs.existsSync(filePath)) {
        console.error(`[classify] File not found: ${filePath}`);
        return { category: categories[0] || 'other', caption: fallback };
    }

    // 1. Probe duration
    let duration = 5;
    try {
        duration = await probeDuration(filePath);
    } catch (err) {
        console.warn(`[classify] Could not probe duration: ${err.message}`);
    }

    // 2. Strip audio (+ cap duration) — pipe result into a Buffer
    let videoBuffer;
    try {
        console.log(`[classify] Processing clip: ${path.basename(filePath)} (${duration.toFixed(1)}s) — stripping audio${duration > MAX_DURATION ? `, capping to ${MAX_DURATION}s` : ''}`);
        videoBuffer = await processClipForGemma(filePath, duration);
    } catch (err) {
        console.error('[classify] Clip processing failed:', err.message);
        return { category: categories[0] || 'other', caption: fallback };
    }

    // 3. Build prompt
    const prompt = [
        'You are a professional short-video caption writer for ranking videos on YouTube Shorts.',
        'You will receive a muted video clip.',
        'Your task:',
        `1. Choose exactly one category from this list: ${categories.join(', ')}`,
        '2. Write a caption that is EXACTLY 1 or 2 words. Make it punchy, viral, and specific to what happens in the video.',
        '   - GOOD examples: "Insane", "Pure Skill", "Wild", "Clutch", "Legendary", "Big Energy", "Smooth Move".',
        '   - BAD examples: "Clip", "Video", "Rank", "YouTube", "Number One" — NEVER use these.',
        '   - NEVER output "..." or dots or empty string or placeholders under any circumstances. If the video is unclear, write a catchy fallback like "Unreal".',
        '   - No special characters or symbols. Plain words only.',
        '3. Respond ONLY with strict JSON — no extra text, no markdown:',
        '   {"category":"chosen category","caption":"your caption"}',
    ].join('\n');

    // 4. Call Gemma via @google/genai SDK
    const ai = new GoogleGenAI({ apiKey });

    let response;
    try {
        console.log(`[classify] Sending ${(videoBuffer.length / 1024).toFixed(0)} KB video to Gemma...`);
        response = await ai.models.generateContent({
            model: MODEL,
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                data: videoBuffer.toString('base64'),
                                mimeType: 'video/mp4',
                            },
                        },
                        {
                            text: prompt,
                        },
                    ],
                },
            ],
        });
    } catch (err) {
        console.error(`[classify] Gemma API error: ${err.message}`);
        return { category: categories[0] || 'other', caption: fallback };
    }

    // 5. Parse response
    const rawText = cleanModelText(
        response?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ||
        response?.text ||
        ''
    );

    console.log(`[classify] Gemma raw response: ${rawText}`);

    let parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        // Try to salvage JSON from extra prose
        const m = rawText.match(/\{[^}]+\}/);
        if (m) {
            try { parsed = JSON.parse(m[0]); } catch { /* fall through */ }
        }
    }

    if (!parsed) {
        console.error(`[classify] JSON parse failed: ${rawText.slice(0, 200)}`);
        return { category: categories[0] || 'other', caption: fallback };
    }

    const category = String(parsed.category || categories[0] || 'other').trim();
    let caption  = String(parsed.caption  || '').trim();

    // Clean up invalid or placeholder captions
    const alphanumeric = caption.replace(/[^a-zA-Z0-9]/g, '').trim();
    const lower = caption.toLowerCase();
    
    if (!caption || !alphanumeric || lower.includes('clip') || lower.includes('video') || lower === '...' || caption.replace(/[.\s_-]/g, '') === '') {
        console.warn(`[classify] Invalid caption received: "${caption}" — using fallback/random caption.`);
        const DEFAULT_CAPTIONS = [
            'Epic', 'Insane', 'Wild', 'Clutch', 'Legendary', 'Big Energy', 'Smooth Move',
            'Amazing', 'Unreal', 'Perfect', 'Classic', 'Iconic', 'Elite', 'Respect',
            'Wow', 'Vibes', 'Mood', 'Goals', 'Clean', 'Pro', 'God Mode', 'GG', 'EZ'
        ];
        const randomChoice = DEFAULT_CAPTIONS[Math.floor(Math.random() * DEFAULT_CAPTIONS.length)];
        caption = (fallback && fallback !== 'clip' && fallback !== 'Epic') ? fallback : randomChoice;
    }

    console.log(`[classify] ✅ Caption: "${caption}" | Category: "${category}"`);
    return { category, caption, titleMap: parseTitleMap() };
}

module.exports = { classifyClip, parseCategories, parseTitleMap };
