const MatchEngine = require('./matchEngine');
const TournamentMatchEngine = require('./tournamentMatchEngine');
const { getMatchState, getActiveMatches, removeActiveMatch } = require('./redis');
const logger = require('../utils/logger');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const activeMatches = new Map();

const matchManager = {
  activeMatches,

  async recoverMatches(io) {
    logger.info('🔄 Attempting to recover active matches from Redis...');
    try {
      const matchIds = await getActiveMatches();
      logger.info(`Found ${matchIds.length} active match IDs to recover`);

      for (const matchId of matchIds) {
        try {
          const state = await getMatchState(matchId);
          if (!state || state.matchComplete) {
            logger.info(`Match ${matchId} is already complete or state missing, removing from active list`);
            await removeActiveMatch(matchId);
            continue;
          }

          if (!activeMatches.has(matchId)) {
            logger.info(`♻️ Recovering match ${matchId}...`);
            let engine;
            if (state.isTournament) {
              engine = TournamentMatchEngine.fromState(state, io, supabase);
            } else {
              engine = MatchEngine.fromState(state, io);
            }
            activeMatches.set(matchId, engine);
            engine.start();
          }
        } catch (err) {
          logger.error(`Error recovering match ${matchId}:`, err);
        }
      }
    } catch (err) {
      logger.error('Global match recovery error:', err);
    }
  },

  startMatch(matchId, config, io) {
    if (activeMatches.has(matchId)) {
      return activeMatches.get(matchId);
    }
    const engine = new MatchEngine(matchId, config, io);
    activeMatches.set(matchId, engine);
    engine.start();
    return engine;
  },

  startTournamentMatch(matchId, config, io, supabaseClient, tournamentId) {
    if (activeMatches.has(matchId)) {
      return activeMatches.get(matchId);
    }
    const engine = new TournamentMatchEngine(matchId, config, io, supabaseClient, tournamentId);
    activeMatches.set(matchId, engine);
    engine.start();
    return engine;
  },

  stopMatch(matchId) {
    const engine = activeMatches.get(matchId);
    if (engine) {
      engine.stop();
      activeMatches.delete(matchId);
    }
  },

  getEngine(matchId) {
    return activeMatches.get(matchId);
  }
};

module.exports = matchManager;
