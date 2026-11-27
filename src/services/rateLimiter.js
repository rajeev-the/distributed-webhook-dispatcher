import { config } from '../config.js';

/**
 * Per-destination Token Bucket and Concurrency Limiter
 * - Token bucket: smooths traffic rate per destination host
 * - Concurrency cap: bounds simultaneous in-flight requests per host
 */
export class HostRateLimiter {
  constructor(options = {}) {
    this.capacity = options.capacity ?? config.hostRateLimitCapacity; // max tokens
    this.refillRate = options.refillRate ?? config.hostRateLimitRefillPerSec; // tokens/second
    this.maxConcurrent = options.maxConcurrent ?? config.hostMaxConcurrent; // simultaneous in-flight

    // host -> { tokens: number, lastRefill: number, activeCount: number }
    this.hosts = new Map();
  }

  _getState(host) {
    const now = Date.now();
    let state = this.hosts.get(host);
    if (!state) {
      state = {
        tokens: this.capacity,
        lastRefill: now,
        activeCount: 0
      };
      this.hosts.set(host, state);
      return state;
    }

    // Refill tokens according to elapsed time
    const elapsedSeconds = (now - state.lastRefill) / 1000;
    if (elapsedSeconds > 0) {
      state.tokens = Math.min(this.capacity, state.tokens + elapsedSeconds * this.refillRate);
      state.lastRefill = now;
    }

    return state;
  }

  /**
   * Attempts to acquire execution permission for a given host.
   * Does NOT consume attempt count if throttled.
   */
  tryAcquire(host) {
    const state = this._getState(host);

    // 1. Check concurrency limit
    if (state.activeCount >= this.maxConcurrent) {
      return {
        allowed: false,
        reason: 'concurrency_limit',
        retryAfterMs: 500
      };
    }

    // 2. Check token bucket rate limit
    if (state.tokens < 1) {
      const needed = 1 - state.tokens;
      const waitMs = Math.ceil((needed / this.refillRate) * 1000);
      return {
        allowed: false,
        reason: 'rate_limit',
        retryAfterMs: Math.max(waitMs, 200)
      };
    }

    // Consume 1 token and increment active concurrency
    state.tokens -= 1;
    state.activeCount += 1;

    return { allowed: true };
  }

  /**
   * Release active in-flight slot once delivery attempt completes
   */
  release(host) {
    const state = this.hosts.get(host);
    if (state && state.activeCount > 0) {
      state.activeCount -= 1;
    }
  }

  /**
   * Cleanup idle hosts to prevent memory growth
   */
  cleanupIdle(ttlMs = 300000) {
    const now = Date.now();
    for (const [host, state] of this.hosts.entries()) {
      if (state.activeCount === 0 && (now - state.lastRefill) > ttlMs) {
        this.hosts.delete(host);
      }
    }
  }
}

export const rateLimiter = new HostRateLimiter();
