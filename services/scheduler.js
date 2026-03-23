const cron = require('node-cron');
const logger = require('../utils/logger');

function initScheduler() {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    try {
      // TODO: Fetch scheduled tournaments from Supabase
      // TODO: Start tournaments that are due
      logger.debug('⏰ Scheduler tick');
    } catch (error) {
      logger.error('Scheduler error:', error);
    }
  });

  logger.info('📅 Tournament scheduler initialized');
}

module.exports = { initScheduler };
