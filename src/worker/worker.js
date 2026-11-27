import { config } from '../config.js';
import { queueService } from '../services/queue.js';
import { rateLimiter } from '../services/rateLimiter.js';
import { deliverWebhook, classifyDeliveryOutcome, calculateBackoffMs } from '../services/dispatcher.js';

export class WebhookWorker {
  constructor() {
    this.isRunning = false;
    this.pollTimer = null;
    this.activeDispatches = new Set();
    this.lastRecoveryCheck = 0;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[Worker] Background delivery worker started.');
    this.scheduleNextPoll(100);
  }

  stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[Worker] Stopped claiming new jobs. Waiting for in-flight deliveries to complete...');
  }

  scheduleNextPoll(delayMs = config.workerIntervalMs) {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => this.tick(), delayMs);
  }

  async tick() {
    if (!this.isRunning) return;

    try {
      // 1. Periodic crash recovery for abandoned jobs (every 10s)
      const now = Date.now();
      if (now - this.lastRecoveryCheck > 10000) {
        this.lastRecoveryCheck = now;
        const recovered = await queueService.recoverStuckJobs(config.visibilityTimeoutSeconds);
        if (recovered.length > 0) {
          console.warn(`[Worker] Visibility timeout: reclaimed ${recovered.length} stuck jobs.`);
        }
      }

      // 2. Claim due jobs with FOR UPDATE SKIP LOCKED
      const jobs = await queueService.claimJobs(config.workerBatchSize);
      if (jobs.length > 0) {
        for (const job of jobs) {
          // Process concurrently within node's event loop
          const dispatchPromise = this.processJob(job);
          this.activeDispatches.add(dispatchPromise);
          dispatchPromise.finally(() => this.activeDispatches.delete(dispatchPromise));
        }
      }
    } catch (err) {
      console.error('[Worker Tick Error]', err.message);
    } finally {
      this.scheduleNextPoll();
    }
  }

  async processJob(job) {
    const host = job.destination_host;

    // Check rate limit and concurrency limit for this host
    const permission = rateLimiter.tryAcquire(host);
    if (!permission.allowed) {
      // Throttled: reschedule job shortly without consuming attempt count
      const delayMs = permission.retryAfterMs || 500;
      await queueService.rescheduleJob(job.id, delayMs);
      return;
    }

    const currentAttempt = job.attempt_count + 1;

    try {
      // Perform webhook HTTP dispatch
      const { responseCode, errorMessage, durationMs, retryAfterHeader } = await deliverWebhook({
        destinationUrl: job.destination_url,
        eventId: job.event_id,
        jobId: job.id,
        attemptNumber: currentAttempt,
        payload: job.payload
      });

      // Classify outcome
      const outcome = classifyDeliveryOutcome(
        responseCode,
        errorMessage ? new Error(errorMessage) : null,
        currentAttempt,
        job.max_attempts
      );

      let nextAttemptAt = null;
      if (outcome.status === 'retrying') {
        const backoffMs = calculateBackoffMs(currentAttempt, retryAfterHeader);
        nextAttemptAt = new Date(Date.now() + backoffMs);
      }

      await queueService.recordAttemptOutcome({
        jobId: job.id,
        attemptNumber: currentAttempt,
        newStatus: outcome.status,
        responseCode,
        errorMessage,
        durationMs,
        nextAttemptAt
      });
    } catch (err) {
      console.error(`[Worker] Unexpected delivery failure for job ${job.id}:`, err);
      // Fallback update if unhandled error occurred
      const outcome = classifyDeliveryOutcome(null, err, currentAttempt, job.max_attempts);
      const nextAttemptAt = outcome.status === 'retrying'
        ? new Date(Date.now() + calculateBackoffMs(currentAttempt))
        : null;

      await queueService.recordAttemptOutcome({
        jobId: job.id,
        attemptNumber: currentAttempt,
        newStatus: outcome.status,
        responseCode: null,
        errorMessage: err.message,
        durationMs: 0,
        nextAttemptAt
      }).catch(e => console.error('[Worker] Failed to record error outcome:', e));
    } finally {
      // Release host concurrency slot
      rateLimiter.release(host);
    }
  }

  /**
   * Await all currently active in-flight dispatches
   */
  async waitForDrain(timeoutMs = 10000) {
    this.stop();
    if (this.activeDispatches.size === 0) return;

    const drainPromise = Promise.allSettled(Array.from(this.activeDispatches));
    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });

    await Promise.race([drainPromise, timeoutPromise]);
    clearTimeout(timer);
  }
}

export const worker = new WebhookWorker();
