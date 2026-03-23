const Redis = require('ioredis');
const logger = require('../utils/logger');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => {
  logger.info('✅ Redis connected');
});

redis.on('error', (err) => {
  logger.error('❌ Redis error:', err);
});

// Helper methods
const redisHelper = {
  // Match state
  async setMatchState(matchId, state) {
    await redis.set(`match:${matchId}`, JSON.stringify(state), 'EX', 3600);
  },

  async getMatchState(matchId) {
    const data = await redis.get(`match:${matchId}`);
    return data ? JSON.parse(data) : null;
  },

  async deleteMatchState(matchId) {
    await redis.del(`match:${matchId}`);
  },

  // Active matches tracking
  async addActiveMatch(matchId) {
    await redis.sadd('active_matches', matchId);
  },

  async removeActiveMatch(matchId) {
    await redis.srem('active_matches', matchId);
  },

  async getActiveMatches() {
    return await redis.smembers('active_matches');
  },

  // Pub/Sub for match updates
  async publishMatchUpdate(matchId, data) {
    await redis.publish(`match:${matchId}:updates`, JSON.stringify(data));
  },

  // Commentary cache
  async getCachedCommentary(key) {
    return await redis.get(`commentary:${key}`);
  },

  async setCachedCommentary(key, commentary) {
    await redis.set(`commentary:${key}`, commentary, 'EX', 86400); // 24 hours
  },
};

module.exports = { redis, ...redisHelper };
