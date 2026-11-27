import { app } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { pool } from './db/index.js';
import { worker } from './worker/worker.js';

let server;

async function bootstrap() {
  try {
    // 1. Run migrations to ensure database schema and indexes exist
    await runMigrations();

    // 2. Start HTTP server
    server = app.listen(config.port, () => {
      console.log(`=======================================================`);
      console.log(`🚀 Distributed Webhook Dispatcher running on port ${config.port}`);
      console.log(`📡 Ingestion: POST http://localhost:${config.port}/api/webhooks/dispatch`);
      console.log(`🔍 Inspect:   GET  http://localhost:${config.port}/api/webhooks/jobs/:id`);
      console.log(`🎯 Mock:      POST http://localhost:${config.port}/api/mock/receiver`);
      console.log(`💓 Health:    GET  http://localhost:${config.port}/health`);
      console.log(`=======================================================`);
    });

    // 3. Start background delivery worker
    worker.start();
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown handling
let isShuttingDown = false;
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Shutdown] Received ${signal}. Initiating graceful shutdown...`);

  // 1. Stop accepting new HTTP requests
  if (server) {
    server.close(() => {
      console.log('[Shutdown] HTTP server closed.');
    });
  }

  // 2. Stop worker from claiming new jobs and wait for in-flight requests to finish
  console.log('[Shutdown] Draining worker in-flight deliveries...');
  await worker.waitForDrain(10000);
  console.log('[Shutdown] Worker drained.');

  // 3. Close database connection pool
  try {
    await pool.end();
    console.log('[Shutdown] Database pool closed.');
  } catch (err) {
    console.error('[Shutdown] Error closing database pool:', err.message);
  }

  console.log('[Shutdown] Graceful exit complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

bootstrap();
