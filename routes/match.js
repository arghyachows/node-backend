const express = require('express');
const router = express.Router();
const MatchEngine = require('../services/matchEngine');
const { getMatchState, addActiveMatch, removeActiveMatch } = require('../services/redis');
const logger = require('../utils/logger');

// Store active match engines
const activeMatches = new Map();

// Start match
router.post('/start', async (req, res) => {
  try {
    const { matchId, config } = req.body;

    if (!matchId || !config) {
      return res.status(400).json({ error: 'matchId and config required' });
    }

    // Check if match already running
    if (activeMatches.has(matchId)) {
      return res.status(400).json({ error: 'Match already running' });
    }

    // Create match engine
    const io = req.app.get('io');
    const engine = new MatchEngine(matchId, config, io);
    activeMatches.set(matchId, engine);

    // Track active match
    await addActiveMatch(matchId);

    // Start simulation
    engine.start();

    logger.info(`✅ Match ${matchId} started`);
    res.json({ success: true, matchId });
  } catch (error) {
    logger.error('Error starting match:', error);
    res.status(500).json({ error: 'Failed to start match' });
  }
});

// Stop match
router.post('/stop', async (req, res) => {
  try {
    const { matchId } = req.body;

    if (!matchId) {
      return res.status(400).json({ error: 'matchId required' });
    }

    const engine = activeMatches.get(matchId);
    if (engine) {
      engine.stop();
      activeMatches.delete(matchId);
      await removeActiveMatch(matchId);
      logger.info(`⏹️ Match ${matchId} stopped`);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error stopping match:', error);
    res.status(500).json({ error: 'Failed to stop match' });
  }
});

// Get match state
router.get('/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;

    // Try active engine first
    const engine = activeMatches.get(matchId);
    if (engine) {
      return res.json({
        matchId,
        isSimulating: engine.isRunning,
        state: engine.getState(),
      });
    }

    // Try Redis
    const state = await getMatchState(matchId);
    if (state) {
      return res.json({
        matchId,
        isSimulating: false,
        state,
      });
    }

    res.status(404).json({ error: 'Match not found' });
  } catch (error) {
    logger.error('Error getting match state:', error);
    res.status(500).json({ error: 'Failed to get match state' });
  }
});

// Get active matches
router.get('/active/list', (req, res) => {
  const matches = Array.from(activeMatches.keys());
  res.json({ matches, count: matches.length });
});

module.exports = router;
