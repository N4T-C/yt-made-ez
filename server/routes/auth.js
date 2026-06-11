/**
 * Google OAuth Routes
 * Handles Google sign-in for YouTube upload authorization.
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { getAuthUrl, getTokensFromCode, getUserInfo, refreshAccessToken } = require('../services/youtubeUpload');

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Validates against server/users.xlsx.
 */
router.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const excelPath = path.join(__dirname, '..', 'users.xlsx');

    // If Excel file doesn't exist, create one with default user: admin / admin123
    if (!fs.existsSync(excelPath)) {
        try {
            const wb = XLSX.utils.book_new();
            const wsData = [
                ['username', 'password'],
                ['admin', 'admin123']
            ];
            const ws = XLSX.utils.aoa_to_sheet(wsData);
            XLSX.utils.book_append_sheet(wb, ws, 'Users');
            XLSX.writeFile(wb, excelPath);
            console.log(`Created default users.xlsx at ${excelPath}`);
        } catch (err) {
            console.error('Failed to create default users.xlsx:', err);
        }
    }

    try {
        const workbook = XLSX.readFile(excelPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const users = XLSX.utils.sheet_to_json(worksheet);

        // Check user exists using AND logic
        const matchedUser = users.find(u => {
            const uName = String(u.username || '').trim();
            const uPass = String(u.password || '').trim();
            return uName === String(username).trim() && uPass === String(password).trim();
        });

        if (matchedUser) {
            return res.json({ success: true, user: { username: matchedUser.username } });
        } else {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
    } catch (err) {
        console.error('Error reading users.xlsx:', err);
        return res.status(500).json({ error: 'Verification database error' });
    }
});

/**
 * GET /api/auth/google
 * Redirects user to Google OAuth consent screen.
 */
router.get('/google', (req, res) => {
    const url = getAuthUrl();
    res.json({ url });
});

/**
 * GET /api/auth/google/callback
 * Handles the OAuth callback, exchanges code for tokens.
 * Redirects back to the frontend with tokens as URL params.
 */
router.get('/google/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.status(400).json({ error: 'Authorization code missing' });
    }

    try {
        const tokens = await getTokensFromCode(code);

        // Redirect back to frontend with tokens
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        const tokenParam = encodeURIComponent(JSON.stringify(tokens));
        res.redirect(`${clientUrl}?tokens=${tokenParam}`);
    } catch (error) {
        console.error('OAuth error:', error);
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        res.redirect(`${clientUrl}?error=${encodeURIComponent(error.message)}`);
    }
});

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile info.
 * Accepts tokens via Authorization header (Bearer JSON) or query param.
 */
router.get('/me', async (req, res) => {
    try {
        let tokens;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            tokens = JSON.parse(authHeader.slice(7));
        } else if (req.query.tokens) {
            tokens = JSON.parse(decodeURIComponent(req.query.tokens));
        }

        if (!tokens) {
            return res.status(401).json({ error: 'No tokens provided' });
        }

        const user = await getUserInfo(tokens);
        res.json(user);
    } catch (error) {
        console.error('Auth /me error:', error.message);
        res.status(401).json({ error: 'Invalid or expired tokens' });
    }
});

/**
 * POST /api/auth/refresh
 * Accepts { refresh_token } and returns new credentials.
 */
router.post('/refresh', async (req, res) => {
    try {
        const { refresh_token } = req.body;
        if (!refresh_token) {
            return res.status(400).json({ error: 'refresh_token is required' });
        }

        const credentials = await refreshAccessToken(refresh_token);
        res.json(credentials);
    } catch (error) {
        console.error('Token refresh error:', error.message);
        res.status(401).json({ error: 'Could not refresh token' });
    }
});

module.exports = router;
