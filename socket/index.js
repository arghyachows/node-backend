const { Server } = require('socket.io');
const logger = require('../utils/logger');
const { getMatchState } = require('../services/redis');

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

    socket.on('joinMatch', async (matchId) => {
      socket.join(matchId);
      logger.info(`👤 ${socket.id} joined match: ${matchId}`);

      // Send current match state including commentary history
      try {
        const state = await getMatchState(matchId);
        socket.emit('joined', {
          matchId,
          commentaryLog: state?.commentaryLog || [],
          state: state ? {
            innings: state.innings,
            overNumber: state.overNumber,
            ballNumber: state.ballNumber,
            score1: state.score1,
            wickets1: state.wickets1,
            score2: state.score2,
            wickets2: state.wickets2,
            target: state.target,
            matchComplete: state.matchComplete,
            homeBatsFirst: state.homeBatsFirst,
            batsmanStats: state.batsmanStats,
            bowlerStats: state.bowlerStats,
            currentBatsman: state.currentBatsman?.name,
            nonStriker: state.nonStriker?.name,
            currentBowler: state.currentBowler?.name,
          } : null,
        });
      } catch (err) {
        logger.warn(`Failed to fetch state for joinMatch ${matchId}:`, err.message);
        socket.emit('joined', { matchId, commentaryLog: [], state: null });
      }
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
