const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const isDev = !app.isPackaged;

let mainWindow = null;
let serverInstance = null;
let backendPort = Number(process.env.PORT) || 5000;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function resolveEnvPath() {
  if (isDev) {
    return path.join(__dirname, '..', 'server', '.env');
  }

  const userEnvPath = path.join(app.getPath('userData'), '.env');
  if (!fs.existsSync(userEnvPath)) {
    const examplePath = path.join(__dirname, '..', 'server', '.env.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, userEnvPath);
    }
  }

  return userEnvPath;
}

function configureRuntimeEnv() {
  process.env.YT_DATA_DIR = process.env.YT_DATA_DIR || app.getPath('userData');
  const envPath = resolveEnvPath();
  if (envPath) {
    process.env.DOTENV_CONFIG_PATH = envPath;
  }
}

async function startBackend() {
  configureRuntimeEnv();

  const { startServer } = require(path.join(__dirname, '..', 'server', 'index.js'));
  try {
    const { port, server } = await startServer();
    serverInstance = server;
    backendPort = port;
    return port;
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      backendPort = Number(process.env.PORT) || 5000;
      return backendPort;
    }
    throw err;
  }
}

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const startUrl = isDev
    ? 'http://localhost:5173'
    : `http://localhost:${port}`;

  mainWindow.loadURL(startUrl);
}

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:open-external', async (_event, url) => {
  if (typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  try {
    const port = await startBackend();
    createMainWindow(port);
  } catch (err) {
    console.error('Failed to start app:', err);
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !mainWindow) {
    createMainWindow(backendPort);
  }
});

app.on('before-quit', () => {
  if (serverInstance && typeof serverInstance.close === 'function') {
    try { serverInstance.close(); } catch { /* ignore */ }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
