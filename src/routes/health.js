import { Router } from 'express';
import { query } from '../db/index.js';
import { worker } from '../worker/worker.js';

const router = Router();

/**
 * GET /health
 * Liveness and keep-alive ping (ideal for UptimeRobot)
 */
router.get('/', async (req, res) => {
  try {
    const dbRes = await query('SELECT 1 as ok');
    const isDbConnected = dbRes.rows[0]?.ok === 1;

    res.status(200).json({
      status: 'healthy',
      database: isDbConnected ? 'connected' : 'disconnected',
      workerRunning: worker.isRunning,
      activeDeliveries: worker.activeDispatches.size,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
