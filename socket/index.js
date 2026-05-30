const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const logger = require('../utils/logger');
const { redis, getMatchState } = require('../services/redis');

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

  // Enable Redis adapter for scaling across multiple instances in production
  if (process.env.REDIS_URL && process.env.NODE_ENV === 'production') {
    try {
      const pubClient = redis.duplicate();
      const subClient = redis.duplicate();
      io.adapter(createAdapter(pubClient, subClient));
      logger.info('📡 Socket.IO Redis adapter enabled for multi-node scaling');
    } catch (err) {
      logger.error('❌ Failed to initialize Socket.IO Redis adapter:', err);
    }
  }

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
            matchResult: state.matchComplete ? (() => {
              const battingFirstName = state.homeBatsFirst ? state.homeTeamName : state.awayTeamName;
              const battingSecondName = state.homeBatsFirst ? state.awayTeamName : state.homeTeamName;
              if (state.isSuperOver) {
                if (state.score2 > state.score1) {
                  return `${battingSecondName} wins the Super Over by ${10 - state.wickets2} wickets!`;
                } else if (state.score1 > state.score2) {
                  return `${battingFirstName} wins the Super Over by ${state.score1 - state.score2} runs!`;
                }
                return `${battingSecondName} wins the Super Over!`;
              }
              if (state.score2 > state.score1) {
                return `${battingSecondName} wins by ${10 - state.wickets2} wickets!`;
              } else if (state.score1 > state.score2) {
                return `${battingFirstName} wins by ${state.score1 - state.score2} runs!`;
              }
              return 'Match tied!';
            })() : null,
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
