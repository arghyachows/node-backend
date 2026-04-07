const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function initScheduler(app) {
  // Run every minute — check for tournaments that need to start
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date().toISOString();

      // Find tournaments that are open and past their start time
      const { data: tournaments, error } = await supabase
        .from('tournaments')
        .select('*')
        .eq('status', 'open')
        .lte('starts_at', now);

      if (error) {
        logger.error('Scheduler query error:', error);
        return;
      }

      if (!tournaments || tournaments.length === 0) {
        return;
      }

      for (const tournament of tournaments) {
        // Cancel if not enough participants
        if (tournament.current_participants < 2) {
          logger.info(`❌ Cancelling tournament ${tournament.id} — not enough participants (${tournament.current_participants}/${tournament.max_participants})`);

          try {
            // Refund entry fees to all participants
            if (tournament.entry_fee_coins > 0) {
              const { data: participants } = await supabase
                .from('tournament_participants')
                .select('user_id')
                .eq('tournament_id', tournament.id);

              if (participants && participants.length > 0) {
                for (const p of participants) {
                  // Refund coins
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
                logger.info(`💰 Refunded ${participants.length} participant(s) for cancelled tournament ${tournament.id}`);
              }
            }

            // Mark tournament as cancelled
            await supabase
              .from('tournaments')
              .update({ status: 'cancelled' })
              .eq('id', tournament.id);

            logger.info(`✅ Tournament ${tournament.id} cancelled successfully`);
          } catch (cancelErr) {
            logger.error(`Failed to cancel tournament ${tournament.id}:`, cancelErr);
          }
          continue;
        }

        logger.info(`🏆 Auto-starting tournament: ${tournament.name} (${tournament.id})`);

        try {
          // Generate matches
          const { data: participants, error: pError } = await supabase
            .from('tournament_participants')
            .select('user_id, team_id')
            .eq('tournament_id', tournament.id);

          if (pError) {
            logger.error(`Scheduler: failed to fetch participants for ${tournament.id}: ${pError.message}`);
          }

          if (!participants || participants.length < 2) {
            logger.error(`Scheduler: tournament ${tournament.id} has current_participants=${tournament.current_participants} but query returned ${participants?.length ?? 0} rows`);
            continue;
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
                tournament_id: tournament.id,
              });
            }
          }

          const { error: insertError } = await supabase
            .from('matches')
            .insert(matches);

          if (insertError) {
            logger.error(`Failed to generate matches for tournament ${tournament.id}: ${insertError.message} | ${JSON.stringify(insertError)}`);
            continue;
          }

          // Update tournament status
          await supabase
            .from('tournaments')
            .update({ status: 'in_progress' })
            .eq('id', tournament.id);

          logger.info(`🏆 Tournament ${tournament.id} started with ${matches.length} matches`);

          // Auto-run matches directly (no HTTP fetch)
          const { data: pendingMatches } = await supabase
            .from('matches')
            .select('id')
            .eq('tournament_id', tournament.id)
            .eq('status', 'pending');

          if (pendingMatches && pendingMatches.length > 0) {
            const port = process.env.PORT || 3000;
            let delay = 0;
            for (const m of pendingMatches) {
              setTimeout(async () => {
                try {
                  const url = `http://localhost:${port}/api/tournament/${tournament.id}/run-match/${m.id}`;
                  const resp = await fetch(url, { method: 'POST' });
                  if (!resp.ok) {
                    const body = await resp.text();
                    logger.error(`Scheduler: match ${m.id} start failed: ${body}`);
                  }
                } catch (err) {
                  logger.error(`Scheduler: failed to start match ${m.id}:`, err.message);
                }
              }, delay);
              delay += 5000;
            }
          }
        } catch (err) {
          logger.error(`Scheduler tournament ${tournament.id} error:`, err);
        }
      }
    } catch (error) {
      logger.error('Scheduler error:', error);
    }
  });

  // Recovery: finalize in_progress tournaments where all matches are completed
  // (handles server restarts that killed in-memory match engines)
  cron.schedule('* * * * *', async () => {
    try {
      const { data: liveTournaments } = await supabase
        .from('tournaments')
        .select('id, name, prize_coins')
        .eq('status', 'in_progress');

      if (!liveTournaments || liveTournaments.length === 0) return;

      for (const tournament of liveTournaments) {
        const { data: incompleteMatches } = await supabase
          .from('matches')
          .select('id')
          .eq('tournament_id', tournament.id)
          .neq('status', 'completed');

        if (incompleteMatches && incompleteMatches.length === 0) {
          // All matches done — finalize tournament
          logger.info(`🔄 Recovery: Finalizing tournament ${tournament.name} (${tournament.id})`);

          // Get standings
          const { data: standings } = await supabase
            .from('tournament_participants')
            .select('*')
            .eq('tournament_id', tournament.id)
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
              if (!participant || totalPrize <= 0) continue;

              const coins = Math.floor(totalPrize * prize.share);
              if (coins <= 0) continue;

              const { data: user } = await supabase
                .from('users')
                .select('coins')
                .eq('id', participant.user_id)
                .single();
              if (user) {
                await supabase
                  .from('users')
                  .update({ coins: user.coins + coins })
                  .eq('id', participant.user_id);
              }

              await supabase
                .from('transactions')
                .insert({
                  user_id: participant.user_id,
                  type: 'tournament_reward',
                  coins_amount: coins,
                  description: `${tournament.name} - ${prize.position}${prize.position === 1 ? 'st' : prize.position === 2 ? 'nd' : 'rd'} place`,
                }).catch(() => {});

              await supabase
                .from('tournament_participants')
                .update({ position: prize.position })
                .eq('id', participant.id);
            }
          }

          await supabase
            .from('tournaments')
            .update({ status: 'completed', ends_at: new Date().toISOString() })
            .eq('id', tournament.id);

          logger.info(`✅ Recovery: Tournament ${tournament.name} completed with prizes distributed`);
        } else if (incompleteMatches && incompleteMatches.length > 0) {
          // Check if matches are stuck (in_progress but no active engine running)
          const { data: stuckMatches } = await supabase
            .from('matches')
            .select('id')
            .eq('tournament_id', tournament.id)
            .eq('status', 'in_progress');

          // Re-trigger stuck matches via run-all endpoint
          if (stuckMatches && stuckMatches.length > 0) {
            // Reset stuck in_progress matches to pending
            for (const m of stuckMatches) {
              await supabase
                .from('matches')
                .update({ status: 'pending', home_score: 0, away_score: 0, home_wickets: 0, away_wickets: 0 })
                .eq('id', m.id);
            }

            // Trigger pending matches
            const port = process.env.PORT || 3000;
            try {
              await fetch(`http://localhost:${port}/api/tournament/${tournament.id}/run-all`, { method: 'POST' });
              logger.info(`🔄 Recovery: Re-triggered ${stuckMatches.length} stuck matches for tournament ${tournament.name}`);
            } catch (err) {
              logger.error(`Recovery: Failed to re-trigger matches for ${tournament.id}:`, err.message);
            }
          }
        }
      }
    } catch (error) {
      logger.error('Tournament recovery error:', error);
    }
  });

  // Create a recurring weekend tournament every Friday
  cron.schedule('0 0 * * 5', async () => {
    try {
      const startDate = new Date();
      startDate.setHours(startDate.getHours() + 24); // Start Saturday

      const { data, error } = await supabase
        .from('tournaments')
        .insert({
          name: `Weekend League - ${startDate.toLocaleDateString()}`,
          description: 'Weekly round-robin tournament. Top 3 win prizes!',
          format: 't20',
          max_participants: 8,
          entry_fee_coins: 500,
          prize_coins: 5000,
          starts_at: startDate.toISOString(),
          status: 'open',
        })
        .select()
        .single();

      if (!error && data) {
        logger.info(`🏆 Weekend tournament created: ${data.id}`);
      }
    } catch (error) {
      logger.error('Failed to create weekend tournament:', error);
    }
  });

  logger.info('📅 Tournament scheduler initialized');
}

module.exports = { initScheduler };
