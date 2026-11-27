import { Router } from 'express';

const router = Router();

// In-memory counter for simulating failures that recover after N attempts
const failCounts = new Map();

/**
 * POST /api/mock/receiver
 * Built-in test receiver to verify non-blocking ingestion and retry semantics.
 * 
 * Query Modes:
 * - ?mode=ok (default): Returns 200 OK
 * - ?mode=fail500&failTimes=2: Returns 500 for the first `failTimes` attempts for a given event, then returns 200
 * - ?mode=429&retryAfter=3: Returns 429 Too Many Requests with Retry-After header
 * - ?mode=slow&delay=3000: Sleeps for `delay` ms before responding 200 OK
 * - ?mode=client_error: Returns 400 Bad Request to test non-retryable failure
 */
router.post('/receiver', async (req, res) => {
  const mode = String(req.query.mode || 'ok').toLowerCase();
  const eventId = req.headers['x-webhook-event-id'] || 'unknown';
  const attempt = req.headers['x-webhook-attempt'] || '1';

  console.log(`[Mock Receiver] Received event=${eventId} attempt=${attempt} mode=${mode}`);

  // 1. Slow response (tests non-blocking ingestion: API returns 202 instantly even if downstream takes 10s)
  if (mode === 'slow') {
    const delay = parseInt(req.query.delay || '3000', 10);
    await new Promise(resolve => setTimeout(resolve, delay));
    return res.status(200).json({
      status: 'received_slow',
      delay,
      eventId,
      attempt
    });
  }

  // 2. 500 Server Error with configurable failTimes before recovering
  if (mode === 'fail500') {
    const failTimes = parseInt(req.query.failTimes || '2', 10);
    const key = `${eventId}-fail500`;
    const count = (failCounts.get(key) || 0) + 1;
    failCounts.set(key, count);

    if (count <= failTimes) {
      return res.status(500).json({
        error: 'Internal Server Error (Simulated)',
        currentFailCount: count,
        totalFailsBeforeSuccess: failTimes,
        eventId,
        attempt
      });
    }

    // Recovered! Clean up map and succeed
    failCounts.delete(key);
    return res.status(200).json({
      status: 'recovered_after_retries',
      totalFailedAttempts: failTimes,
      successfulAttempt: attempt,
      eventId
    });
  }

  // 3. 429 Rate Limited (Too Many Requests)
  if (mode === '429') {
    const retryAfter = req.query.retryAfter || '2';
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      error: 'Too Many Requests (Simulated downstream rate limit)',
      retryAfterSeconds: retryAfter,
      eventId,
      attempt
    });
  }

  // 4. Client error (e.g. 400 Bad Request) - non-retryable permanent failure
  if (mode === 'client_error') {
    return res.status(400).json({
      error: 'Bad Request (Simulated permanent client error)',
      message: 'Destination rejected payload format. Do not retry.',
      eventId,
      attempt
    });
  }

  // Default: 200 OK Success
  return res.status(200).json({
    status: 'delivered',
    receivedAt: new Date().toISOString(),
    eventId,
    attempt,
    payloadEcho: req.body
  });
});

export default router;
