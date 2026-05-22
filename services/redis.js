const Redis = require('ioredis');
const logger = require('../utils/logger');

// Support both REDIS_URL (full URL) and individual components (for Kubernetes)
// Railway Redis URLs follow the format: redis://:password@host:port
// ioredis can sometimes fail to apply auth from the URL alone, so we
// extract the password and pass it as a discrete option to guarantee
// AUTH is sent on every (re)connection.
let redisUrl, redisPassword;

if (process.env.REDIS_URL) {
  redisUrl = process.env.REDIS_URL;
  const parsedUrl = new URL(redisUrl);
  redisPassword = parsedUrl.password || undefined;
} else {
  // Build URL from individual components (Kubernetes)
  const host = process.env.REDIS_HOST || 'localhost';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD || '';
  redisPassword = password || undefined;
  redisUrl = `redis://${host}:${port}`;
}

const redis = new Redis(redisUrl, {
  password: redisPassword,
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
    // 24 hours TTL so completed match commentary persists for viewing
    await redis.set(`match:${matchId}`, JSON.stringify(state), 'EX', 86400);
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
