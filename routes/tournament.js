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

// Active tournament match engines
const activeTournamentMatches = new Map();

// Match interval in minutes between sequential tournament matches
const MATCH_INTERVAL_MINUTES = 10;

// ─── Helper: Calculate scheduled time for match N ─────────────────
function getMatchScheduledTime(tournamentStartsAt, matchIndex) {
  const start = new Date(tournamentStartsAt);
  return new Date(start.getTime() + matchIndex * MATCH_INTERVAL_MINUTES * 60 * 1000);
}

// ─── List tournaments ─────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tournaments')
      .select('*, tournament_participants(count)')
      .order('starts_at', { ascending: false });

    if (error) throw error;
    res.json({ tournaments: data || [] });
  } catch (error) {
    logger.error('Error fetching tournaments:', error);
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

// ─── Get single tournament with participants ──────────────────────

router.get('/:tournamentId', async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const { data: tournament, error } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .single();

    if (error || !tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const { data: participants, error: pError } = await supabase
      .from('tournament_participants')
      .select('*, users:user_id(username, display_name), teams:team_id(team_name)')
      .eq('tournament_id', tournamentId)
      .order('points', { ascending: false });

    if (pError) {
      logger.error(`Failed to fetch participants for ${tournamentId}:`, pError.message);
    }

    const { data: matches } = await supabase
      .from('matches')
      .select('*, home_teams:home_team_id(team_name), away_teams:away_team_id(team_name)')
      .eq('tournament_id', tournamentId)
      .order('created_at')
      .order('id');

    // Enrich matches with scheduled times and match numbers
    const enrichedMatches = (matches || []).map((m, idx) => ({
      ...m,
      match_number: idx + 1,
      scheduled_at: tournament.starts_at
        ? getMatchScheduledTime(tournament.starts_at, idx).toISOString()
        : null,
      home_team_name: m.home_teams?.team_name || 'Home',
      away_team_name: m.away_teams?.team_name || 'Away',
    }));

    res.json({
      tournament,
      participants: participants || [],
      matches: enrichedMatches,
    });
  } catch (error) {
    logger.error('Error fetching tournament:', error);
    res.status(500).json({ error: 'Failed to fetch tournament' });
  }
});

// ─── Get points table ─────────────────────────────────────────────

router.get('/:tournamentId/standings', async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const { data, error } = await supabase
      .from('tournament_participants')
      .select('*, users:user_id(username, display_name), teams:team_id(team_name)')
      .eq('tournament_id', tournamentId)
      .order('points', { ascending: false })
      .order('net_run_rate', { ascending: false });

    if (error) throw error;
    res.json({ standings: data || [] });
  } catch (error) {
    logger.error('Error fetching standings:', error);
    res.status(500).json({ error: 'Failed to fetch standings' });
  }
});

// ─── Join tournament ──────────────────────────────────────────────

router.post('/:tournamentId/join', async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { userId, teamId } = req.body;

    if (!userId || !teamId) {
      return res.status(400).json({ error: 'userId and teamId required' });
    }

    // Get tournament
    const { data: tournament, error: tError } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .single();

    if (tError || !tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    if (tournament.status !== 'open') {
      return res.status(400).json({ error: 'Tournament is not open for registration' });
    }

    if (tournament.current_participants >= tournament.max_participants) {
      return res.status(400).json({ error: 'Tournament is full' });
    }

    // Check if already joined
    const { data: existing } = await supabase
      .from('tournament_participants')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .single();

    if (existing) {
      return res.status(400).json({ error: 'Already joined this tournament' });
    }

    // Check if user is already in an active (open or in_progress) tournament
    const { data: activeTournaments } = await supabase
      .from('tournament_participants')
      .select('tournament_id, tournaments:tournament_id(id, name, status)')
      .eq('user_id', userId);

    const activeEntry = (activeTournaments || []).find(tp => {
      const t = tp.tournaments;
      return t && (t.status === 'open' || t.status === 'in_progress');
    });

    if (activeEntry) {
      const activeName = activeEntry.tournaments?.name || 'another tournament';
      return res.status(400).json({
        error: `You are already in "${activeName}". You can only be in one tournament at a time.`,
      });
    }

    // Deduct entry fee
    if (tournament.entry_fee_coins > 0) {
      const { data: user, error: uError } = await supabase
        .from('users')
        .select('coins')
        .eq('id', userId)
        .single();

      if (uError || !user) {
        return res.status(400).json({ error: 'User not found' });
      }

      if (user.coins < tournament.entry_fee_coins) {
        return res.status(400).json({ error: 'Insufficient coins' });
      }

      await supabase
        .from('users')
        .update({ coins: user.coins - tournament.entry_fee_coins })
        .eq('id', userId);

      await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          type: 'tournament_reward',
          coins_amount: -tournament.entry_fee_coins,
          description: `Entry fee for ${tournament.name}`,
        });
    }

    // Add participant
    const { error: pError } = await supabase
      .from('tournament_participants')
      .insert({
        tournament_id: tournamentId,
        user_id: userId,
        team_id: teamId,
      });

    if (pError) throw pError;

    // Update participant count
    await supabase
      .from('tournaments')
      .update({ current_participants: tournament.current_participants + 1 })
      .eq('id', tournamentId);

    logger.info(`✅ User ${userId} joined tournament ${tournamentId}`);
    res.json({ success: true, message: 'Joined tournament' });
  } catch (error) {
    logger.error('Error joining tournament:', error);
    res.status(500).json({ error: 'Failed to join tournament' });
  }
});

// ─── Create tournament (any user) ─────────────────────────────────

router.post('/create', async (req, res) => {
  try {
    const {
      name,
      description,
      format = 't20',
      maxParticipants = 8,
      entryFeeCoins = 0,
      prizeCoins = 0,
      startsAt,
    } = req.body;

    if (!name || !startsAt) {
      return res.status(400).json({ error: 'name and startsAt required' });
    }

    const { data, error } = await supabase
      .from('tournaments')
      .insert({
        name,
        description,
        format,
        max_participants: maxParticipants,
        entry_fee_coins: entryFeeCoins,
        prize_coins: prizeCoins,
        starts_at: startsAt,
        status: 'open',
      })
      .select()
      .single();

    if (error) throw error;

    logger.info(`🏆 Tournament created: ${data.id} - ${name}`);
    res.json({ success: true, tournament: data });
  } catch (error) {
    logger.error('Error creating tournament:', error);
    res.status(500).json({ error: 'Failed to create tournament' });
  }
});

// ─── Check and start a tournament if ready ────────────────────────

router.post('/:tournamentId/check-start', async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const { data: tournament, error } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .single();

    if (error || !tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    if (tournament.status !== 'open') {
      return res.json({ success: true, status: tournament.status, message: 'Tournament already processed' });
    }

    const now = new Date();
    const startsAt = new Date(tournament.starts_at);

    if (startsAt > now) {
      return res.json({ success: true, status: 'open', message: 'Tournament has not reached start time yet' });
    }

    // Start time has passed — check participants
    if (tournament.current_participants < 2) {
      // Cancel and refund
      if (tournament.entry_fee_coins > 0) {
        const { data: participants } = await supabase
          .from('tournament_participants')
          .select('user_id')
          .eq('tournament_id', tournamentId);

        if (participants) {
          for (const p of participants) {
            const { data: user } = await supabase
              .from('users')
              .select('coins')
              .eq('id', p.user_id)
              .single();

            if (user) {
              await supabase
                .from('users')
                .update({ coins: user.coins + tournament.entry_fee_coins })
                .eq('id', p.user_id);

              await supabase
                .from('transactions')
                .insert({
                  user_id: p.user_id,
                  type: 'tournament_reward',
                  coins_amount: tournament.entry_fee_coins,
                  description: `Refund: ${tournament.name} cancelled (not enough players)`,
                });
            }
          }
        }
      }

      await supabase
        .from('tournaments')
        .update({ status: 'cancelled' })
        .eq('id', tournamentId);

      return res.json({ success: true, status: 'cancelled', message: 'Tournament cancelled — not enough players' });
    }

    // Enough participants — generate matches and start
    const { data: participants, error: pError } = await supabase
      .from('tournament_participants')
      .select('user_id, team_id')
      .eq('tournament_id', tournamentId);

    if (pError) {
      logger.error(`check-start: failed to fetch participants for ${tournamentId}:`, pError.message);
    }

    if (!participants || participants.length < 2) {
      logger.error(`check-start: tournament ${tournamentId} has current_participants=${tournament.current_participants} but query returned ${participants?.length ?? 0} rows`);
      return res.status(400).json({ error: 'No participants found' });
    }

    // Generate round-robin fixtures
    const matches = [];
    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        matches.push({
          home_team_id: participants[i].team_id,
          away_team_id: participants[j].team_id,
          home_user_id: participants[i].user_id,
          away_user_id: participants[j].user_id,
          format: tournament.format,
          status: 'pending',
          tournament_id: tournamentId,
        });
      }
    }

    const { error: insertError } = await supabase
      .from('matches')
      .insert(matches);

    if (insertError) {
      logger.error(`check-start: Failed to generate matches: ${insertError.message} | ${JSON.stringify(insertError)}`);
      return res.status(500).json({ error: `Failed to generate matches: ${insertError.message}` });
    }

    // Update tournament status
    await supabase
      .from('tournaments')
      .update({ status: 'in_progress' })
      .eq('id', tournamentId);

    logger.info(`🏆 Tournament ${tournamentId} started via check-start with ${matches.length} matches`);

    // Matches will be triggered sequentially by the scheduler (every 10 min)
    // First match starts at tournament start time (which is now or past)

    res.json({ success: true, status: 'in_progress', matchCount: matches.length });
  } catch (error) {
    logger.error('Error in check-start:', error);
    res.status(500).json({ error: 'Failed to check/start tournament' });
  }
});

// ─── Generate round-robin matches ─────────────────────────────────

router.post('/:tournamentId/generate-matches', async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const { data: tournament } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .single();

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const { data: participants } = await supabase
      .from('tournament_participants')
      .select('*, teams(team_name)')
      .eq('tournament_id', tournamentId);

    if (!participants || participants.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 participants' });
    }

    // Generate round-robin fixtures
    const matches = [];
    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        matches.push({
          home_team_id: participants[i].team_id,
          away_team_id: participants[j].team_id,
          home_user_id: participants[i].user_id,
          away_user_id: participants[j].user_id,
          format: tournament.format,
          status: 'pending',
          tournament_id: tournamentId,
        });
      }
    }

    const { data: createdMatches, error } = await supabase
      .from('matches')
      .insert(matches)
      .select();

    if (error) throw error;

    // Update tournament status
    await supabase
      .from('tournaments')
      .update({ status: 'in_progress' })
      .eq('id', tournamentId);

    logger.info(`🏆 Generated ${matches.length} matches for tournament ${tournamentId}`);
    res.json({ success: true, matchCount: createdMatches.length, matches: createdMatches });
  } catch (error) {
    logger.error('Error generating matches:', error);
    res.status(500).json({ error: 'Failed to generate matches' });
  }
});

// ─── Run a single tournament match ────────────────────────────────

router.post('/:tournamentId/run-match/:matchId', async (req, res) => {
  try {
    const { tournamentId, matchId } = req.params;

    // Fetch the match
    const { data: match, error: mError } = await supabase
      .from('matches')
      .select('*')
      .eq('id', matchId)
      .eq('tournament_id', tournamentId)
      .single();

    if (mError || !match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (match.status === 'completed') {
      return res.status(400).json({ error: 'Match already completed' });
    }

    if (activeTournamentMatches.has(matchId)) {
      return res.json({ success: true, matchId, alreadyRunning: true });
    }

    // Load team XIs
    const homeXI = await loadTournamentTeamXI(match.home_team_id);
    const awayXI = await loadTournamentTeamXI(match.away_team_id);

    if (!homeXI || !awayXI) {
      return res.status(500).json({ error: 'Failed to load team lineups' });
    }

    const maxOversMap = { t20: 20, odi: 50, t10: 10, test: 90 };
    const maxOvers = maxOversMap[match.format] || 20;

    // Fetch team names
    const { data: homeTeam } = await supabase.from('teams').select('team_name').eq('id', match.home_team_id).single();
    const { data: awayTeam } = await supabase.from('teams').select('team_name').eq('id', match.away_team_id).single();

    const config = {
      homeXI,
      awayXI,
      homeChemistry: 80,
      awayChemistry: 80,
      maxOvers,
      pitchCondition: 'balanced',
      homeTeamName: homeTeam?.team_name || 'Home',
      awayTeamName: awayTeam?.team_name || 'Away',
      homeBatsFirst: Math.random() > 0.5,
      useAICommentary: true,
    };

    const io = req.app.get('io');
    const engine = new TournamentMatchEngine(matchId, config, io, supabase, tournamentId);
    activeTournamentMatches.set(matchId, engine);
    await addActiveMatch(matchId);

    // Update match status
    await supabase
      .from('matches')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', matchId);

    // Start after short delay
    setTimeout(() => {
      engine.start().catch(err => {
        logger.error(`Tournament match ${matchId} error:`, err);
        activeTournamentMatches.delete(matchId);
        removeActiveMatch(matchId);
      });
    }, 500);

    logger.info(`🏆 Tournament match ${matchId} started`);
    res.json({ success: true, matchId });
  } catch (error) {
    logger.error('Error running tournament match:', error);
    res.status(500).json({ error: 'Failed to run match' });
  }
});

// ─── Get active tournament match for a user ───────────────────────

router.get('/user/:userId/active-match', async (req, res) => {
  try {
    const { userId } = req.params;

    // Find user's active tournament participation
    const { data: participations } = await supabase
      .from('tournament_participants')
      .select('tournament_id, team_id, tournaments:tournament_id(id, name, status, starts_at, format)')
      .eq('user_id', userId);

    const activeTournament = (participations || []).find(tp => {
      return tp.tournaments && tp.tournaments.status === 'in_progress';
    });

    if (!activeTournament) {
      return res.json({ activeTournament: null, currentMatch: null, nextMatch: null });
    }

    const tournament = activeTournament.tournaments;
    const tournamentId = tournament.id;

    // Get all matches for this tournament with team names, ordered by created_at
    const { data: allMatches } = await supabase
      .from('matches')
      .select('*, home_teams:home_team_id(team_name), away_teams:away_team_id(team_name)')
      .eq('tournament_id', tournamentId)
      .order('created_at')
      .order('id');

    const matches = (allMatches || []).map((m, idx) => ({
      ...m,
      match_number: idx + 1,
      scheduled_at: tournament.starts_at
        ? getMatchScheduledTime(tournament.starts_at, idx).toISOString()
        : null,
      home_team_name: m.home_teams?.team_name || 'Home',
      away_team_name: m.away_teams?.team_name || 'Away',
    }));

    // Find current in_progress match
    const currentMatch = matches.find(m => m.status === 'in_progress') || null;

    // Find next pending match
    const nextMatch = matches.find(m => m.status === 'pending') || null;

    // If there's a live match, overlay live scores from Redis
    let liveCurrentMatch = currentMatch;
    if (currentMatch) {
      try {
        const liveState = await getMatchState(currentMatch.id);
        if (liveState) {
          const hbf = liveState.homeBatsFirst;
          const homeScore = hbf ? liveState.score1 : liveState.score2;
          const awayScore = hbf ? liveState.score2 : liveState.score1;
          const homeWickets = hbf ? liveState.wickets1 : liveState.wickets2;
          const awayWickets = hbf ? liveState.wickets2 : liveState.wickets1;
          const innings = liveState.innings || 1;
          const overNumber = liveState.overNumber || 0;
          const ballNumber = liveState.ballNumber || 0;
          const homeOvers = hbf
            ? (innings === 1 ? `${overNumber}.${ballNumber}` : (currentMatch.home_overs || '0.0').toString())
            : (innings === 2 ? `${overNumber}.${ballNumber}` : (currentMatch.home_overs || '0.0').toString());
          const awayOvers = !hbf
            ? (innings === 1 ? `${overNumber}.${ballNumber}` : (currentMatch.away_overs || '0.0').toString())
            : (innings === 2 ? `${overNumber}.${ballNumber}` : (currentMatch.away_overs || '0.0').toString());

          liveCurrentMatch = {
            ...currentMatch,
            home_score: homeScore,
            away_score: awayScore,
            home_wickets: homeWickets,
            away_wickets: awayWickets,
            home_overs: homeOvers,
            away_overs: awayOvers,
            live_innings: innings,
          };
        }
      } catch (redisErr) {
        logger.warn(`Failed to fetch live state for match ${currentMatch.id}:`, redisErr.message);
      }
    }

    res.json({
      activeTournament: {
        id: tournament.id,
        name: tournament.name,
        status: tournament.status,
        format: tournament.format,
        starts_at: tournament.starts_at,
      },
      currentMatch: liveCurrentMatch,
      nextMatch,
      matches,
    });
  } catch (error) {
    logger.error('Error fetching active match:', error);
    res.status(500).json({ error: 'Failed to fetch active match' });
  }
});

// ─── Run all pending matches for a tournament ─────────────────────

router.post('/:tournamentId/run-all', async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const { data: matches, error } = await supabase
      .from('matches')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('status', 'pending');

    if (error) throw error;

    if (!matches || matches.length === 0) {
      return res.json({ success: true, message: 'No pending matches', matchCount: 0 });
    }

    // Run matches sequentially with gap
    let scheduledCount = 0;
    for (const m of matches) {
      setTimeout(async () => {
        try {
          const response = await fetch(`http://localhost:${process.env.PORT || 3000}/api/tournament/${tournamentId}/run-match/${m.id}`, {
            method: 'POST',
          });
          if (!response.ok) {
            logger.error(`Failed to start match ${m.id}`);
          }
        } catch (err) {
          logger.error(`Error starting match ${m.id}:`, err);
        }
      }, scheduledCount * 5000); // 5 second gap between matches
      scheduledCount++;
    }

    logger.info(`🏆 Scheduled ${scheduledCount} matches for tournament ${tournamentId}`);
    res.json({ success: true, matchCount: scheduledCount });
  } catch (error) {
    logger.error('Error running all matches:', error);
    res.status(500).json({ error: 'Failed to run matches' });
  }
});

// ─── Tournament Match Engine ──────────────────────────────────────

class TournamentMatchEngine extends MatchEngine {
  constructor(matchId, config, io, supabaseClient, tournamentId) {
    super(matchId, config, io);
    this.supabaseClient = supabaseClient;
    this.tournamentId = tournamentId;
  }

  async loop() {
    if (!this.isRunning || this.matchComplete) {
      await this.onTournamentMatchComplete();
      return;
    }

    try {
      const result = await this.simulateNextBall();

      if (!result) {
        await this.onTournamentMatchComplete();
        return;
      }

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

      // Emit to WebSocket room (for live viewers)
      this.io.to(this.matchId).emit('ballUpdate', {
        matchId: this.matchId,
        result,
        state: this.getState(),
        commentaryLog: this.commentaryLog,
      });

      await setMatchState(this.matchId, this.serialize());

      this.timer = setTimeout(() => this.loop(), 800);
    } catch (error) {
      logger.error(`Tournament match ${this.matchId} error:`, error);
      this.stop();
    }
  }

  async onTournamentMatchComplete() {
    this.matchComplete = true;
    this.isRunning = false;

    const matchResult = this.getMatchResult();
    logger.info(`🏆 Tournament match ${this.matchId} completed: ${matchResult}`);

    // Determine winner
    const homeScore = this.homeBatsFirst ? this.score1 : this.score2;
    const awayScore = this.homeBatsFirst ? this.score2 : this.score1;
    const homeWickets = this.homeBatsFirst ? this.wickets1 : this.wickets2;
    const awayWickets = this.homeBatsFirst ? this.wickets2 : this.wickets1;

    let winnerTeamId = null;
    const { data: matchData } = await this.supabaseClient
      .from('matches')
      .select('home_team_id, away_team_id')
      .eq('id', this.matchId)
      .single();

    if (matchData) {
      if (homeScore > awayScore) {
        winnerTeamId = matchData.home_team_id;
      } else if (awayScore > homeScore) {
        winnerTeamId = matchData.away_team_id;
      }
    }

    // Calculate overs for NRR
    const homeOvers = this.homeBatsFirst
      ? (this.innings >= 2 ? this.maxOvers : this.overNumber + this.ballNumber / 6)
      : (this.innings >= 2 ? this.overNumber + this.ballNumber / 6 : 0);
    const awayOvers = !this.homeBatsFirst
      ? (this.innings >= 2 ? this.maxOvers : this.overNumber + this.ballNumber / 6)
      : (this.innings >= 2 ? this.overNumber + this.ballNumber / 6 : 0);

    // Update match in DB
    try {
      await this.supabaseClient
        .from('matches')
        .update({
          status: 'completed',
          home_score: homeScore,
          home_wickets: homeWickets,
          away_score: awayScore,
          away_wickets: awayWickets,
          home_overs: homeOvers || this.maxOvers,
          away_overs: awayOvers || this.maxOvers,
          winner_team_id: winnerTeamId,
          completed_at: new Date().toISOString(),
        })
        .eq('id', this.matchId);
    } catch (err) {
      logger.error(`Failed to update match ${this.matchId}:`, err);
    }

    // Update tournament standings
    await this.updateStandings(matchData, homeScore, awayScore, homeOvers, awayOvers, winnerTeamId);

    // Emit completion
    this.io.to(this.matchId).emit('matchComplete', {
      matchId: this.matchId,
      result: matchResult,
      state: this.getState(),
    });

    await setMatchState(this.matchId, this.serialize());

    // Cleanup
    activeTournamentMatches.delete(this.matchId);
    await removeActiveMatch(this.matchId);

    // Check if tournament is complete
    await this.checkTournamentComplete();
  }

  async updateStandings(matchData, homeScore, awayScore, homeOvers, awayOvers, winnerTeamId) {
    if (!matchData) return;

    try {
      // Get participants by team_id
      const { data: homePart } = await this.supabaseClient
        .from('tournament_participants')
        .select('*')
        .eq('tournament_id', this.tournamentId)
        .eq('team_id', matchData.home_team_id)
        .single();

      const { data: awayPart } = await this.supabaseClient
        .from('tournament_participants')
        .select('*')
        .eq('tournament_id', this.tournamentId)
        .eq('team_id', matchData.away_team_id)
        .single();

      // Points: Win = 2, Tie = 1, Loss = 0
      const homePoints = winnerTeamId === matchData.home_team_id ? 2 : (winnerTeamId === null ? 1 : 0);
      const awayPoints = winnerTeamId === matchData.away_team_id ? 2 : (winnerTeamId === null ? 1 : 0);

      // NRR calculation: (runs scored / overs faced) - (runs conceded / overs bowled)
      const effectiveHomeOvers = Math.max(homeOvers || this.maxOvers, 1);
      const effectiveAwayOvers = Math.max(awayOvers || this.maxOvers, 1);

      if (homePart) {
        const totalMatchesPlayed = homePart.matches_played + 1;
        const totalWon = homePart.matches_won + (homePoints === 2 ? 1 : 0);
        // Cumulative NRR
        const homeNRR = (homeScore / effectiveHomeOvers) - (awayScore / effectiveAwayOvers);
        const newNRR = ((homePart.net_run_rate * homePart.matches_played) + homeNRR) / totalMatchesPlayed;

        await this.supabaseClient
          .from('tournament_participants')
          .update({
            matches_played: totalMatchesPlayed,
            matches_won: totalWon,
            points: homePart.points + homePoints,
            net_run_rate: Math.round(newNRR * 1000) / 1000,
          })
          .eq('id', homePart.id);
      }

      if (awayPart) {
        const totalMatchesPlayed = awayPart.matches_played + 1;
        const totalWon = awayPart.matches_won + (awayPoints === 2 ? 1 : 0);
        const awayNRR = (awayScore / effectiveAwayOvers) - (homeScore / effectiveHomeOvers);
        const newNRR = ((awayPart.net_run_rate * awayPart.matches_played) + awayNRR) / totalMatchesPlayed;

        await this.supabaseClient
          .from('tournament_participants')
          .update({
            matches_played: totalMatchesPlayed,
            matches_won: totalWon,
            points: awayPart.points + awayPoints,
            net_run_rate: Math.round(newNRR * 1000) / 1000,
          })
          .eq('id', awayPart.id);
      }
    } catch (error) {
      logger.error(`Failed to update standings for tournament ${this.tournamentId}:`, error);
    }
  }

  async checkTournamentComplete() {
    try {
      const { data: pendingMatches } = await this.supabaseClient
        .from('matches')
        .select('id')
        .eq('tournament_id', this.tournamentId)
        .neq('status', 'completed');

      if (!pendingMatches || pendingMatches.length === 0) {
        // All matches done — complete tournament and distribute prizes
        await this.completeTournament();
      }
    } catch (error) {
      logger.error(`Failed to check tournament completion:`, error);
    }
  }

  async completeTournament() {
    try {
      const { data: tournament } = await this.supabaseClient
        .from('tournaments')
        .select('*')
        .eq('id', this.tournamentId)
        .single();

      if (!tournament) return;

      // Get final standings
      const { data: standings } = await this.supabaseClient
        .from('tournament_participants')
        .select('*')
        .eq('tournament_id', this.tournamentId)
        .order('points', { ascending: false })
        .order('net_run_rate', { ascending: false });

      if (!standings || standings.length === 0) return;

      // Distribute prizes (1st: 50%, 2nd: 30%, 3rd: 20%)
      const totalPrize = tournament.prize_coins || 0;
      const prizeDistribution = [
        { position: 1, share: 0.5 },
        { position: 2, share: 0.3 },
        { position: 3, share: 0.2 },
      ];

      for (const prize of prizeDistribution) {
        const participant = standings[prize.position - 1];
        if (!participant) continue;

        const coins = Math.floor(totalPrize * prize.share);
        if (coins <= 0) continue;

        // Award coins
        await this.supabaseClient.rpc('increment_coins', {
          row_id: participant.user_id,
          amount: coins,
        }).catch(async () => {
          // Fallback if RPC doesn't exist
          const { data: user } = await this.supabaseClient
            .from('users')
            .select('coins')
            .eq('id', participant.user_id)
            .single();
          if (user) {
            await this.supabaseClient
              .from('users')
              .update({ coins: user.coins + coins })
              .eq('id', participant.user_id);
          }
        });

        // Record transaction
        await this.supabaseClient
          .from('transactions')
          .insert({
            user_id: participant.user_id,
            type: 'tournament_reward',
            coins_amount: coins,
            description: `${tournament.name} - ${prize.position}${prize.position === 1 ? 'st' : prize.position === 2 ? 'nd' : 'rd'} place`,
          });

        // Update position
        await this.supabaseClient
          .from('tournament_participants')
          .update({ position: prize.position })
          .eq('id', participant.id);
      }

      // Mark tournament as completed
      await this.supabaseClient
        .from('tournaments')
        .update({
          status: 'completed',
          ends_at: new Date().toISOString(),
        })
        .eq('id', this.tournamentId);

      logger.info(`🏆 Tournament ${this.tournamentId} completed! Prizes distributed.`);
    } catch (error) {
      logger.error(`Failed to complete tournament ${this.tournamentId}:`, error);
    }
  }
}

// ─── Helper: Load team XI for tournament ──────────────────────────

async function loadTournamentTeamXI(teamId) {
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
      .sort((a, b) => (a.position || 99) - (b.position || 99));

    if (players.length === 0) {
      logger.error(`No playing XI for team ${teamId}`);
      return null;
    }

    return players.slice(0, 11).map(sp => {
      const uc = sp.user_cards || sp.user_card;
      const pc = uc?.player_cards || uc?.player_card;
      return {
        userCardId: sp.user_card_id || uc?.id,
        name: pc?.player_name || 'Player',
        role: pc?.role || 'batsman',
        batting: pc?.batting || 50,
        bowling: pc?.bowling || 50,
        fielding: pc?.fielding || 50,
      };
    });
  } catch (error) {
    logger.error(`Error loading team ${teamId}:`, error);
    return null;
  }
}

module.exports = router;
