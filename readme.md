# 🐱 YT Made EZ Studio

A full-stack web app that downloads 5 Instagram/YouTube clips, combines them into a single 1080×1920 vertical video, burns ranked captions and a title overlay onto the video, and uploads the final result directly to YouTube — all from your browser.

---

## 🔒 Application-Level Authentication (Excel Database)

Access to this studio is protected by application-level credentials checked against `server/users.xlsx` in the backend. 
- **Default Accounts**: Preconfigured with `admin` / `admin123` and `natc` / `testingisnatc`.
- **Adding Users**: Open `server/users.xlsx` in Excel (or any spreadsheet software) and add new rows with columns `username` and `password`. The changes are loaded dynamically upon login requests without needing to restart the server.

---

# 🖥️ Electron Desktop App – Run & Build

This project now supports an Electron desktop app that embeds the existing Express server and serves the React UI from the same process.

## 0. Prerequisites

- Node.js 18+ (20+ recommended)

## 1. Install Dependencies (All three locations)

From the project root:

```bash
# Root (Electron tooling)
npm install

# Server
cd server
npm install

# Client
cd ../client
npm install

cd ..
```

## 2. Configure the .env file

### Development

Edit the existing file:

```
server/.env
```

### Packaged app (production)

On first launch, the app copies `server/.env.example` to your userData folder.
Edit the file here after the first run:

```
%APPDATA%\yt-automation-studio\.env
```

## 3. Run Electron (Dev)

This runs Vite on port 5173 and starts Electron with the embedded backend.

```bash
npm run dev
```

## 4. Run Electron (Production-style)

This builds the React frontend and serves it from the embedded Express server.

```bash
npm run build:client
npm start
```

## 5. Package Windows Executables

```bash
# Installer + portable build
npm run dist

# Portable only
npm run dist:portable
```

Build outputs land in:

```
release/
```

---

# 🖥️ Web App Setup Guide – Local Development

---

## 1. FFmpeg (Bundled by default)

FFmpeg and FFprobe are provided by the `ffmpeg-ffprobe-static` npm package, so a system install is not required.
If you already have FFmpeg in PATH, it will not interfere.

---

## 2. Install Project Dependencies


From the project root:

```bash
# Server
cd server
npm install

# Client
cd ../client
npm install
```

---

## 3. Configure the `.env` File

The server reads credentials from `server/.env`. It should already exist. Confirm it contains:

```env
PORT=5000
CLIENT_URL=http://localhost:5173

GOOGLE_CLIENT_ID=<your-client-id>
GOOGLE_CLIENT_SECRET=<your-client-secret>
GOOGLE_REDIRECT_URI=http://localhost:5000/api/auth/google/callback

NVIDIA_GPU=True
FONT_PATH=fonts/OpenSansExtraBold.ttf
MAX_OUTPUT_SECONDS=56

# Filebin (optional, for share links)
FILEBIN_KEY=<your-filebin-key>

# Gemini captions (optional)
GEMINI_API_KEY=<your-gemini-api-key>
GEMINI_MODEL=gemma-4-31b-it
CATEGORIES=cats, dogs, memes, other
TITLE={"cats":"KITTY MOMENTS","dogs":"PUPPY MOMENTS","other":"WORTHY MOMENTS"}

# Discord ingest (optional)
DISCORD_TOKEN=<your-discord-bot-token>
CHANNEL_ID=1234567890
```

> ⚠️ `GOOGLE_REDIRECT_URI` must be exactly `http://localhost:5000/api/auth/google/callback` — **not** the frontend port.

---

## 4. Configure Google OAuth in the Cloud Console

Open: https://console.cloud.google.com/apis/credentials

Click your existing **OAuth 2.0 Client ID** (or create one if needed).

### Authorized JavaScript Origins
```
http://localhost:5173
```

### Authorized Redirect URIs
```
http://localhost:5000/api/auth/google/callback
```

Click **Save**.

---

## 5. Add Test Users

If your app is not yet verified by Google, only pre-approved accounts can sign in.

Open: **Google Cloud Console → OAuth Consent Screen → Test Users**

Add the Gmail addresses you want to allow (e.g. `nathanielc2007@gmail.com`).

Click **Save**.

> Google allows up to 100 test users while the app is in testing mode. Verification is only needed for public release.

---

## 6. Run the Development Servers

**Terminal 1 – Backend:**

```bash
cd server
npm start
```

Runs on: `http://localhost:5000`

**Terminal 2 – Frontend:**

```bash
cd client
npm run dev
```

Runs on: `http://localhost:5173`

Open `http://localhost:5173` in your browser.

---

## 7. Common Errors & Fixes

### `spawn ffprobe ENOENT`
FFmpeg is not installed or not in PATH.  
Fix: complete step 1 above and add `C:\ffmpeg\bin` to System PATH.

### `Error 400: redirect_uri_mismatch`
The redirect URI in Google Cloud Console does not match `GOOGLE_REDIRECT_URI` in `.env`.  
Fix: make sure **exactly** `http://localhost:5000/api/auth/google/callback` is listed under Authorized Redirect URIs.

### `Access blocked – This app's request is invalid`
Your account is not added as a test user.  
Fix: add your Gmail in Google Cloud Console → OAuth Consent Screen → Test Users.

---

---

# 🎨 Customization Guide

This section documents every place you can make visual or behavioural changes to your liking.

---

## Colors & Theme

All global colors are CSS variables defined at the top of:

```
client/src/index.css
```

Look for the `:root` block. Key variables:

| Variable | What it controls |
|---|---|
| `--bg` | Page background color |
| `--card-bg` | Feature card / modal background |
| `--card-border` | Card/modal border color |
| `--text-primary` | Main text color |
| `--text-secondary` | Subtitle / hint text color |
| `--accent` | Primary accent color (buttons, highlights) |

Change any of these values to restyle the whole app at once.

---

## Gradient Colors (Hero title & modal header)

The colorful gradient on "Automate Your YouTube Content" and the modal title is an inline `background` style in:

```
client/src/pages/Home.jsx        ← hero title words (.word-auto, .word-your, etc.)
client/src/components/RankingWizard.jsx   ← modal header gradient
```

Search for `linear-gradient` and change the hex color stops (`#EA4335`, `#FBBC04`, `#A142F4`) to any colors you want.

---

## Button Styles

Primary and secondary button styles live in `client/src/index.css`:

```css
.btn-primary  { ... }
.btn-secondary { ... }
```

Change `background`, `border-radius`, `padding`, `font-size`, or `color` there.

---

## Step / Phase Labels and Icons

The 6 wizard steps are defined at the top of:

```
client/src/components/RankingWizard.jsx
```

```js
const STEPS = [
    { label: 'Platform', icon: '🎯' },
    { label: 'Video Info', icon: '📝' },
    { label: 'Processing', icon: '⚙️' },
    { label: 'Preview', icon: '🎬' },
    { label: 'YT Details', icon: '📋' },
    { label: 'Upload', icon: '🚀' },
]
```

Change any `label` or `icon` emoji freely — the step indicator and subtitle update automatically.

---

## Feature Cards (Home page)

The four cards on the homepage are defined in the `FEATURES` array at the top of:

```
client/src/pages/Home.jsx
```

You can change the `icon`, `label`, `desc`, and `iconClass` for each card.  
`iconClass` maps to CSS classes like `.card-icon-red`, `.card-icon-yellow`, etc. in `index.css`.

---

## Video Overlay Font

The font burned onto the video is set in `server/.env`:

```env
FONT_PATH=fonts/OpenSansExtraBold.ttf
```

Replace that `.ttf` file (or point `FONT_PATH` to any other `.ttf`) to change the overlay font.

---

## Default YouTube Upload Settings

On the homepage, click **"Set YouTube Upload Defaults"** to pre-fill every YT Details field (title, description, tags, privacy, category, etc.) for all future uploads. These are saved to your browser's `localStorage` and persist between sessions.

---

## Clip Count (currently hardcoded to 5)

The number of clips is assumed to be exactly 5 in several places. To change it search for the number `5` in:

```
client/src/components/RankingWizard.jsx   ← links/captions arrays
server/routes/video.js                    ← validation
server/services/combine.js                ← video pipeline
```

and update consistently.

---

# ✨ Automation Features

- **Excel Auth**: High-performance gated application entrance.
- **Discord Bot Ingest**: A JavaScript daemon inside `server/services/discordBot.js` that polls Discord channels for links, downscales/mutes and classifies them using Gemma, groups them into categories, and automatically compiles them into ranking videos once a category reaches exactly 5 clips.
- **Auto captions**: Choose Manual, Random, or Gemini-powered captions in the wizards.
- **Short-form trimming**: Finished videos are auto-trimmed to `MAX_OUTPUT_SECONDS` (default 56/57s).
- **Filebin sharing**: Generate a shareable link from the preview step.
- **Wizard Navigation**: Improved preview back-button flow directly to the link/caption entry page.
