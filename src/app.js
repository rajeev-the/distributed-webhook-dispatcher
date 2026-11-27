import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import webhooksRouter from './routes/webhooks.js';
import mockReceiverRouter from './routes/mockReceiver.js';
import healthRouter from './routes/health.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

// Parse JSON bodies with strict 256KB payload limit
app.use(express.json({ limit: '256kb' }));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Request logger for observability
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    // Only log API routes to keep health ping logs clean
    if (!req.path.startsWith('/health') && req.path !== '/') {
      console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    }
  });
  next();
});

// Mount Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
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
