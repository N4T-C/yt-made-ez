const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { GoogleGenAI } = require('@google/genai');
const { ffmpegPath, ffprobePath } = require('ffmpeg-ffprobe-static');

const DEFAULT_CAPTIONS = [
    'Epic', 'Insane', 'Wild', 'Clutch', 'Legendary', 'Big Energy', 'Smooth Move',
    'Amazing', 'Unreal', 'Perfect', 'Classic', 'Iconic', 'Elite', 'Respect',
    'Wow', 'Vibes', 'Mood', 'Goals', 'Clean', 'Pro', 'God Mode', 'GG', 'EZ'
];

function getRandomCaption() {
    return DEFAULT_CAPTIONS[Math.floor(Math.random() * DEFAULT_CAPTIONS.length)];
}

function generateCaptions(count = 5) {
    const source = [...DEFAULT_CAPTIONS];
    const picks = [];

    while (picks.length < count && source.length > 0) {
        const idx = Math.floor(Math.random() * source.length);
        picks.push(source.splice(idx, 1)[0]);
    }

    while (picks.length < count) {
        picks.push(getRandomCaption());
    }

    return picks;
}

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
        proc.on('error', reject);
    });
}

function processClipForGemini(filePath, duration) {
    return new Promise((resolve, reject) => {
        const maxDuration = 56; // safe limit for Gemini content generation
        const args = [
            '-v', 'error',
            '-i', filePath,
        ];

        if (duration > maxDuration) {
            args.push('-t', String(maxDuration));
        }

        args.push(
            '-an',                              // strip audio to keep it light
            '-vf', 'scale=320:-2,fps=10',       // downscale and reduce framerate to make buffer tiny
            '-vcodec', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'ultrafast',
            '-crf', '32',
            '-f', 'mp4',
            '-movflags', 'frag_keyframe+empty_moov',
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
        proc.on('error', reject);
    });
}

function getAllVideos() {
    const SERVER_ROOT = path.join(__dirname, '..');
    const WRITABLE_ROOT = process.env.YT_DATA_DIR || SERVER_ROOT;
    const BUFFER_DIR = path.join(WRITABLE_ROOT, 'buffer');

    if (!fs.existsSync(BUFFER_DIR)) {
        try { fs.mkdirSync(BUFFER_DIR, { recursive: true }); } catch {}
        return [];
    }

    const allVideos = [];
    try {
        const folders = fs.readdirSync(BUFFER_DIR);
        for (const folder of folders) {
            const fullPath = path.join(BUFFER_DIR, folder);
            if (fs.statSync(fullPath).isDirectory()) {
                const files = fs.readdirSync(fullPath).filter(f => /\.(mp4|mov|mkv)$/i.test(f));
                allVideos.push(...files);
            }
        }
    } catch (err) {
        console.error('[captionGenerator] getAllVideos error:', err.message);
    }
    return allVideos;
}

async function generateCaptionForClip(filePath, existingCaptions = []) {
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        console.warn('[captionGenerator] No GEMINI_API_KEY set — using fallback.');
        return getRandomCaption();
    }

    if (!fs.existsSync(filePath)) {
        console.error(`[captionGenerator] File not found: ${filePath}`);
        return getRandomCaption();
    }

    try {
        const duration = await probeDuration(filePath);
        const videoBuffer = await processClipForGemini(filePath, duration);
        const ai = new GoogleGenAI({ apiKey });
        const model = process.env.GEMINI_MODEL || 'gemma-4-31b-it';

        const categoriesRaw = process.env.CATEGORIES || 'cats, dogs, memes, other';
        const categories = categoriesRaw.split(',').map(c => c.trim()).filter(Boolean);
        const blacklist = [...getAllVideos(), ...existingCaptions];

        const prompt = [
            'You are a classifier and video describer. AND FOLLOW STRICT INSTUCTION. OUPUT ONLY JSON AND NOTHING ELSE.',
            'Make a high descriptive caption for the given video. And add a bit of humor, or make the caption catchy. Strict 2 word caption limit. Do not use any special characters or symbols in the caption as it will be used as a filename.',
            '',
            'Choose ONE category from this list:',
            JSON.stringify(categories),
            'And don\'t use the below for caption:',
            JSON.stringify(blacklist),
            'ONLY OUTPUT THE JSON, NOT ANYTHING ELSE. JUST THE JSON FORMAT SPECIFIED BELOW.',
            'Return ONLY strict JSON in this format:',
            '{',
            '  "category":"chosen category",',
            '  "caption":"short 2 word caption for video, for youtube shorts"',
            '}'
        ].join('\n');

        console.log(`[captionGenerator] Sending clip ${path.basename(filePath)} (${duration.toFixed(1)}s) to ${model}...`);
        const response = await ai.models.generateContent({
            model: model,
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

        let text = String(response?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || response?.text || '').trim();
        
        // Clean markdown ```json ```
        text = text.replace(/^```json\s*/i, '')
                   .replace(/^```\s*/i, '')
                   .replace(/```\s*$/i, '')
                   .trim();

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            const m = text.match(/\{[^}]+\}/);
            if (m) {
                try { parsed = JSON.parse(m[0]); } catch {}
            }
        }

        if (!parsed || !parsed.caption) {
            throw new Error(`Failed to parse valid JSON with caption: ${text}`);
        }

        let caption = String(parsed.caption).trim();
        
        // Clean any quotes and formatting
        caption = caption.replace(/['"“”`*#_]/g, '').trim();

        // Enforce 1-2 words limit
        const words = caption.split(/\s+/).filter(Boolean);
        if (words.length > 2) {
            caption = words.slice(0, 2).join(' ');
        }
        
        // Remove common generic fallback values that look bad or are just punctuation/placeholders (e.g. "...")
        const lower = caption.toLowerCase();
        const alphanumeric = caption.replace(/[^a-zA-Z0-9]/g, '').trim();
        if (!caption || words.length === 0 || !alphanumeric || lower.includes('clip') || lower.includes('video') || lower.match(/clip\s*\d*/i)) {
            return getRandomCaption();
        }

        console.log(`[captionGenerator] ✅ Generated caption: "${caption}" | Category: "${parsed.category}"`);
        return caption;
    } catch (err) {
        console.error(`[captionGenerator] Error generating caption: ${err.message}`);
        return getRandomCaption();
    }
}

module.exports = {
    getRandomCaption,
    generateCaptions,
    generateCaptionForClip
};
