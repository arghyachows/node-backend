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
          const { data: participants } = await supabase
            .from('tournament_participants')
            .select('*, teams(name)')
            .eq('tournament_id', tournament.id);

          if (!participants || participants.length < 2) continue;

          // Generate round-robin fixtures
          const matches = [];
          for (let i = 0; i < participants.length; i++) {
            for (let j = i + 1; j < participants.length; j++) {
              matches.push({
                home_team_id: participants[i].team_id,
                away_team_id: participants[j].team_id,
                match_format: tournament.format,
                status: 'scheduled',
                tournament_id: tournament.id,
              });
            }
          }

          const { error: insertError } = await supabase
            .from('matches')
            .insert(matches);

          if (insertError) {
            logger.error(`Failed to generate matches for tournament ${tournament.id}:`, insertError);
            continue;
          }

          // Update tournament status
          await supabase
            .from('tournaments')
            .update({ status: 'in_progress' })
            .eq('id', tournament.id);

          logger.info(`🏆 Tournament ${tournament.id} started with ${matches.length} matches`);

          // Auto-run matches via internal API call
          const port = process.env.PORT || 3000;
          const { data: scheduledMatches } = await supabase
            .from('matches')
            .select('id')
            .eq('tournament_id', tournament.id)
            .eq('status', 'scheduled');

          if (scheduledMatches) {
            let delay = 0;
            for (const m of scheduledMatches) {
              setTimeout(async () => {
                try {
                  await fetch(`http://localhost:${port}/api/tournament/${tournament.id}/run-match/${m.id}`, {
                    method: 'POST',
                  });
                } catch (err) {
                  logger.error(`Scheduler: failed to start match ${m.id}:`, err.message);
                }
              }, delay);
              delay += 5000; // 5 second gap to avoid overloading
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
