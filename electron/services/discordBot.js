/**
 * Discord Bot Service — Electron version
 * Instead of emitting Socket.IO events, this emits IPC events
 * to the renderer via the mainWindow webContents.
 *
 * Usage: call setMainWindow(win) once from main.js after window is created.
 */
const { Client, GatewayIntentBits } = require('discord.js');
const { downloadInstagramReel, getNextBufferFolder } = require('./reelDownload');
const { uploadToFilebin } = require('./filebinUpload');
const path = require('path');
const fs = require('fs');

const INSTAGRAM_PATTERN = /https?:\/\/(www\.)?instagram\.com\/(reels|reel|p)\/[A-Za-z0-9_-]+\/?/;
const YOUTUBE_PATTERN = /https?:\/\/(www\.)?(youtube\.com\/(shorts|watch\?v=)|youtu\.be\/)[A-Za-z0-9_-]+\/?/;

const POLL_INTERVAL = 10_000;

let botInstance = null;
let pollTimer = null;
let botConfig = null;
let statusLog = [];

// Reference to the Electron BrowserWindow for pushing events to renderer
let _mainWindow = null;

function setMainWindow(win) {
    _mainWindow = win;
}

function pushToRenderer(channel, data) {
    if (_mainWindow && !_mainWindow.isDestroyed()) {
        _mainWindow.webContents.send(channel, data);
    }
}

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

async function startBot(config) {
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
        pushToRenderer('discord:status', getStatus());

        pollTimer = setInterval(() => pollHistory(client), POLL_INTERVAL);
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

async function pollHistory(client) {
    try {
        const channel = await client.channels.fetch(botConfig.channelId);
        if (!channel) {
            addLog(`⚠️ Could not find channel ${botConfig.channelId}`);
            return;
        }

        const messagesToProcess = [];
        const messages = await channel.messages.fetch({ limit: 100 });

        const sortedMsgs = [...messages.values()];
        for (const msg of sortedMsgs) {
            if (msg.content.trim().toLowerCase() === 'flagged') break;
            if (msg.author.bot) continue;
            messagesToProcess.push(msg);
        }

        messagesToProcess.reverse();

        if (messagesToProcess.length === 0) return;

        let processedAny = false;

        for (const msg of messagesToProcess) {
            const igMatch = msg.content.match(INSTAGRAM_PATTERN);
            const ytMatch = msg.content.match(YOUTUBE_PATTERN);
            const linkUrl = igMatch ? igMatch[0] : (ytMatch ? ytMatch[0] : null);

            if (!linkUrl) continue;

            const platform = igMatch ? 'Instagram' : 'YouTube';
            addLog(`📥 Downloading ${platform} video...`);
            pushToRenderer('discord:status', getStatus());

            try {
                await channel.send(`📥 Downloading ${platform} video...`);

                const bufferFolder = getNextBufferFolder();

                await downloadInstagramReel(linkUrl, bufferFolder);
                addLog(`✅ Downloaded from ${platform}`);

                const files = fs.readdirSync(bufferFolder).filter(f => /\.(mp4|mkv|webm|mov|avi)$/i.test(f));
                if (files.length === 0) {
                    await channel.send('❌ No video file found after download.');
                    addLog('❌ No video file found after download.');
                    continue;
                }

                const videoFile = path.join(bufferFolder, files[0]);

                addLog('🔗 Uploading to Filebin...');
                pushToRenderer('discord:status', getStatus());

                const origKey = process.env.FILEBIN_KEY;
                if (botConfig.filebinKey) {
                    process.env.FILEBIN_KEY = botConfig.filebinKey;
                }

                const url = await uploadToFilebin(videoFile, { deleteAfter: false });

                if (botConfig.filebinKey) {
                    process.env.FILEBIN_KEY = origKey;
                }

                await channel.send(`✅ Ready! Filebin: ${url}`);
                addLog(`✅ Uploaded to Filebin: ${url}`);
                processedAny = true;

                try {
                    for (const f of fs.readdirSync(bufferFolder)) {
                        try { fs.unlinkSync(path.join(bufferFolder, f)); } catch { /* ignore */ }
                    }
                    fs.rmdirSync(bufferFolder);
                } catch { /* ignore */ }

            } catch (err) {
                await channel.send(`❌ Error: ${err.message}`).catch(() => {});
                addLog(`❌ Error processing link: ${err.message}`);
            }
        }

        if (processedAny) {
            await channel.send('Flagged');
        }

        pushToRenderer('discord:status', getStatus());

    } catch (err) {
        addLog(`❌ Poll error: ${err.message}`);
    }
}

module.exports = { startBot, stopBot, getStatus, setMainWindow };
