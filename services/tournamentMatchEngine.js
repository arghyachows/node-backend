const MatchEngine = require('./matchEngine');
const { setMatchState, removeActiveMatch } = require('./redis');
const logger = require('../utils/logger');

class TournamentMatchEngine extends MatchEngine {
  constructor(matchId, config, io, supabaseClient, tournamentId, initialState = null) {
    super(matchId, config, io, initialState);
    this.supabaseClient = supabaseClient;
    this.tournamentId = tournamentId;
  }

  static fromState(state, io, supabaseClient) {
    const config = {
      homeXI: state.homeXI,
      awayXI: state.awayXI,
      homeChemistry: state.homeChemistry,
      awayChemistry: state.awayChemistry,
      maxOvers: state.maxOvers,
      pitchCondition: state.pitchCondition,
      homeTeamName: state.homeTeamName,
      awayTeamName: state.awayTeamName,
      homeBatsFirst: state.homeBatsFirst,
      useAICommentary: state.useAICommentary,
    };
    return new TournamentMatchEngine(state.matchId, config, io, supabaseClient, state.tournamentId, state);
  }

  serialize() {
    const base = super.serialize();
    return {
      ...base,
      tournamentId: this.tournamentId,
      isTournament: true,
    };
  }

  async loop() {
    if (!this.isRunning || this.matchComplete) {
      try {
        await this.onTournamentMatchComplete();
      } catch (err) {
        logger.error(`onTournamentMatchComplete failed for ${this.matchId}:`, err);
        this.stop();
      }
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

      // Emit to WebSocket room
      this.io.to(this.matchId).emit('ballUpdate', {
        matchId: this.matchId,
        result,
        state: this.getState(),
        commentaryLog: this.commentaryLog,
      });

      try {
        await setMatchState(this.matchId, this.serialize());
      } catch (redisErr) {
        logger.warn(`Redis save failed for match ${this.matchId}: ${redisErr.message}`);
      }

      this.timer = setTimeout(() => this.loop(), 800);
    } catch (error) {
      logger.error(`Tournament match ${this.matchId} error:`, error);
      try {
        await this.onTournamentMatchComplete();
      } catch (completeErr) {
        logger.error(`Failed to complete match ${this.matchId} after error:`, completeErr);
        this.stop();
      }
    }
  }

  async onTournamentMatchComplete() {
    this.matchComplete = true;
    this.isRunning = false;

    const matchResult = this.getMatchResult();
    logger.info(`🏆 Tournament match ${this.matchId} completed: ${matchResult}`);

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

    const homeOvers = this.homeBatsFirst
      ? (this.innings >= 2 ? this.maxOvers : this.overNumber + this.ballNumber / 6)
      : (this.innings >= 2 ? this.overNumber + this.ballNumber / 6 : 0);
    const awayOvers = !this.homeBatsFirst
      ? (this.innings >= 2 ? this.maxOvers : this.overNumber + this.ballNumber / 6)
      : (this.innings >= 2 ? this.overNumber + this.ballNumber / 6 : 0);

    const updateData = {
      status: 'completed',
      home_score: homeScore,
      home_wickets: homeWickets,
      away_score: awayScore,
      away_wickets: awayWickets,
      home_overs: homeOvers || this.maxOvers,
      away_overs: awayOvers || this.maxOvers,
      winner_team_id: winnerTeamId,
      completed_at: new Date().toISOString(),
    };

    let { error: updateErr } = await this.supabaseClient
      .from('matches')
      .update({ ...updateData, commentary_log: this.commentaryLog })
      .eq('id', this.matchId);

    if (updateErr) {
      logger.warn(`Match ${this.matchId} update with commentary failed: ${updateErr.message}, retrying without`);
      await this.supabaseClient.from('matches').update(updateData).eq('id', this.matchId);
    }

    try {
      await this.updateStandings(matchData, homeScore, awayScore, homeOvers, awayOvers, winnerTeamId);
    } catch (standErr) {
      logger.error(`Failed to update standings for match ${this.matchId}:`, standErr);
    }

    this.io.to(this.matchId).emit('matchComplete', {
      matchId: this.matchId,
      result: matchResult,
      state: this.getState(),
      commentaryLog: this.commentaryLog,
    });

    try {
      await setMatchState(this.matchId, this.serialize());
    } catch (redisErr) {
      logger.warn(`Redis final save failed for match ${this.matchId}: ${redisErr.message}`);
    }

    try {
      await removeActiveMatch(this.matchId);
    } catch (cleanErr) {
      logger.warn(`Cleanup failed for match ${this.matchId}: ${cleanErr.message}`);
    }

    try {
      await this.checkTournamentComplete();
    } catch (tournErr) {
      logger.error(`Tournament completion check failed for ${this.tournamentId}:`, tournErr);
    }
  }

  async updateStandings(matchData, homeScore, awayScore, homeOvers, awayOvers, winnerTeamId) {
    if (!matchData) return;

    try {
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

      const homePoints = winnerTeamId === matchData.home_team_id ? 2 : (winnerTeamId === null ? 1 : 0);
      const awayPoints = winnerTeamId === matchData.away_team_id ? 2 : (winnerTeamId === null ? 1 : 0);

      const effectiveHomeOvers = Math.max(homeOvers || this.maxOvers, 1);
      const effectiveAwayOvers = Math.max(awayOvers || this.maxOvers, 1);

      if (homePart) {
        const totalMatchesPlayed = homePart.matches_played + 1;
        const totalWon = homePart.matches_won + (homePoints === 2 ? 1 : 0);
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

      const { data: standings } = await this.supabaseClient
        .from('tournament_participants')
        .select('*')
        .eq('tournament_id', this.tournamentId)
        .order('points', { ascending: false })
        .order('net_run_rate', { ascending: false });

      if (standings && standings.length > 0) {
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

          try {
            await this.supabaseClient.rpc('increment_coins', {
              row_id: participant.user_id,
              amount: coins,
            });
          } catch {
            const { data: user } = await this.supabaseClient.from('users').select('coins').eq('id', participant.user_id).single();
            if (user) await this.supabaseClient.from('users').update({ coins: user.coins + coins }).eq('id', participant.user_id);
          }

          await this.supabaseClient.from('transactions').insert({
            user_id: participant.user_id,
            type: 'tournament_reward',
            coins_amount: coins,
            description: `${tournament.name} - ${prize.position}${prize.position === 1 ? 'st' : prize.position === 2 ? 'nd' : 'rd'} place`,
          });

          await this.supabaseClient.from('tournament_participants').update({ position: prize.position }).eq('id', participant.id);
        }
      }

      await this.supabaseClient.from('tournaments').update({
        status: 'completed',
        ends_at: new Date().toISOString(),
      }).eq('id', this.tournamentId);

      logger.info(`🏆 Tournament ${this.tournamentId} completed!`);
    } catch (error) {
      logger.error(`Failed to complete tournament ${this.tournamentId}:`, error);
    }
  }
}

module.exports = TournamentMatchEngine;
