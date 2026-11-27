import { Router } from 'express';
import { logger } from '../services/logger.js';

const router = Router();
const failCounts = new Map();

/**
 * POST /api/mock/receiver
 * Destination receiver endpoint that receives dispatched webhooks.
 */
router.post('/receiver', async (req, res) => {
  const eventId = req.headers['x-webhook-event-id'] || 'unknown';
  const jobId = req.headers['x-webhook-job-id'] || 'unknown';
  const attempt = req.headers['x-webhook-attempt'] || '1';
  const mode = String(req.query.mode || 'ok').toLowerCase();

  logger.addLog('Receiver', `📥 [Destination Hit] Received Webhook! Event: '${eventId}' (Attempt #${attempt})`);
  logger.addLog('Receiver', `📦 Payload: ${JSON.stringify(req.body)}`);

  // Optional simulation mode for retry testing (?mode=fail500&failTimes=2)
  if (mode === 'fail500') {
    const failTimes = parseInt(req.query.failTimes || '2', 10);
    const key = `${eventId}-fail500`;
    const count = (failCounts.get(key) || 0) + 1;
    failCounts.set(key, count);

    if (count <= failTimes) {
      logger.addLog('Receiver', `💥 [Destination Answer] Returned HTTP 500 Server Error (${count}/${failTimes}) for event '${eventId}'`, 'error');
      return res.status(500).json({
        status: 'error',
        message: `Simulated 500 error (${count}/${failTimes})`,
        eventId,
        attempt
      });
    }
    failCounts.delete(key);
  }

  // Slow mode simulation (?mode=slow&delay=3000)
  if (mode === 'slow') {
    const delay = parseInt(req.query.delay || '3000', 10);
    logger.addLog('Receiver', `⏳ [Destination Delay] Sleeping ${delay}ms before responding...`);
    await new Promise(r => setTimeout(r, delay));
  }

  logger.addLog('Receiver', `✅ [Destination Answer] Returned HTTP 200 OK for event '${eventId}'`);
  return res.status(200).json({
    status: 'received',
    message: 'Webhook received successfully by destination server',
    eventId,
    jobId,
    attempt: parseInt(attempt, 10),
    receivedAt: new Date().toISOString(),
    payload: req.body
  });
});

export default router;
