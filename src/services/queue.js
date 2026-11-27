import { query, getClient } from '../db/index.js';
import { config } from '../config.js';

export const queueService = {
  /**
   * Enqueue a new webhook job.
   * Enforces idempotency via UNIQUE (event_id, destination_url).
   * If already exists, returns existing job without creating a duplicate.
   */
  async enqueueJob({ eventId, destinationUrl, destinationHost, payload }) {
    const text = `
      INSERT INTO webhook_jobs (
        event_id, destination_url, destination_host, payload, status, next_attempt_at
      )
      VALUES ($1, $2, $3, $4, 'queued', NOW())
      ON CONFLICT (event_id, destination_url) DO UPDATE
      SET updated_at = webhook_jobs.updated_at
      RETURNING id, event_id, destination_url, status, attempt_count, created_at,
                (xmax = 0) AS is_new;
    `;
    const res = await query(text, [eventId, destinationUrl, destinationHost, JSON.stringify(payload)]);
    return res.rows[0];
  },

  /**
   * Claim up to `limit` jobs that are due using FOR UPDATE SKIP LOCKED
   */
  async claimJobs(limit = config.workerBatchSize) {
    const text = `
      WITH claimable AS (
        SELECT id
        FROM webhook_jobs
        WHERE status IN ('queued', 'retrying')
          AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE webhook_jobs j
      SET status = 'processing',
          locked_at = NOW(),
          updated_at = NOW()
      FROM claimable
      WHERE j.id = claimable.id
      RETURNING j.*;
    `;
    const res = await query(text, [limit]);
    return res.rows;
  },

  /**
   * Reschedule a job without incrementing attempt count (e.g. throttled by rate limiter)
   */
  async rescheduleJob(jobId, delayMs) {
    const text = `
      UPDATE webhook_jobs
      SET status = 'retrying',
          locked_at = NULL,
          next_attempt_at = NOW() + ($2 || ' milliseconds')::INTERVAL,
          updated_at = NOW()
      WHERE id = $1;
    `;
    await query(text, [jobId, delayMs]);
  },

  /**
   * Record attempt outcome and update job status in a single transaction
   */
  async recordAttemptOutcome({
    jobId,
    attemptNumber,
    newStatus,
    responseCode,
    errorMessage,
    durationMs,
    nextAttemptAt = null
  }) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // 1. Insert attempt log
      await client.query(
        `INSERT INTO delivery_attempts (
          job_id, attempt_number, status, response_code, error_message, duration_ms, started_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW());`,
        [jobId, attemptNumber, newStatus, responseCode, errorMessage, durationMs]
      );

      // 2. Update job
      await client.query(
        `UPDATE webhook_jobs
        SET status = $2,
            attempt_count = $3,
            last_error = $4,
            locked_at = NULL,
            next_attempt_at = COALESCE($5, next_attempt_at),
            updated_at = NOW()
        WHERE id = $1;`,
        [jobId, newStatus, attemptNumber, errorMessage, nextAttemptAt]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Crash recovery: reclaim jobs stuck in 'processing' beyond visibility timeout
   */
  async recoverStuckJobs(timeoutSeconds = config.visibilityTimeoutSeconds) {
    const text = `
      UPDATE webhook_jobs
      SET status = 'retrying',
          locked_at = NULL,
          next_attempt_at = NOW(),
          updated_at = NOW()
      WHERE status = 'processing'
        AND locked_at < NOW() - ($1 || ' seconds')::INTERVAL
      RETURNING id, event_id;
    `;
    const res = await query(text, [timeoutSeconds]);
    return res.rows;
  },

  /**
   * Query single job and all of its delivery attempts
   */
  async getJobWithAttempts(jobId) {
    const jobRes = await query('SELECT * FROM webhook_jobs WHERE id = $1', [jobId]);
    if (jobRes.rows.length === 0) return null;

    const attemptsRes = await query(
      'SELECT * FROM delivery_attempts WHERE job_id = $1 ORDER BY attempt_number ASC',
      [jobId]
    );

    const job = jobRes.rows[0];
    return {
      ...job,
      attempts: attemptsRes.rows
    };
  },

  /**
   * List recent jobs with optional status filter
   */
  async listJobs({ status, limit = 50, offset = 0 } = {}) {
    let text = 'SELECT * FROM webhook_jobs';
    const params = [];

    if (status) {
      params.push(status);
      text += ` WHERE status = $${params.length}`;
    }

    params.push(limit);
    text += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    params.push(offset);
    text += ` OFFSET $${params.length}`;

    const res = await query(text, params);
    return res.rows;
  }
};
