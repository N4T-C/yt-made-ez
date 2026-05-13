/**
 * Classify & Caption Service
 * Sends multiple frames from a clip to Gemma (gemma-4-31b-it) to generate
 * an accurate, content-specific caption for that clip.
 */
const { spawn } = require('child_process');
const fetch = require('node-fetch');

const MODEL = 'gemma-4-31b-it';

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
        const args = [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath,
        ];
        const proc = spawn('ffprobe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
 * Extract a single JPEG frame at a given timestamp (seconds).
 */
function extractFrameAt(filePath, seekSeconds) {
    return new Promise((resolve, reject) => {
        const seekStr = String(Math.max(0, seekSeconds).toFixed(2));
        const args = [
            '-v', 'error',
            '-ss', seekStr,
            '-i', filePath,
            '-frames:v', '1',
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            '-q:v', '5',
            'pipe:1',
        ];

        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const chunks = [];
        let stderr = '';

        proc.stdout.on('data', d => chunks.push(d));
        proc.stderr.on('data', d => { stderr += d.toString(); });

        proc.on('close', code => {
            if (code !== 0 || chunks.length === 0) {
                return reject(new Error(`ffmpeg frame extract failed at ${seekStr}s: ${stderr.slice(-200)}`));
            }
            resolve(Buffer.concat(chunks));
        });

        proc.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    });
}

/**
 * Extract multiple frames spread across the clip duration.
 * Returns array of base64 JPEG strings.
 */
async function extractMultipleFrames(filePath, count = 3) {
    let duration;
    try {
        duration = await probeDuration(filePath);
    } catch {
        duration = 5;
    }

    // Pick timestamps spread across the clip: 20%, 50%, 80% of duration
    const percentages = count === 1 ? [0.5] : [0.2, 0.5, 0.8].slice(0, count);
    const frames = [];

    for (const pct of percentages) {
        const seekSec = Math.max(0.5, duration * pct);
        try {
            const buf = await extractFrameAt(filePath, seekSec);
            frames.push(buf.toString('base64'));
        } catch (err) {
            console.warn(`[classify] Frame extract warning at ${(pct * 100).toFixed(0)}%: ${err.message}`);
        }
    }

    if (frames.length === 0) {
        throw new Error(`Could not extract any frames from: ${filePath}`);
    }

    return frames;
}

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

    if (!apiKey) {
        console.warn('[classify] No GEMINI_API_KEY set — using fallback caption.');
        return {
            category: categories[0] || 'other',
            caption: options.fallbackCaption || 'Great moment',
        };
    }

    // Extract 3 frames spread across the clip for a better understanding
    let frames;
    try {
        frames = await extractMultipleFrames(filePath, 3);
    } catch (err) {
        console.error('[classify] Frame extraction failed:', err.message);
        return {
            category: categories[0] || 'other',
            caption: options.fallbackCaption || 'Great moment',
        };
    }

    console.log(`[classify] Sending ${frames.length} frames to Gemma for: ${filePath}`);

    const prompt = [
        'You are a short-video caption writer for social media.',
        'You will receive multiple frames from the SAME video clip.',
        'Your task:',
        `1. Choose exactly one category from this list: ${categories.join(', ')}`,
        '2. Write a caption that is EXACTLY 1 word (2 words MAXIMUM — only if absolutely needed).',
        '   - The caption MUST reflect what is actually happening in the clip.',
        '   - GOOD examples: "Zoomies", "Chaos", "Hunting", "Melting", "Flop".',
        '   - BAD examples: "Cat Moment", "Great Clip", "So Cute" (too generic or too long).',
        '   - CRITICAL RULE: NEVER use the word "Clip", "Video", or ANY numbers (like 1, 2, 3) in your caption. Only output the pure vibe/action word.',
        '   - Use action words, emotions, or specific behaviors seen in the frames.',
        '3. Respond ONLY with strict JSON — no extra text, no markdown:',
        '   {"category":"chosen category","caption":"oneword"}',
    ].join('\n');

    // Build the multipart request — include all frames as inline images
    const imageParts = frames.map(b64 => ({
        inlineData: { mimeType: 'image/jpeg', data: b64 },
    }));

    const body = {
        contents: [
            {
                parts: [
                    ...imageParts,
                    { text: prompt },
                ],
            },
        ],
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 256,
        },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (fetchErr) {
        throw new Error(`Gemma network error: ${fetchErr.message}`);
    }

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemma API error (status ${res.status}): ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const rawText = cleanModelText(
        data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''
    );

    console.log(`[classify] Gemma raw response: ${rawText}`);

    let parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch (err) {
        // Try to extract JSON from text if Gemma added extra prose
        const jsonMatch = rawText.match(/\{[^}]+\}/);
        if (jsonMatch) {
            try {
                parsed = JSON.parse(jsonMatch[0]);
            } catch {
                throw new Error(`Gemma JSON parse failed: ${rawText.slice(0, 200)}`);
            }
        } else {
            throw new Error(`Gemma JSON parse failed: ${rawText.slice(0, 200)}`);
        }
    }

    const category = String(parsed.category || categories[0] || 'other').trim();
    const caption = String(parsed.caption || options.fallbackCaption || 'Great moment').trim();

    console.log(`[classify] ✅ Caption: "${caption}" | Category: "${category}"`);
    return { category, caption, titleMap: parseTitleMap() };
}

module.exports = { classifyClip, parseCategories, parseTitleMap };
