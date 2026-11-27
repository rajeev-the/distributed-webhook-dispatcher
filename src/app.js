import express from 'express';
import webhooksRouter from './routes/webhooks.js';
import mockReceiverRouter from './routes/mockReceiver.js';
import healthRouter from './routes/health.js';

export const app = express();

// Parse JSON bodies with strict 256KB payload limit
app.use(express.json({ limit: '256kb' }));

// Request logger for terminal observability
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/health') && req.path !== '/') {
      console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    }
  });
  next();
});

// Root: Clean Plain Command-Line Terminal Manual
app.get('/', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const baseUrl = `${protocol}://${host}`;

  const cliManual = `
================================================================================
⚡ DISTRIBUTED WEBHOOK DISPATCHER
================================================================================
PostgreSQL Queue (SKIP LOCKED) • Rate Limited • Exponential Backoff • Durable
Live Host: ${baseUrl}
================================================================================

THE 2 CORE APIS:

1. DISPATCH A WEBHOOK (Instant 202 Ingestion)
--------------------------------------------------------------------------------
curl -X POST "${baseUrl}/api/webhooks/dispatch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "eventId": "evt_'$(date +%s)'",
    "destinationUrl": "${baseUrl}/api/mock/receiver",
    "payload": { "event": "order.completed", "amount": 99.99 }
  }'

2. TEST THE RECEIVER DIRECTLY (HTTP 200 OK)
--------------------------------------------------------------------------------
curl -X POST "${baseUrl}/api/mock/receiver" \\
  -H "Content-Type: application/json" \\
  -d '{ "ping": "pong", "time": "'$(date)'" }'
================================================================================
`.trimStart();

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(cliManual);
});

// Mount the 2 Core API Routers & Health
app.use('/health', healthRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/mock', mockReceiverRouter);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
    message: 'Endpoint not found.'
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
