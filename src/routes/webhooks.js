import { Router } from 'express';
import { z } from 'zod';
import { queueService } from '../services/queue.js';
import { validateDestinationUrl } from '../services/ssrfGuard.js';
import { logger } from '../services/logger.js';

const router = Router();

const dispatchSchema = z.object({
  eventId: z.string().trim().min(1, 'eventId cannot be empty'),
  destinationUrl: z.string().trim().url('destinationUrl must be a valid URL'),
  payload: z.record(z.any(), { required_error: 'payload must be a valid JSON object' })
});

/**
 * POST /api/webhooks/dispatch
 * Non-blocking ingestion: validates, checks idempotency, inserts, returns 202 instantly.
 */
router.post('/dispatch', async (req, res, next) => {
  try {
    const parseResult = dispatchSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
      });
    }

    const { eventId, destinationUrl, payload } = parseResult.data;

    // SSRF & protocol validation
    let validated;
    try {
      validated = await validateDestinationUrl(destinationUrl);
    } catch (ssrfErr) {
      return res.status(400).json({
        error: 'Destination rejected',
        message: ssrfErr.message
      });
    }

    // Insert job into Postgres queue
    const job = await queueService.enqueueJob({
      eventId,
      destinationUrl: validated.url,
      destinationHost: validated.host,
      payload
    });

    // Check idempotency: is_new indicates if row was newly inserted
    if (!job.is_new) {
      logger.addLog('Ingestion', `⚠️ Duplicate event '${eventId}' detected (HTTP 200). Returning existing job ${job.id} (Current status: ${job.status})`, 'warn');
      return res.status(200).json({
        message: 'Duplicate event detected. Existing job returned.',
        jobId: job.id,
        status: job.status,
        eventId: job.event_id,
        destinationUrl: job.destination_url,
        isDuplicate: true
      });
    }

    logger.addLog('Ingestion', `📥 Webhook accepted & queued (HTTP 202): Job ${job.id} | Event: '${eventId}' -> ${validated.url} | Payload: ${JSON.stringify(payload)}`);
    return res.status(202).json({
      message: 'Webhook accepted and queued for delivery',
      jobId: job.id,
      status: job.status,
      eventId: job.event_id,
      destinationUrl: job.destination_url,
      isDuplicate: false
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/webhooks/jobs/:id
 * Retrieve job status and full history of delivery attempts
 */
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const job = await queueService.getJobWithAttempts(id);

    if (!job) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Webhook job '${id}' was not found.`
      });
    }

    logger.addLog('API', `🔍 Job ${id} inspected -> Status: ${job.status} (${job.attempts.length} attempts recorded)`);
    return res.status(200).json(job);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/webhooks/jobs
 * List recent jobs with optional ?status= filter
 */
router.get('/jobs', async (req, res, next) => {
  try {
    const { status, limit, offset } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit || '50', 10), 1), 100);
    const parsedOffset = Math.max(parseInt(offset || '0', 10), 0);

    const jobs = await queueService.listJobs({
      status: status ? String(status).toLowerCase() : undefined,
      limit: parsedLimit,
      offset: parsedOffset
    });

    return res.status(200).json({
      count: jobs.length,
      limit: parsedLimit,
      offset: parsedOffset,
      jobs
    });
  } catch (err) {
    next(err);
  }
});

export default router;
