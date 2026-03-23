const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const MatchEngine = require('../services/matchEngine');
const { getMatchState, setMatchState, addActiveMatch, removeActiveMatch } = require('../services/redis');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const activeMatches = new Map();

// Helper function to map player data (from Cloudflare Worker)
function mapPlayer(sp) {
  const uc = sp.user_cards || sp.user_card;
  const pc = uc?.player_cards || uc?.player_card;
  const batting = pc?.batting || 50;
  const bowling = pc?.bowling || 50;
  return {
    userCardId: sp.user_card_id || uc?.id || `player_${Date.now()}_${Math.random()}`,
    name: pc?.player_name || 'Player',
    role: pc?.role || 'batsman',
    batting,
    bowling,
    fielding: pc?.fielding || 50,
  };
}

// Helper function to load team XI (from Cloudflare Worker logic)
async function loadTeamXI(teamId) {
  try {
    const { data, error } = await supabase
      .from('teams')
      .select('*, squads(*, squad_players(*, user_cards(*, player_cards(*))))')
      .eq('id', teamId)
      .single();

    if (error || !data) {
      logger.error(`Failed to fetch team ${teamId}:`, error);
      return null;
    }

    const squads = data.squads || [];
    const squad = squads.find(s => s.is_active) || squads[0];
    
    if (!squad) {
      logger.error(`No squad found for team ${teamId}`);
      return null;
    }

    const players = (squad.squad_players || [])
      .filter(sp => sp.is_playing_xi)
      .sort((a, b) => (a.batting_order || 0) - (b.batting_order || 0));

    if (players.length === 0) {
      logger.error(`No playing XI found for team ${teamId}`);
      return null;
    }

    return players.slice(0, 11).map(sp => mapPlayer(sp));
  } catch (error) {
    logger.error(`Error loading team ${teamId}:`, error);
    return null;
  }
}

// Helper function to load squad XI directly
async function loadSquadXI(squadId) {
  try {
    // Query lineup_players for this squad
    const { data: lineupData, error } = await supabase
      .from('lineup_players')
      .select('*, user_cards(*, player_cards(*))')
      .eq('squad_id', squadId)
      .order('batting_order');

    if (error) {
      logger.error(`Failed to fetch lineup for squad ${squadId}:`, error);
      return null;
    }

    if (!lineupData || lineupData.length === 0) {
      logger.error(`No lineup found for squad ${squadId}`);
      return null;
    }

    return lineupData.slice(0, 11).map(lp => mapPlayer(lp));
  } catch (error) {
    logger.error(`Error loading squad ${squadId}:`, error);
    return null;
  }
}

// Helper function to load user's active squad
async function loadUserActiveSquad(userId) {
  try {
    // Query: users → teams → squads → lineup_players
    const { data: teamData, error: teamError } = await supabase
      .from('teams')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (teamError || !teamData) {
      logger.error(`Failed to fetch active team for user ${userId}:`, teamError);
      return null;
    }

    const { data: squadData, error: squadError } = await supabase
      .from('squads')
      .select('id')
      .eq('team_id', teamData.id)
      .eq('is_active', true)
      .single();

    if (squadError || !squadData) {
      logger.error(`Failed to fetch active squad for team ${teamData.id}:`, squadError);
      return null;
    }

    // Now load lineup for this squad
    return await loadSquadXI(squadData.id);
  } catch (error) {
    logger.error(`Error loading user squad ${userId}:`, error);
    return null;
  }
}

// Custom match engine wrapper for multiplayer that updates Supabase
class MultiplayerMatchEngine extends MatchEngine {
  constructor(matchId, config, io, supabaseClient) {
    super(matchId, config, io);
    this.supabaseClient = supabaseClient;
  }

  async loop() {
    if (!this.isRunning || this.matchComplete) {
      await this.onMatchComplete();
      return;
    }

    try {
      const result = await this.simulateNextBall();
      
      if (!result) {
        await this.onMatchComplete();
        return;
      }

      // Add to commentary log
      this.commentaryLog.push({
        commentary: result.commentary,
        eventType: result.eventType,
        runs: result.runs,
        innings: result.innings,
        overNumber: result.overNumber,
        ballNumber: result.ballNumber,
      });
      if (this.commentaryLog.length > 20) {
        this.commentaryLog.shift();
      }

      // Update Supabase database
      await this.updateSupabaseMatch(result);

      // Emit to WebSocket room
      this.io.to(this.matchId).emit('ballUpdate', {
        matchId: this.matchId,
        result,
        state: this.getState(),
        commentaryLog: this.commentaryLog,
      });

      // Save state to Redis
      await setMatchState(this.matchId, this.serialize());

      // Schedule next ball
      this.timer = setTimeout(() => this.loop(), 1000);
    } catch (error) {
      logger.error(`Match ${this.matchId} simulation error:`, error);
      this.stop();
    }
  }

  async updateSupabaseMatch(result) {
    try {
      const homeScore = this.homeBatsFirst ? this.score1 : this.score2;
      const homeWickets = this.homeBatsFirst ? this.wickets1 : this.wickets2;
      const awayScore = this.homeBatsFirst ? this.score2 : this.score1;
      const awayWickets = this.homeBatsFirst ? this.wickets2 : this.wickets1;
      
      const homeOvers = this.homeBatsFirst && this.innings === 1 ? `${this.overNumber}.${this.ballNumber}` : 
                        !this.homeBatsFirst && this.innings === 2 ? `${this.overNumber}.${this.ballNumber}` : 
                        this.homeBatsFirst ? `${this.maxOvers}.0` : '0.0';
      const awayOvers = !this.homeBatsFirst && this.innings === 1 ? `${this.overNumber}.${this.ballNumber}` : 
                        this.homeBatsFirst && this.innings === 2 ? `${this.overNumber}.${this.ballNumber}` : 
                        !this.homeBatsFirst ? `${this.maxOvers}.0` : '0.0';

      await this.supabaseClient
        .from('multiplayer_matches')
        .update({
          home_score: homeScore,
          home_wickets: homeWickets,
          away_score: awayScore,
          away_wickets: awayWickets,
          current_innings: this.innings,
          home_overs_display: homeOvers,
          away_overs_display: awayOvers,
          current_commentary: result.commentary,
          last_event_type: result.eventType,
          last_runs: result.runs,
          target: this.target,
          scorecard_data: {
            batsmen: this.batsmanStats,
            bowlers: this.bowlerStats,
          },
        })
        .eq('id', this.matchId);
    } catch (error) {
      logger.error(`Failed to update Supabase for match ${this.matchId}:`, error);
    }
  }

  async onMatchComplete() {
    this.matchComplete = true;
    this.isRunning = false;
    
    const matchResult = this.getMatchResult();
    logger.info(`✅ Match ${this.matchId} completed: ${matchResult}`);

    // Determine winner
    let winnerUserId = null;
    const homeScore = this.homeBatsFirst ? this.score1 : this.score2;
    const awayScore = this.homeBatsFirst ? this.score2 : this.score1;
    
    try {
      const { data: matchData } = await this.supabaseClient
        .from('multiplayer_matches')
        .select('home_user_id, away_user_id')
        .eq('id', this.matchId)
        .single();

      if (matchData) {
        if (homeScore > awayScore) {
          winnerUserId = matchData.home_user_id;
        } else if (awayScore > homeScore) {
          winnerUserId = matchData.away_user_id;
        }
      }

      // Update match as completed
      await this.supabaseClient
        .from('multiplayer_matches')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          match_result: matchResult,
          winner_user_id: winnerUserId,
          scorecard_data: {
            batsmen: this.batsmanStats,
            bowlers: this.bowlerStats,
          },
        })
        .eq('id', this.matchId);
    } catch (error) {
      logger.error(`Failed to complete match ${this.matchId} in Supabase:`, error);
    }

    // Emit completion
    this.io.to(this.matchId).emit('matchComplete', {
      matchId: this.matchId,
      result: matchResult,
      state: this.getState(),
    });

    // Save final state
    await setMatchState(this.matchId, this.serialize());
  }
}

router.post('/start', async (req, res) => {
  try {
    const { matchId, config } = req.body;

    if (!matchId || !config) {
      return res.status(400).json({ error: 'matchId and config required' });
    }

    if (activeMatches.has(matchId)) {
      logger.warn(`Match ${matchId} already running`);
      return res.json({ success: true, matchId, alreadyRunning: true });
    }

    logger.info('Multiplayer match start request:', { matchId });

    // Check if XI data is provided directly (like quick match)
    let homeXI = config.homeXI;
    let awayXI = config.awayXI;

    // If XI not provided, fetch from database
    if (!homeXI || !awayXI) {
      const { data: matchData, error: matchError } = await supabase
        .from('multiplayer_matches')
        .select('home_team_id, away_team_id, home_user_id, away_user_id')
        .eq('id', matchId)
        .single();

      if (matchError || !matchData) {
        logger.error('Failed to fetch match:', matchError);
        return res.status(500).json({ error: 'Match not found' });
      }

      // Try multiple approaches to load teams
      homeXI = await loadTeamXI(matchData.home_team_id);
      awayXI = await loadTeamXI(matchData.away_team_id);

      if (!homeXI) {
        logger.info(`Trying home_team_id as squad_id: ${matchData.home_team_id}`);
        homeXI = await loadSquadXI(matchData.home_team_id);
      }
      if (!awayXI) {
        logger.info(`Trying away_team_id as squad_id: ${matchData.away_team_id}`);
        awayXI = await loadSquadXI(matchData.away_team_id);
      }

      if (!homeXI && matchData.home_user_id) {
        logger.info(`Loading home user's active squad: ${matchData.home_user_id}`);
        homeXI = await loadUserActiveSquad(matchData.home_user_id);
      }
      if (!awayXI && matchData.away_user_id) {
        logger.info(`Loading away user's active squad: ${matchData.away_user_id}`);
        awayXI = await loadUserActiveSquad(matchData.away_user_id);
      }
    }

    if (!homeXI || !awayXI) {
      logger.error('Failed to load teams');
      return res.status(500).json({ error: 'Failed to load team lineups' });
    }

    if (homeXI.length < 11 || awayXI.length < 11) {
      logger.error(`Insufficient players: home=${homeXI.length}, away=${awayXI.length}`);
      return res.status(400).json({ error: 'Both teams need 11 players' });
    }

    logger.info(`Teams loaded: ${homeXI.length} vs ${awayXI.length} players`);

    const engineConfig = {
      homeXI,
      awayXI,
      homeChemistry: config.homeChemistry || 80,
      awayChemistry: config.awayChemistry || 80,
      maxOvers: config.maxOvers || config.matchOvers || 20,
      pitchCondition: config.pitchCondition || 'balanced',
      homeTeamName: config.homeTeamName,
      awayTeamName: config.awayTeamName,
      homeBatsFirst: config.homeBatsFirst,
      useAICommentary: config.useAICommentary || false,
    };

    const io = req.app.get('io');
    const engine = new MultiplayerMatchEngine(matchId, engineConfig, io, supabase);
    activeMatches.set(matchId, engine);

    await addActiveMatch(matchId);
    
    setTimeout(() => {
      engine.start().catch(err => {
        logger.error(`Match ${matchId} error:`, err);
        activeMatches.delete(matchId);
        removeActiveMatch(matchId);
      });
    }, 500);

    logger.info(`✅ Multiplayer match ${matchId} started`);
    res.json({ success: true, matchId });
  } catch (error) {
    logger.error('Error starting multiplayer match:', error);
    
    if (activeMatches.has(req.body?.matchId)) {
      activeMatches.delete(req.body.matchId);
      await removeActiveMatch(req.body.matchId).catch(() => {});
    }
    
    res.status(500).json({ error: 'Failed to start match', details: error.message });
  }
});

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
      logger.info(`⏹️ Multiplayer match ${matchId} stopped`);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error stopping match:', error);
    res.status(500).json({ error: 'Failed to stop match' });
  }
});

router.get('/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;

    const engine = activeMatches.get(matchId);
    if (engine) {
      return res.json({
        matchId,
        isSimulating: engine.isRunning,
        state: engine.getState(),
      });
    }

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

router.get('/active/list', (req, res) => {
  const matches = Array.from(activeMatches.keys());
  res.json({ matches, count: matches.length });
});

module.exports = router;
