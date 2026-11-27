import express from 'express';
import webhooksRouter from './routes/webhooks.js';
import mockReceiverRouter from './routes/mockReceiver.js';
import healthRouter from './routes/health.js';

export const app = express();

// Parse JSON bodies with strict 256KB payload limit
app.use(express.json({ limit: '256kb' }));

// Request logger for observability
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/health') && req.path !== '/') {
      console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    }
  });
  next();
});

// Root: Pure Command-Line Terminal Guide
app.get('/', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const baseUrl = `${protocol}://${host}`;

  const cliGuide = `
================================================================================
⚡ DISTRIBUTED WEBHOOK DISPATCHER (CLI INTERFACE)
================================================================================
Architecture : Non-blocking 202 Ingestion • Postgres FOR UPDATE SKIP LOCKED
Semantics    : At-least-once • Exponential Backoff (2s, 4s, 8s) • Token Bucket
Target Host  : ${baseUrl}
================================================================================

[COMMAND 1] DISPATCH WEBHOOK (Instant 202 Ingestion)
--------------------------------------------------------------------------------
curl -X POST "${baseUrl}/api/webhooks/dispatch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "eventId": "evt_'$(date +%s)'",
    "destinationUrl": "${baseUrl}/api/mock/receiver?mode=ok",
    "payload": { "event": "order.completed", "amount": 99.99 }
  }'

[COMMAND 2] VERIFY NON-BLOCKING INGESTION (Downstream delays 4 seconds)
--------------------------------------------------------------------------------
curl -i -X POST "${baseUrl}/api/webhooks/dispatch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "eventId": "evt_slow_1",
    "destinationUrl": "${baseUrl}/api/mock/receiver?mode=slow&delay=4000",
    "payload": { "task": "heavy_processing" }
  }'

[COMMAND 3] TEST EXPONENTIAL RETRIES (Fails 500 twice, succeeds on attempt 3)
--------------------------------------------------------------------------------
curl -X POST "${baseUrl}/api/webhooks/dispatch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "eventId": "evt_flaky_1",
    "destinationUrl": "${baseUrl}/api/mock/receiver?mode=fail500&failTimes=2",
    "payload": { "retryTest": true }
  }'

[COMMAND 4] TEST PERMANENT FAILURE (HTTP 400 Bad Request - No Retries)
--------------------------------------------------------------------------------
curl -X POST "${baseUrl}/api/webhooks/dispatch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "eventId": "evt_bad_1",
    "destinationUrl": "${baseUrl}/api/mock/receiver?mode=client_error",
    "payload": { "invalid": true }
  }'

[COMMAND 5] INSPECT JOB STATUS & DELIVERY ATTEMPT LOG
--------------------------------------------------------------------------------
curl -s "${baseUrl}/api/webhooks/jobs/<JOB_ID>"

[COMMAND 6] LIST RECENT JOBS
--------------------------------------------------------------------------------
curl -s "${baseUrl}/api/webhooks/jobs?limit=10"

[COMMAND 7] HEALTH & KEEP-ALIVE PING
--------------------------------------------------------------------------------
curl -s "${baseUrl}/health"
================================================================================
`.trimStart();

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(cliGuide);
});

// Mount API Routes
app.use('/health', healthRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/mock', mockReceiverRouter);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
    message: 'The requested resource was not found on this server.'
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal Server Error' : err.name || 'Error',
    message: err.message || 'An unexpected error occurred.'
  });
});
