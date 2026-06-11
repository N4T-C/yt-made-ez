/**
 * Discord Bot Service
 * Monitors a Discord channel for YouTube/Instagram links,
 * downloads them to buffer/staging, classifies them with Gemini into staging category directories,
 * and compiles them into a 5-clip ranking video once a category has exactly 5 clips.
 *
 * Ported from: yt-kitty-automate/functions/discord_bot.py
 */
const { Client, GatewayIntentBits } = require('discord.js');
const { downloadInstagramReel, getNextBufferFolder, BUFFER_DIR } = require('./reelDownload');
const { uploadToFilebin } = require('./filebinUpload');
const { classifyClip, parseTitleMap } = require('./classify');
const { combineAndOverlaySinglePass, probeClips } = require('./combine');
const { trimVideoInPlace } = require('./trimVideo');
const path = require('path');
const fs = require('fs');

const INSTAGRAM_PATTERN = /https?:\/\/(www\.)?instagram\.com\/(reels|reel|p)\/[A-Za-z0-9_-]+\/?/;
const YOUTUBE_PATTERN = /https?:\/\/(www\.)?(youtube\.com\/(shorts|watch\?v=)|youtu\.be\/)[A-Za-z0-9_-]+\/?/;

const POLL_INTERVAL = 10_000; // 10 seconds between each history check

let botInstance = null;
let pollTimer = null;
let botConfig = null;
let statusLog = [];

function addLog(msg) {
    const entry = { time: new Date().toISOString(), message: msg };
    statusLog.unshift(entry);
    if (statusLog.length > 50) statusLog.length = 50;
    console.log(`[discord-bot] ${msg}`);
}

function getStatus() {
    return {
        running: botInstance !== null && botInstance.isReady(),
        logs: statusLog.slice(0, 20),
    };
}

/**
 * Start the Discord bot with given config.
 */
async function startBot(config, io) {
    if (botInstance) {
        throw new Error('Bot is already running. Stop it first.');
    }

    const { token, channelId, filebinKey } = config;
    if (!token || !channelId) {
        throw new Error('Discord token and channel ID are required.');
    }

    botConfig = { token, channelId, filebinKey };
    statusLog = [];
    addLog('🤖 Starting Discord bot...');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    client.once('ready', () => {
        addLog(`✅ Bot logged in as ${client.user.tag}`);
        if (io) io.emit('discord:status', getStatus());

        // Start polling the channel for links
        pollTimer = setInterval(() => pollHistory(client, io), POLL_INTERVAL);
    });

    client.on('error', err => {
        addLog(`❌ Bot error: ${err.message}`);
    });

    try {
        await client.login(token);
        botInstance = client;
    } catch (err) {
        botInstance = null;
        addLog(`❌ Login failed: ${err.message}`);
        throw new Error(`Discord login failed: ${err.message}`);
    }
}

/**
 * Stop the Discord bot.
 */
async function stopBot() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    if (botInstance) {
        try {
            botInstance.destroy();
        } catch { /* ignore */ }
        botInstance = null;
    }

    addLog('🛑 Bot stopped.');
}

/**
 * Poll channel history for unprocessed links.
 * Mirrors the Python poll_history logic:
 * - Read messages until hitting "Flagged"
 * - Process each link found
 * - Post "Flagged" to mark as done
 */
async function pollHistory(client, io) {
    try {
        const channel = await client.channels.fetch(botConfig.channelId);
        if (!channel) {
            addLog(`⚠️ Could not find channel ${botConfig.channelId}`);
            return;
        }

        // Collect messages until we hit "Flagged"
        const messagesToProcess = [];
        const messages = await channel.messages.fetch({ limit: 100 });

        // Messages come newest→oldest, find "Flagged" and take everything before it
        const sortedMsgs = [...messages.values()];
        for (const msg of sortedMsgs) {
            if (msg.content.trim().toLowerCase() === 'flagged') break;
            if (msg.author.bot) continue;
            messagesToProcess.push(msg);
        }

        // Reverse so we process oldest first
        messagesToProcess.reverse();

        if (messagesToProcess.length === 0) return;

        let processedAny = false;

        for (const msg of messagesToProcess) {
            const igMatch = msg.content.match(INSTAGRAM_PATTERN);
            const ytMatch = msg.content.match(YOUTUBE_PATTERN);
            const linkUrl = igMatch ? igMatch[0] : (ytMatch ? ytMatch[0] : null);

            if (!linkUrl) continue;

            const remainingText = msg.content.replace(linkUrl, '').trim();
            const videoName = remainingText || linkUrl.split('/').filter(Boolean).pop();

            const platform = igMatch ? 'Instagram' : 'YouTube';
            addLog(`📥 Downloading ${platform} video: "${videoName}"...`);
            if (io) io.emit('discord:status', getStatus());

            // Create unique staging directory
            const stagingFolder = path.join(BUFFER_DIR, 'staging_' + Date.now() + '_' + Math.floor(Math.random() * 1000));

            try {
                await channel.send(`📥 Downloading ${platform} video: **${videoName}**...`);

                fs.mkdirSync(stagingFolder, { recursive: true });
                await downloadInstagramReel(linkUrl, stagingFolder);
                addLog(`✅ Downloaded from ${platform}`);

                // Find the downloaded file
                const files = fs.readdirSync(stagingFolder).filter(f => /\.(mp4|mkv|webm|mov|avi)$/i.test(f));
                if (files.length === 0) {
                    await channel.send('❌ No video file found after download.');
                    addLog('❌ No video file found after download.');
                    continue;
                }

                const videoFile = path.join(stagingFolder, files[0]);

                // Classify with Gemini
                addLog('🧠 Classifying video with Gemma...');
                if (io) io.emit('discord:status', getStatus());
                await channel.send('🧠 Classifying video content...');

                const { category, caption } = await classifyClip(videoFile, { fallbackCaption: videoName });

                const safeCategory = String(category || 'other').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
                const safeCaption = String(caption || 'clip').trim().replace(/[\\/:*?"<>|]/g, '');

                const destDir = path.join(BUFFER_DIR, safeCategory);
                if (!fs.existsSync(destDir)) {
                    fs.mkdirSync(destDir, { recursive: true });
                }

                const uniqueId = Date.now() + '_' + Math.floor(Math.random() * 1000);
                const finalDestPath = path.join(destDir, `${safeCaption}__${uniqueId}.mp4`);
                fs.renameSync(videoFile, finalDestPath);
                addLog(`✅ Classified under [${safeCategory}]: "${safeCaption}"`);
                await channel.send(`✅ Classified under category **${safeCategory}**: "${safeCaption}"`);

                processedAny = true;

            } catch (err) {
                await channel.send(`❌ Error: ${err.message}`).catch(() => {});
                addLog(`❌ Error processing link: ${err.message}`);
            } finally {
                // Clean up staging folder
                try {
                    fs.rmSync(stagingFolder, { recursive: true, force: true });
                } catch { /* ignore */ }
            }
        }

        // Mark as processed
        if (processedAny) {
            await channel.send('Flagged');
            // Check folders for 5 clips combinations
            await checkAndProcessCategoryFolders(channel, io);
        }

        if (io) io.emit('discord:status', getStatus());

    } catch (err) {
        addLog(`❌ Poll error: ${err.message}`);
    }
}

/**
 * Check subfolders in buffer/ directory. If any category has 5 clips, combine, overlay and upload.
 */
async function checkAndProcessCategoryFolders(channel, io) {
    try {
        if (!fs.existsSync(BUFFER_DIR)) return;

        const subdirs = fs.readdirSync(BUFFER_DIR).filter(d => {
            const fullPath = path.join(BUFFER_DIR, d);
            // Check it is a directory and not a numeric folder (numeric folders are temporary manual compilation tasks)
            return fs.statSync(fullPath).isDirectory() && isNaN(Number(d));
        });

        for (const dir of subdirs) {
            const dirPath = path.join(BUFFER_DIR, dir);
            const videoFiles = fs.readdirSync(dirPath).filter(f => /\.(mp4|mkv|webm|mov|avi)$/i.test(f));

            if (videoFiles.length === 5) {
                addLog(`🚀 Category "${dir}" has exactly 5 clips! Triggering compilation...`);
                await channel.send(`🚀 Category **${dir}** has exactly 5 clips! Starting compilation...`);
                if (io) io.emit('discord:status', getStatus());

                try {
                    // Probe clips to get accurate durations
                    const probedClips = await probeClips(dirPath, 5);

                    // Sort clips by duration ascending
                    const sortedMeta = probedClips.sort((a, b) => a.duration - b.duration);

                    // Get captions from filenames (split by __ to handle unique suffixes)
                    const captions = sortedMeta.map(m => {
                        const base = path.basename(m.filePath, path.extname(m.filePath));
                        const cap = base.split('__')[0];
                        return cap.replace(/_/g, ' ');
                    });

                    // Title mapping
                    const titleMap = parseTitleMap();
                    const videoTitle = (titleMap[dir] || dir).toUpperCase();

                    addLog('🎬 Combining clips and rendering ranking text...');
                    // Combine and overlay
                    const { outputFile } = await combineAndOverlaySinglePass(dir, videoTitle, captions, {
                        clipMeta: sortedMeta,
                        sortMode: 'provided',
                        useRankingBestLayout: true,
                    });

                    // Trim to 57 seconds
                    addLog('✂️ Trimming final video to 57s...');
                    const trimmedVideo = await trimVideoInPlace(outputFile, 57);

                    // Upload to Filebin
                    addLog('🔗 Uploading final ranking video to Filebin...');
                    
                    const origKey = process.env.FILEBIN_KEY;
                    if (botConfig.filebinKey) {
                        process.env.FILEBIN_KEY = botConfig.filebinKey;
                    }

                    const url = await uploadToFilebin(trimmedVideo, { deleteAfter: true });

                    if (botConfig.filebinKey) {
                        process.env.FILEBIN_KEY = origKey;
                    }

                    await channel.send(`🎉 **Compilation Complete for ${dir.toUpperCase()}!**\n🔗 Filebin Link: ${url}`);
                    addLog(`✅ Combined and uploaded category "${dir}": ${url}`);

                    // Clean up input clips
                    for (const m of sortedMeta) {
                        try {
                            fs.unlinkSync(m.filePath);
                        } catch (err) {
                            console.error(`Failed to delete clip ${m.filePath}:`, err.message);
                        }
                    }

                } catch (err) {
                    await channel.send(`❌ Compilation error for ${dir}: ${err.message}`);
                    addLog(`❌ Compilation error for "${dir}": ${err.message}`);
                }
            }
        }
    } catch (err) {
        addLog(`❌ Check folders error: ${err.message}`);
    }
}

module.exports = { startBot, stopBot, getStatus };
