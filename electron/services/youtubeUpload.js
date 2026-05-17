/**
 * YouTube Upload Service — Electron version
 * Reads OAuth credentials from process.env (loaded via dotenv in main.js).
 */
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

function createOAuth2Client() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
}

function getAuthUrl() {
    const oauth2Client = createOAuth2Client();
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/youtube.upload',
            'https://www.googleapis.com/auth/youtube',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
        ],
        prompt: 'consent',
    });
}

async function getTokensFromCode(code) {
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
}

async function getUserInfo(tokens) {
    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    return { name: data.name, email: data.email, picture: data.picture };
}

async function refreshAccessToken(refreshToken) {
    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();
    return credentials;
}

async function uploadToYouTube(videoFilePath, metadata, tokens) {
    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials(tokens);

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const {
        title = 'Untitled Video',
        description = '',
        tags = [],
        privacyStatus = 'private',
        categoryId = '22',
        madeForKids = false,
        language = 'en',
        defaultAudioLanguage = 'en',
        recordingDate = '',
        license = 'youtube',
        embeddable = true,
        publicStatsViewable = true,
        notifySubscribers = true,
    } = metadata;

    const requestBody = {
        snippet: {
            title,
            description,
            tags: Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim()),
            categoryId: String(categoryId),
            defaultLanguage: language,
            defaultAudioLanguage,
        },
        status: {
            privacyStatus,
            selfDeclaredMadeForKids: madeForKids === true || madeForKids === 'true',
            license,
            embeddable: embeddable === true || embeddable === 'true',
            publicStatsViewable: publicStatsViewable === true || publicStatsViewable === 'true',
        },
    };

    if (recordingDate) {
        requestBody.recordingDetails = {
            recordingDate: recordingDate,
        };
    }

    const fileSize = fs.statSync(videoFilePath).size;

    console.log(`📤 Uploading to YouTube: "${title}" (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

    const response = await youtube.videos.insert({
        part: ['snippet', 'status', 'recordingDetails'].join(','),
        notifySubscribers: notifySubscribers === true || notifySubscribers === 'true',
        requestBody,
        media: {
            body: fs.createReadStream(videoFilePath),
        },
    });

    console.log(`✅ Upload complete! Video ID: ${response.data.id}`);
    return response.data;
}

module.exports = { createOAuth2Client, getAuthUrl, getTokensFromCode, getUserInfo, refreshAccessToken, uploadToYouTube };
