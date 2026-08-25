import { clampStatsDays, USAGE_STATS_MAX_DAYS, USAGE_STATS_MIN_DAYS } from './aggregator.js';

export function registerUsageStatsRoutes(app, { getUsageStatsService }) {
  app.get('/api/token-stats', async (req, res) => {
    try {
      const days = clampStatsDays(req.query.days);
      const stats = await getUsageStatsService.getStats(days);
      res.json(stats);
    } catch (error) {
      console.error('Failed to collect token stats:', error);
      res.status(500).json({
        code: 'TOKEN_STATS_FAILED',
        error: error instanceof Error ? error.message : 'Failed to collect token stats',
      });
    }
  });

  app.get('/api/token-stats/meta', (_req, res) => {
    res.json({ minDays: USAGE_STATS_MIN_DAYS, maxDays: USAGE_STATS_MAX_DAYS });
  });
}
