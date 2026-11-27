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
      const msg = `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`;
      logger.addLog('HTTP', msg);
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

  // Send initial backlog
  const backlog = logger.getRecentLogs(50);
  for (const entry of backlog) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  // Listener for live logs
  const onLog = (entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  logger.on('log', onLog);

  req.on('close', () => {
    logger.off('log', onLog);
  });
});

// Root: Terminal Web UI for Browsers, Plain Text for curl
app.get('/', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const baseUrl = `${protocol}://${host}`;
  const userAgent = (req.get('user-agent') || '').toLowerCase();

  // If accessed from curl/terminal, return plain text
  if (userAgent.startsWith('curl')) {
    const cliGuide = `
================================================================================
⚡ DISTRIBUTED WEBHOOK DISPATCHER (CLI MANUAL)
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

[COMMAND 2] TEST EXPONENTIAL RETRIES (Fails 500 twice, recovers on attempt 3)
--------------------------------------------------------------------------------
curl -X POST "${baseUrl}/api/webhooks/dispatch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "eventId": "evt_flaky_1",
    "destinationUrl": "${baseUrl}/api/mock/receiver?mode=fail500&failTimes=2",
    "payload": { "retryTest": true }
  }'

[COMMAND 3] INSPECT JOB STATUS & DELIVERY ATTEMPT LOG
--------------------------------------------------------------------------------
curl -s "${baseUrl}/api/webhooks/jobs/<JOB_ID>"

[COMMAND 4] HEALTH CHECK
--------------------------------------------------------------------------------
curl -s "${baseUrl}/health"
================================================================================
`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(cliGuide);
  }

  // If accessed from a Web Browser, return the Live Streaming Terminal Screen UI!
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Webhook Dispatcher Console</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0e17;
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
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
      background: #111827;
      border: 1px solid #1f2937;
      padding: 1rem 1.5rem;
      border-radius: 12px;
    }
    .title-group {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .badge-icon {
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
    }
    h1 { font-size: 1.2rem; font-weight: 800; color: #fff; }
    p { font-size: 0.8rem; color: #94a3b8; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 0.35rem 0.8rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
    }
    .status-pill::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }

    .action-bar {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
    }
    .btn {
      background: #1e293b;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 0.55rem 0.95rem;
      border-radius: 8px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.15s ease;
    }
    .btn:hover {
      background: #334155;
      border-color: #64748b;
      transform: translateY(-1px);
    }
    .btn.primary {
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      border: none;
    }
    .btn.primary:hover { opacity: 0.92; }

    .terminal-box {
      background: #06090f;
      border: 1px solid #1e293b;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
      display: flex;
      flex-direction: column;
    }
    .terminal-bar {
      background: #0f172a;
      padding: 0.65rem 1rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #1e293b;
    }
    .dots {
      display: flex;
      gap: 6px;
    }
    .dot {
      width: 11px;
      height: 11px;
      border-radius: 50%;
    }
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
      height: 500px;
      overflow-y: auto;
      color: #cbd5e1;
    }
    .log-line {
      margin-bottom: 0.35rem;
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
      <div class="title-group">
        <div class="badge-icon">⚡</div>
        <div>
          <h1>Distributed Webhook Dispatcher</h1>
          <p>Live Real-Time Screen Log Console</p>
        </div>
      </div>
      <div>
        <span class="status-pill" id="liveStatus">LIVE STREAMING ACTIVE</span>
      </div>
    </header>

    <div class="action-bar">
      <button class="btn primary" onclick="sendTestWebhook('ok')">⚡ Trigger Webhook (OK)</button>
      <button class="btn" onclick="sendTestWebhook('fail500')">🔄 Trigger Retry Test (500x2)</button>
      <button class="btn" onclick="sendTestWebhook('slow')">⏳ Trigger Slow Target (4s)</button>
      <button class="btn" onclick="sendTestWebhook('client_error')">❌ Trigger 400 Bad Request</button>
      <button class="btn" style="margin-left: auto;" onclick="clearLogs()">🧹 Clear Screen</button>
    </div>

    <div class="terminal-box">
      <div class="terminal-bar">
        <div class="dots">
          <div class="dot red"></div>
          <div class="dot yellow"></div>
          <div class="dot green"></div>
        </div>
        <div class="terminal-title">dispatcher@render: ~ (real-time stream)</div>
        <div style="font-size:0.75rem; color:#64748b;" id="logCount">0 events</div>
      </div>
      <div class="terminal-screen" id="screen">
        <div class="log-line" style="color:#64748b;">Connecting to live log stream...</div>
      </div>
    </div>
  </div>

  <script>
    const screen = document.getElementById('screen');
    const logCountEl = document.getElementById('logCount');
    let totalLogs = 0;

    function appendLog(entry) {
      const line = document.createElement('div');
      line.className = 'log-line ' + (entry.level === 'error' ? 'level-error' : entry.level === 'warn' ? 'level-warn' : '');

      line.innerHTML = '<span class="time">' + entry.timestamp + '</span>' +
        '<span class="cat-' + entry.category + '">[' + entry.category + ']</span> ' +
        escapeHtml(entry.message);

      screen.appendChild(line);
      screen.scrollTop = screen.scrollHeight;
      totalLogs++;
      logCountEl.textContent = totalLogs + ' events';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function clearLogs() {
      screen.innerHTML = '<div class="log-line" style="color:#64748b;">Screen cleared. Waiting for new logs...</div>';
      totalLogs = 0;
      logCountEl.textContent = '0 events';
    }

    function initSSE() {
      const evtSource = new EventSource('/api/logs/stream');
      screen.innerHTML = '';

      evtSource.onmessage = function(event) {
        try {
          const entry = JSON.parse(event.data);
          appendLog(entry);
        } catch (e) {
          console.error(e);
        }
      };

      evtSource.onerror = function() {
        document.getElementById('liveStatus').textContent = 'POLLING FALLBACK';
        evtSource.close();
        setInterval(async () => {
          try {
            const res = await fetch('/api/logs');
            const data = await res.json();
            if (data.logs && data.logs.length > 0) {
              screen.innerHTML = '';
              data.logs.forEach(appendLog);
            }
          } catch(e) {}
        }, 2000);
      };
    }

    async function sendTestWebhook(mode) {
      const eventId = 'evt_ui_' + Math.floor(Math.random() * 10000);
      let dest = window.location.origin + '/api/mock/receiver?mode=' + mode;
      if (mode === 'fail500') dest += '&failTimes=2';
      if (mode === 'slow') dest += '&delay=4000';

      try {
        await fetch('/api/webhooks/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId,
            destinationUrl: dest,
            payload: { trigger: 'web_ui_click', mode, time: new Date().toISOString() }
          })
        });
      } catch (err) {
        console.error('Dispatch failed', err);
      }
    }

    initSSE();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Mount API Routes
app.use('/health', healthRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/mock', mockReceiverRouter);
