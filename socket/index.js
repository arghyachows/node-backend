const { Server } = require('socket.io');
const logger = require('../utils/logger');

function initSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: true,  // Reflect the request origin
      methods: ['GET', 'POST', 'OPTIONS'],
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization'],
    },
    transports: ['websocket', 'polling'],  // WebSocket first, polling fallback
    allowEIO3: true,  // Allow Engine.IO v3 clients
    pingTimeout: 60000,
    pingInterval: 25000,
    cookie: false,  // Disable cookies for cross-origin
    allowUpgrades: true,
  });

  io.on('connection', (socket) => {
    logger.info(`🔌 Client connected: ${socket.id}`);

    socket.on('joinMatch', (matchId) => {
      socket.join(matchId);
      logger.info(`👤 ${socket.id} joined match: ${matchId}`);
      socket.emit('joined', { matchId });
    });

    socket.on('leaveMatch', (matchId) => {
      socket.leave(matchId);
      logger.info(`👋 ${socket.id} left match: ${matchId}`);
    });

    socket.on('disconnect', () => {
      logger.info(`❌ Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

module.exports = initSocket;
