import http from 'http';
import { URL } from 'url';

const PORT = parseInt(process.argv[2] || process.env.RECEIVER_PORT || '5000', 10);

// In-memory store for all received webhooks
const receivedLog = [];
const failTracker = new Map();

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // Helper to send JSON
  const sendJson = (statusCode, data, headers = {}) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(data, null, 2));
  };

  // GET / - Info & instructions
  if (req.method === 'GET' && pathname === '/') {
    return sendJson(200, {
      name: 'Independent External Webhook Test Receiver',
      port: PORT,
      endpoints: {
        'POST /webhook': 'Standard receiver (returns 200 OK)',
        'POST /webhook/slow?delay=4000': 'Slow receiver (delays response)',
        'POST /webhook/flaky?failTimes=2': 'Fails with 500 for N times, then succeeds',
        'POST /webhook/rate-limit?retryAfter=3': 'Returns 429 with Retry-After header',
        'POST /webhook/bad-request': 'Returns 400 client error (non-retryable)',
        'GET /received': 'View all received webhooks history',
        'POST /reset': 'Clear received history'
      },
      totalReceivedCount: receivedLog.length
    });
  }

  // GET /received - Query received history
  if (req.method === 'GET' && pathname === '/received') {
    return sendJson(200, {
      total: receivedLog.length,
      webhooks: receivedLog
    });
  }

  // POST /reset - Clear history
  if (req.method === 'POST' && pathname === '/reset') {
    receivedLog.length = 0;
    failTracker.clear();
    console.log('[Test Receiver] History reset.');
    return sendJson(200, { message: 'History cleared' });
  }

  // Handle Webhook POST requests
  if (req.method === 'POST' && pathname.startsWith('/webhook')) {
    // Collect body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyStr = Buffer.concat(chunks).toString('utf-8');
    let body = {};
    try {
      body = bodyStr ? JSON.parse(bodyStr) : {};
    } catch {
      body = { raw: bodyStr };
    }

    const eventId = req.headers['x-webhook-event-id'] || 'unknown';
    const jobId = req.headers['x-webhook-job-id'] || 'unknown';
    const attempt = req.headers['x-webhook-attempt'] || '1';

    const logEntry = {
      receivedAt: new Date().toISOString(),
      path: pathname,
      eventId,
      jobId,
      attempt: parseInt(attempt, 10),
      headers: {
        'x-webhook-event-id': eventId,
        'x-webhook-job-id': jobId,
        'x-webhook-attempt': attempt,
        'user-agent': req.headers['user-agent']
      },
      payload: body
    };

    receivedLog.push(logEntry);

    console.log('----------------------------------------------------');
    console.log(`📥 [Webhook Received] Event: ${eventId} | Attempt: ${attempt}`);
    console.log(`   Job ID: ${jobId}`);
    console.log(`   Path:   ${pathname}`);
    console.log(`   Time:   ${logEntry.receivedAt}`);
    console.log(`   Data:  `, JSON.stringify(body));

    // 1. Slow endpoint: test non-blocking ingestion
    if (pathname === '/webhook/slow') {
      const delay = parseInt(parsedUrl.searchParams.get('delay') || '4000', 10);
      console.log(`   ⏳ Simulating slow processing (${delay}ms)...`);
      await new Promise(r => setTimeout(r, delay));
      console.log(`   ✅ Responding 200 OK after ${delay}ms`);
      return sendJson(200, { status: 'success_slow', delay, eventId, attempt });
    }

    // 2. Flaky endpoint: fails N times with 500, then succeeds on N+1
    if (pathname === '/webhook/flaky') {
      const failTimes = parseInt(parsedUrl.searchParams.get('failTimes') || '2', 10);
      const currentFails = (failTracker.get(eventId) || 0) + 1;
      failTracker.set(eventId, currentFails);

      if (currentFails <= failTimes) {
        console.log(`   💥 Simulating 500 Failure (Fail count ${currentFails} of ${failTimes})`);
        return sendJson(500, {
          error: 'Simulated 500 Internal Error',
          currentFails,
          failTimes,
          eventId,
          attempt
        });
      }

      console.log(`   🎉 Recovered! Responding 200 OK on attempt ${attempt}`);
      failTracker.delete(eventId);
      return sendJson(200, {
        status: 'recovered_successfully',
        successfulAttempt: attempt,
        eventId
      });
    }

    // 3. Rate-limited endpoint: 429
    if (pathname === '/webhook/rate-limit') {
      const retryAfter = parsedUrl.searchParams.get('retryAfter') || '3';
      console.log(`   ⚠️ Responding 429 Rate Limited (Retry-After: ${retryAfter}s)`);
      return sendJson(429, {
        error: 'Too Many Requests',
        retryAfter
      }, { 'Retry-After': retryAfter });
    }

    // 4. Bad request: 400 non-retryable client error
    if (pathname === '/webhook/bad-request') {
      console.log(`   ⛔ Responding 400 Bad Request (Non-retryable)`);
      return sendJson(400, {
        error: 'Bad Request',
        message: 'Invalid payload format for this endpoint.'
      });
    }

    // Default: 200 OK Success
    console.log(`   ✅ Responding 200 OK`);
    return sendJson(200, {
      status: 'success',
      message: 'Webhook received successfully by external server',
      eventId,
      attempt
    });
  }

  // 404
  sendJson(404, { error: 'Not Found' });
});

server.listen(PORT, () => {
  console.log('========================================================');
  console.log(`📡 EXTERNAL TEST RECEIVER SERVER RUNNING ON PORT ${PORT}`);
  console.log(`👉 Webhook URL:    http://localhost:${PORT}/webhook`);
  console.log(`👉 View Received:  http://localhost:${PORT}/received`);
  console.log(`👉 Flaky (Retry):  http://localhost:${PORT}/webhook/flaky?failTimes=2`);
  console.log(`👉 Slow Endpoint:  http://localhost:${PORT}/webhook/slow?delay=3000`);
  console.log('========================================================\n');
});
