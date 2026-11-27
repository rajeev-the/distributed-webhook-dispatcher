import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculateBackoffMs, classifyDeliveryOutcome } from '../src/services/dispatcher.js';

describe('Dispatcher Logic (Backoff & Classification)', () => {
  test('calculates exponential backoff correctly', () => {
    // Attempt 1 backoff (for 2nd attempt): 2^1 = 2s +/- 10%
    const b1 = calculateBackoffMs(1);
    assert.ok(b1 >= 1800 && b1 <= 2200, `Expected b1 between 1800-2200ms, got ${b1}`);

    // Attempt 2 backoff (for 3rd attempt): 2^2 = 4s +/- 10%
    const b2 = calculateBackoffMs(2);
    assert.ok(b2 >= 3600 && b2 <= 4400, `Expected b2 between 3600-4400ms, got ${b2}`);

    // Attempt 3 backoff (for 4th attempt): 2^3 = 8s +/- 10%
    const b3 = calculateBackoffMs(3);
    assert.ok(b3 >= 7200 && b3 <= 8800, `Expected b3 between 7200-8800ms, got ${b3}`);
  });

  test('respects Retry-After header if provided', () => {
    const delay = calculateBackoffMs(1, '5');
    assert.equal(delay, 5000);
  });

  test('classifies 2xx status as succeeded', () => {
    assert.equal(classifyDeliveryOutcome(200, null, 1, 4).status, 'succeeded');
    assert.equal(classifyDeliveryOutcome(201, null, 1, 4).status, 'succeeded');
    assert.equal(classifyDeliveryOutcome(204, null, 1, 4).status, 'succeeded');
  });

  test('classifies 4xx (except 429) as permanent failed with no retry', () => {
    const out400 = classifyDeliveryOutcome(400, null, 1, 4);
    assert.equal(out400.status, 'failed');
    assert.equal(out400.retryable, false);

    const out404 = classifyDeliveryOutcome(404, null, 1, 4);
    assert.equal(out404.status, 'failed');
    assert.equal(out404.retryable, false);

    const out422 = classifyDeliveryOutcome(422, null, 1, 4);
    assert.equal(out422.status, 'failed');
    assert.equal(out422.retryable, false);
  });

  test('classifies 5xx and 429 and network errors as retrying when attempts remain', () => {
    // 500
    const out500 = classifyDeliveryOutcome(500, null, 1, 4);
    assert.equal(out500.status, 'retrying');
    assert.equal(out500.retryable, true);

    // 429
    const out429 = classifyDeliveryOutcome(429, null, 2, 4);
    assert.equal(out429.status, 'retrying');
    assert.equal(out429.retryable, true);

    // Network timeout error
    const outNet = classifyDeliveryOutcome(null, new Error('ECONNRESET'), 2, 4);
    assert.equal(outNet.status, 'retrying');
    assert.equal(outNet.retryable, true);
  });

  test('classifies as failed when attempt budget is exhausted', () => {
    const outExhausted = classifyDeliveryOutcome(500, null, 4, 4);
    assert.equal(outExhausted.status, 'failed');
    assert.equal(outExhausted.retryable, false);
  });
});
