import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HostRateLimiter } from '../src/services/rateLimiter.js';

describe('HostRateLimiter (Token Bucket & Concurrency Limiter)', () => {
  test('allows up to capacity tokens initially', () => {
    const limiter = new HostRateLimiter({ capacity: 3, refillRate: 1, maxConcurrent: 10 });
    const host = 'api.example.com';

    assert.equal(limiter.tryAcquire(host).allowed, true);
    assert.equal(limiter.tryAcquire(host).allowed, true);
    assert.equal(limiter.tryAcquire(host).allowed, true);

    // 4th request should be throttled due to token exhaustion
    const fourth = limiter.tryAcquire(host);
    assert.equal(fourth.allowed, false);
    assert.equal(fourth.reason, 'rate_limit');
    assert.ok(fourth.retryAfterMs > 0);
  });

  test('enforces max concurrent requests per host', () => {
    const limiter = new HostRateLimiter({ capacity: 10, refillRate: 5, maxConcurrent: 2 });
    const host = 'partner.io';

    assert.equal(limiter.tryAcquire(host).allowed, true);
    assert.equal(limiter.tryAcquire(host).allowed, true);

    // 3rd concurrent request should be blocked by concurrency limit
    const third = limiter.tryAcquire(host);
    assert.equal(third.allowed, false);
    assert.equal(third.reason, 'concurrency_limit');

    // Releasing a slot allows acquiring again
    limiter.release(host);
    assert.equal(limiter.tryAcquire(host).allowed, true);
  });

  test('refills tokens over time', async () => {
    const limiter = new HostRateLimiter({ capacity: 2, refillRate: 10, maxConcurrent: 10 }); // 10 tokens per sec
    const host = 'quick-refill.com';

    assert.equal(limiter.tryAcquire(host).allowed, true);
    assert.equal(limiter.tryAcquire(host).allowed, true);
    assert.equal(limiter.tryAcquire(host).allowed, false);

    // Wait 250ms -> should refill ~2.5 tokens
    await new Promise(resolve => setTimeout(resolve, 250));

    const retry = limiter.tryAcquire(host);
    assert.equal(retry.allowed, true);
  });

  test('maintains separate limits for different destination hosts', () => {
    const limiter = new HostRateLimiter({ capacity: 1, refillRate: 1, maxConcurrent: 1 });

    assert.equal(limiter.tryAcquire('hostA.com').allowed, true);
    assert.equal(limiter.tryAcquire('hostA.com').allowed, false);

    // hostB should still have its full quota
    assert.equal(limiter.tryAcquire('hostB.com').allowed, true);
  });
});
