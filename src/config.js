import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/webhook_dispatcher',
  workerIntervalMs: parseInt(process.env.WORKER_INTERVAL_MS || '500', 10),
  workerBatchSize: parseInt(process.env.WORKER_BATCH_SIZE || '10', 10),
  hostRateLimitCapacity: parseFloat(process.env.HOST_RATE_LIMIT_CAPACITY || '5'),
  hostRateLimitRefillPerSec: parseFloat(process.env.HOST_RATE_LIMIT_REFILL_PER_SEC || '2'),
  hostMaxConcurrent: parseInt(process.env.HOST_MAX_CONCURRENT || '2', 10),
  deliveryTimeoutMs: parseInt(process.env.DELIVERY_TIMEOUT_MS || '5000', 10),
  visibilityTimeoutSeconds: parseInt(process.env.VISIBILITY_TIMEOUT_SECONDS || '30', 10),
  allowInternalTargets: process.env.ALLOW_INTERNAL_TARGETS === 'true' || process.env.NODE_ENV !== 'production',
  nodeEnv: process.env.NODE_ENV || 'development'
};
