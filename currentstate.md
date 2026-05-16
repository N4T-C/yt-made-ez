# Current State (2026-05-16)

- Electron migration scaffolding added (root package.json, electron/main.js, electron/preload.js, electron-builder.yml).
- Electron main process now uses app.isPackaged for dev detection (no electron-is-dev dependency).
- Server startup refactored into startServer(); production static serving added for client/dist.
- Writable paths now honor YT_DATA_DIR for reels/buffer/combined cleanup; font lookup checks Electron resources.
- Socket.IO clients now use window.location.origin for Electron/prod compatibility.
- App icon not yet provided (electron-builder config currently has no icon).

- README updated with Electron run/build steps and bundled FFmpeg note.

- Legacy Python folder removed; web app now owns all download/combine/overlay/trim/share logic.
- Server pipeline supports manual captions plus auto captions (random or Gemma) and auto trims to MAX_OUTPUT_SECONDS.
- Filebin sharing endpoint added; preview step can generate a shareable link.
- server/.env and server/.env.example updated to include Gemma, Filebin, and Discord keys.
- UI updated with caption-mode selector and Filebin share output.

## Notes
- Set FONT_PATH to server/fonts/OpenSansExtraBold.ttf (already bundled).
- Auto captions using Gemma require GEMINI_API_KEY; otherwise it falls back to simple captions.
