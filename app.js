require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const initSocket = require('./socket');
const matchRoutes = require('./routes/match');
const multiplayerRoutes = require('./routes/multiplayer');
const { initScheduler } = require('./services/scheduler');
const logger = require('./utils/logger');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = initSocket(server);
app.set('io', io);

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests' },
});
app.use(limiter);

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/health', (req, res) => {
  logger.info(`🏥 Health check from ${req.ip}`);
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint for browser
app.get('/test', (req, res) => {
  logger.info(`🧪 Test endpoint hit from ${req.ip}`);
  res.json({ 
    message: 'Backend is reachable from browser!',
    timestamp: new Date().toISOString(),
    headers: req.headers
  });
});

// Log all requests
app.use((req, res, next) => {
  logger.info(`📥 ${req.method} ${req.path} from ${req.ip}`);
  next();
});

// Routes
app.use('/api/match', matchRoutes);
app.use('/api/multiplayer', multiplayerRoutes);

// Error handling
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize scheduler
initScheduler();

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);
server.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`📡 WebSocket server ready`);
  logger.info(`🏏 Match engine ready`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
