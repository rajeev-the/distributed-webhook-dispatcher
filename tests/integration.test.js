import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { worker } from '../src/worker/worker.js';

let server;
let baseUrl;

describe('Distributed Webhook Dispatcher E2E Integration', () => {
  before(async () => {
    await runMigrations();
    // Start server on ephemeral port for tests
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
    worker.start();
  });

  after(async () => {
    await worker.waitForDrain(3000);
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  });

  test('GET /health returns healthy status', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'healthy');
    assert.equal(res.body.database, 'connected');
  });

  test('POST /api/webhooks/dispatch: validates invalid payloads', async () => {
    const res = await request(app)
      .post('/api/webhooks/dispatch')
      .send({ eventId: '', destinationUrl: 'not-a-url', payload: 'not-object' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Validation failed');
  });

  test('POST /api/webhooks/dispatch: returns 202 instantly (Non-blocking ingestion)', async () => {
    const start = Date.now();
    const eventId = `evt-instant-${Date.now()}`;

    const res = await request(app)
      .post('/api/webhooks/dispatch')
      .send({
        eventId,
        destinationUrl: `${baseUrl}/api/mock/receiver?mode=ok`,
        payload: { event: 'user.created', userId: 'usr_123' }
      });

    const elapsed = Date.now() - start;
    assert.equal(res.status, 202);
    assert.ok(res.body.jobId);
    assert.equal(res.body.status, 'queued');
    // For cloud databases over WAN, roundtrip network latency is ~250-400ms.
    // The key guarantee is that it does not block on the downstream receiver (which could take 5-10s).
    assert.ok(elapsed < 1500, `Dispatch response should be instant (<1500ms over WAN), took ${elapsed}ms`);
  });

  test('Idempotency: duplicate (eventId, destinationUrl) does not create duplicate job', async () => {
    const eventId = `evt-idempotent-${Date.now()}`;
    const destinationUrl = `${baseUrl}/api/mock/receiver?mode=ok`;

    // 1st request -> 202 Accepted
    const res1 = await request(app)
      .post('/api/webhooks/dispatch')
      .send({ eventId, destinationUrl, payload: { step: 1 } });
    assert.equal(res1.status, 202);
    const jobId1 = res1.body.jobId;

    // 2nd request with same (eventId, destinationUrl) -> returns same jobId
    const res2 = await request(app)
      .post('/api/webhooks/dispatch')
      .send({ eventId, destinationUrl, payload: { step: 2 } });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.jobId, jobId1);
    assert.equal(res2.body.isDuplicate, true);
  });

  test('Background delivery: succeeds against mock receiver', async () => {
    const eventId = `evt-delivery-${Date.now()}`;
    const dispatchRes = await request(app)
      .post('/api/webhooks/dispatch')
      .send({
        eventId,
        destinationUrl: `${baseUrl}/api/mock/receiver?mode=ok`,
        payload: { item: 'book', price: 29.99 }
      });

    const jobId = dispatchRes.body.jobId;

    // Poll GET /api/webhooks/jobs/:id until succeeded (or max 5 seconds)
    let finishedJob = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      const res = await request(app).get(`/api/webhooks/jobs/${jobId}`);
      if (res.body.status === 'succeeded') {
        finishedJob = res.body;
        break;
      }
    }

    assert.ok(finishedJob, 'Job should complete with status succeeded');
    assert.equal(finishedJob.status, 'succeeded');
    assert.ok(finishedJob.attempts.length >= 1);
    assert.equal(finishedJob.attempts[0].response_code, 200);
  });

  test('Permanent failure: 400 client error is marked failed with NO retries', async () => {
    const eventId = `evt-client-err-${Date.now()}`;
    const dispatchRes = await request(app)
      .post('/api/webhooks/dispatch')
      .send({
        eventId,
        destinationUrl: `${baseUrl}/api/mock/receiver?mode=client_error`,
        payload: { bad: 'data' }
      });

    const jobId = dispatchRes.body.jobId;

    let finishedJob = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      const res = await request(app).get(`/api/webhooks/jobs/${jobId}`);
      if (res.body.status === 'failed') {
        finishedJob = res.body;
        break;
      }
    }

    assert.ok(finishedJob, 'Job should be permanently failed');
    assert.equal(finishedJob.status, 'failed');
    assert.equal(finishedJob.attempt_count, 1); // Only 1 attempt made, no retries!
    assert.equal(finishedJob.attempts.length, 1);
    assert.equal(finishedJob.attempts[0].response_code, 400);
  });
});
