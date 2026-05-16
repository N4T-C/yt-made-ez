const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const videoRoutes = require('./routes/video');
const authRoutes = require('./routes/auth');
const discordRoutes = require('./routes/discord');
const { purgeAllVideos } = require('./services/cleanup');
const { runStartupChecks } = require('./services/preflight');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

// Make io accessible in routes
app.set('io', io);

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// Routes
app.use('/api/video', videoRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/discord', discordRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve built React frontend in production (when client/dist exists)
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;

let cleanupIntervalId = null;

function startServer(options = {}) {
  const resolvedPort = options.port || PORT;

  const startupChecks = runStartupChecks();
  if (!startupChecks.ok) {
    console.error('\n❌ Startup checks failed:');
    for (const err of startupChecks.errors) {
      console.error(`  - ${err}`);
    }
    console.error('\nFix the missing dependencies and restart the server.');
    return Promise.reject(new Error('Startup checks failed'));
  }

  // Clean up leftover video files from previous sessions on startup
  purgeAllVideos();

  // Periodic cleanup of abandoned videos (default: every 30 minutes)
  const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS, 10) || 30 * 60 * 1000;
  if (!cleanupIntervalId) {
    cleanupIntervalId = setInterval(() => purgeAllVideos(), CLEANUP_INTERVAL_MS);
  }

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${resolvedPort} is already in use!\n`);
        console.error('To fix this, run the following in PowerShell:');
        console.error(`  Stop-Process -Id (Get-NetTCPConnection -LocalPort ${resolvedPort} | Select-Object -ExpandProperty OwningProcess) -Force\n`);
        console.error("Then run 'node index.js' again.");
      } else {
        console.error('Server startup error:', err);
      }
      reject(err);
    };

    server.once('error', onError);
    server.listen(resolvedPort, () => {
      server.off('error', onError);
      console.log(`🚀 Server running on http://localhost:${resolvedPort}`);
      resolve({ port: resolvedPort, server });
    });
  });
}

if (require.main === module) {
  startServer().catch(() => process.exit(1));
}

module.exports = { startServer, app };
