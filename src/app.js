import express from 'express';
import webhooksRouter from './routes/webhooks.js';
import mockReceiverRouter from './routes/mockReceiver.js';
import healthRouter from './routes/health.js';
import { logger } from './services/logger.js';

export const app = express();

// Parse JSON bodies with strict 256KB payload limit
app.use(express.json({ limit: '256kb' }));

// Request logger for observability
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/health') && req.path !== '/' && !req.path.startsWith('/api/logs')) {
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
  const history = logger.getRecentLogs(50);
  for (const item of history) {
    res.write(`data: ${JSON.stringify(item)}\n\n`);
  }

  // Listener for new logs
  const onLog = (item) => {
    res.write(`data: ${JSON.stringify(item)}\n\n`);
  };

  logger.on('log', onLog);
  req.on('close', () => {
    logger.off('log', onLog);
  });
});

// Root: Terminal Web UI with Live Log Stream for Browsers, Plain Text for curl
app.get('/', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const baseUrl = `${protocol}://${host}`;
  const userAgent = (req.get('user-agent') || '').toLowerCase();

  // If accessed from curl/terminal, return plain text
  if (userAgent.startsWith('curl')) {
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
    "eventId": "evt_test_101",
    "destinationUrl": "${baseUrl}/api/mock/receiver",
    "payload": { "event": "payment.succeeded", "amount": 149.00 }
  }'

2. TEST THE RECEIVER DIRECTLY (HTTP 200 OK)
--------------------------------------------------------------------------------
curl -X POST "${baseUrl}/api/mock/receiver" \\
  -H "Content-Type: application/json" \\
  -d '{ "ping": "pong" }'
================================================================================
`.trimStart();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(cliManual);
  }

  // For Web Browsers: Render clean Live Terminal UI showing the live streaming log screen!
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Webhook Dispatcher Console</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #090d16;
      color: #e2e8f0;
      font-family: 'Plus Jakarta Sans', sans-serif;
      padding: 1.5rem;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .wrapper {
      width: 100%;
      max-width: 1100px;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    /* Header Card */
    header {
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 12px;
      padding: 1.25rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .brand-icon {
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      width: 42px;
      height: 42px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
    }
    h1 { font-size: 1.25rem; font-weight: 800; color: #fff; }
    p { font-size: 0.8rem; color: #94a3b8; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
    }
    .badge::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }

    /* Command info box */
    .cmd-box {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 1rem 1.25rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
    }
    .cmd-title {
      color: #38bdf8;
      font-weight: 700;
      margin-bottom: 0.4rem;
    }
    .cmd-text {
      color: #94a3b8;
      background: #06090f;
      padding: 0.6rem 0.8rem;
      border-radius: 6px;
      word-break: break-all;
    }

    /* Actions */
    .action-row {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .btn {
      background: #1e293b;
      border: 1px solid #334155;
      color: #fff;
      padding: 0.6rem 1rem;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn:hover {
      background: #334155;
      transform: translateY(-1px);
    }
    .btn.primary {
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      border: none;
    }

    /* Terminal Console */
    .terminal-container {
      background: #06090f;
      border: 1px solid #1e293b;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    }
    .terminal-header {
      background: #0f172a;
      padding: 0.7rem 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #1e293b;
    }
    .dots { display: flex; gap: 6px; }
    .dot { width: 11px; height: 11px; border-radius: 50%; }
    .dot.red { background: #ef4444; }
    .dot.yellow { background: #f59e0b; }
    .dot.green { background: #10b981; }
    .terminal-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: #94a3b8;
    }

    .terminal-screen {
      padding: 1.25rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.82rem;
      line-height: 1.6;
      height: 480px;
      overflow-y: auto;
      color: #cbd5e1;
    }
    .log-line {
      margin-bottom: 0.4rem;
      word-break: break-all;
    }
    .time { color: #64748b; margin-right: 0.5rem; }
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
  <div class="wrapper">
    <header>
      <div class="brand">
        <div class="brand-icon">⚡</div>
        <div>
          <h1>Distributed Webhook Dispatcher</h1>
          <p>Real-Time Screen Log Console (Postgres Queue & Worker)</p>
        </div>
      </div>
      <div>
        <span class="badge" id="liveBadge">LIVE LOG STREAM ACTIVE</span>
      </div>
    </header>

    <div class="cmd-box">
      <div class="cmd-title">👉 Run this command in your terminal to dispatch a webhook:</div>
      <div class="cmd-text">curl -X POST "${baseUrl}/api/webhooks/dispatch" -H "Content-Type: application/json" -d '{"eventId": "evt_test_'$(date +%s)'", "destinationUrl": "${baseUrl}/api/mock/receiver", "payload": {"event": "payment.succeeded", "amount": 149.00}}'</div>
    </div>

    <div class="action-row">
      <button class="btn primary" onclick="sendTestWebhook()">⚡ Click Here to Trigger Test Webhook</button>
      <button class="btn" style="margin-left: auto;" onclick="clearLogs()">🧹 Clear Log Screen</button>
    </div>

    <div class="terminal-container">
      <div class="terminal-header">
        <div class="dots">
          <div class="dot red"></div>
          <div class="dot yellow"></div>
          <div class="dot green"></div>
        </div>
        <div class="terminal-title">dispatcher@render: ~ (real-time live stream)</div>
        <div style="font-size: 0.75rem; color: #64748b;" id="logCount">0 logs</div>
      </div>
      <div class="terminal-screen" id="screen">
        <div class="log-line" style="color:#64748b;">Connecting to live log stream...</div>
      </div>
    </div>
  </div>

  <script>
    const screen = document.getElementById('screen');
    const logCount = document.getElementById('logCount');
    let count = 0;

    function appendLog(entry) {
      const line = document.createElement('div');
      line.className = 'log-line ' + (entry.level === 'error' ? 'level-error' : entry.level === 'warn' ? 'level-warn' : '');
      line.innerHTML = '<span class="time">' + entry.timestamp + '</span>' +
        '<span class="cat-' + entry.category + '">[' + entry.category + ']</span> ' +
        escapeHtml(entry.message);

      screen.appendChild(line);
      screen.scrollTop = screen.scrollHeight;
      count++;
      logCount.textContent = count + ' logs';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function clearLogs() {
      screen.innerHTML = '<div class="log-line" style="color:#64748b;">Screen cleared. Waiting for new logs...</div>';
      count = 0;
      logCount.textContent = '0 logs';
    }

    // Connect to SSE stream
    function initSSE() {
      const source = new EventSource('/api/logs/stream');
      screen.innerHTML = '';

      source.onmessage = function(e) {
        try {
          const entry = JSON.parse(e.data);
          appendLog(entry);
        } catch (err) {}
      };

      source.onerror = function() {
        document.getElementById('liveBadge').textContent = 'POLLING ACTIVE';
        source.close();
        // Fallback polling
        setInterval(async () => {
          try {
            const res = await fetch('/api/logs');
            const data = await res.json();
            if (data.logs) {
              screen.innerHTML = '';
              data.logs.forEach(appendLog);
            }
          } catch (e) {}
        }, 1500);
      };
    }

    async function sendTestWebhook() {
      const eventId = 'evt_click_' + Math.floor(Math.random() * 100000);
      try {
        await fetch('/api/webhooks/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId,
            destinationUrl: window.location.origin + '/api/mock/receiver',
            payload: { trigger: 'button_click', event: 'order.placed', amount: 89.50 }
          })
        });
      } catch (err) {
        console.error('Failed to trigger webhook', err);
      }
    }

    initSSE();
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
