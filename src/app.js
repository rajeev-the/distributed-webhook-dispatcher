import express from 'express';
import webhooksRouter from './routes/webhooks.js';
import mockReceiverRouter from './routes/mockReceiver.js';
import healthRouter from './routes/health.js';
import { logger } from './services/logger.js';

export const app = express();

// Parse JSON bodies with strict 256KB payload limit
app.use(express.json({ limit: '256kb' }));

// Ignore favicon
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Request logger for observability
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (
      !req.path.startsWith('/health') &&
      req.path !== '/' &&
      !req.path.startsWith('/api/logs') &&
      req.path !== '/favicon.ico'
    ) {
      logger.addLog('HTTP', `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    }
  });
  next();
});

// Logs API: Query recent logs
app.get('/api/logs', (req, res) => {
  res.json({ logs: logger.getRecentLogs(100) });
});

// Logs Stream: Real-time Server-Sent Events (SSE)
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial history
  const history = logger.getRecentLogs(60);
  for (const item of history) {
    res.write(`data: ${JSON.stringify(item)}\n\n`);
  }

  // Listener for live logs
  const onLog = (item) => {
    res.write(`data: ${JSON.stringify(item)}\n\n`);
  };

  logger.on('log', onLog);
  req.on('close', () => {
    logger.off('log', onLog);
  });
});

// Root: Pure Live Screen Log Stream for Browser, Clean Plain Text for curl
app.get('/', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const baseUrl = `${protocol}://${host}`;
  const userAgent = (req.get('user-agent') || '').toLowerCase();

  // If accessed from curl, return plain text manual
  if (userAgent.startsWith('curl')) {
    const cliManual = `
================================================================================
⚡ DISTRIBUTED WEBHOOK DISPATCHER
================================================================================
PostgreSQL Queue (SKIP LOCKED) • Rate Limited • Exponential Backoff • Durable
Live Host: ${baseUrl}
================================================================================

1. DISPATCH A WEBHOOK (Instant 202 Ingestion):
curl -X POST "${baseUrl}/api/webhooks/dispatch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "eventId": "evt_test_1001",
    "destinationUrl": "${baseUrl}/api/mock/receiver",
    "payload": { "event": "payment.succeeded", "amount": 149.00 }
  }'

2. TEST THE RECEIVER DIRECTLY (HTTP 200 OK):
curl -X POST "${baseUrl}/api/mock/receiver" \\
  -H "Content-Type: application/json" \\
  -d '{ "ping": "pong" }'
================================================================================
`.trimStart();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(cliManual);
  }

  // Pure, clean, full-screen live log stream (ONLY the logs, nothing else)
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Webhook Dispatcher Logs</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: #06090f;
      color: #e2e8f0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      line-height: 1.6;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    #logs {
      padding: 1.25rem 1.5rem;
      height: 100vh;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .log-line {
      margin-bottom: 0.35rem;
    }
    .time { color: #64748b; margin-right: 0.6rem; }
    .cat-Worker { color: #38bdf8; font-weight: 700; margin-right: 0.4rem; }
    .cat-Ingestion { color: #818cf8; font-weight: 700; margin-right: 0.4rem; }
    .cat-Receiver { color: #34d399; font-weight: 700; margin-right: 0.4rem; }
    .cat-HTTP { color: #a78bfa; font-weight: 700; margin-right: 0.4rem; }
    .cat-SYSTEM { color: #fbbf24; font-weight: 700; margin-right: 0.4rem; }
    .level-error { color: #f87171 !important; }
    .level-warn { color: #fbbf24 !important; }
  </style>
</head>
<body>
  <div id="logs"></div>
  <script>
    const container = document.getElementById('logs');
    function appendLog(entry) {
      const line = document.createElement('div');
      line.className = 'log-line ' + (entry.level === 'error' ? 'level-error' : entry.level === 'warn' ? 'level-warn' : '');
      line.innerHTML = '<span class="time">' + entry.timestamp + '</span>' +
        '<span class="cat-' + entry.category + '">[' + entry.category + ']</span> ' +
        escapeHtml(entry.message);
      container.appendChild(line);
      container.scrollTop = container.scrollHeight;
    }
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    const source = new EventSource('/api/logs/stream');
    source.onmessage = (e) => {
      try { appendLog(JSON.parse(e.data)); } catch (err) {}
    };
    source.onerror = () => {
      source.close();
      setInterval(async () => {
        try {
          const res = await fetch('/api/logs');
          const data = await res.json();
          if (data.logs) {
            container.innerHTML = '';
            data.logs.forEach(appendLog);
          }
        } catch (e) {}
      }, 1500);
    };
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
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
