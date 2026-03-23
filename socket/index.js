const { Server } = require("socket.io");
const logger = require("../utils/logger");

function initSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: false,
    },
    transports: ["polling", "websocket"], // Polling first for Railway
    allowEIO3: true, // Allow Engine.IO v3 clients
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.on("connection", (socket) => {
    logger.info(`🔌 Client connected: ${socket.id}`);

    socket.on("joinMatch", (matchId) => {
      socket.join(matchId);
      logger.info(`👤 ${socket.id} joined match: ${matchId}`);
      socket.emit("joined", { matchId });
    });

    socket.on("leaveMatch", (matchId) => {
      socket.leave(matchId);
      logger.info(`👋 ${socket.id} left match: ${matchId}`);
    });

    socket.on("disconnect", () => {
      logger.info(`❌ Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

module.exports = initSocket;
