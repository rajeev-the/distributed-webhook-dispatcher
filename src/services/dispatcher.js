import { config } from '../config.js';

/**
 * Calculates exponential backoff delay in milliseconds.
 * 
 * Policy:
 * Initial attempt: attempt 1
 * Retries:
 *   Retry 1 (attempt 2): 2^1 = 2 seconds (2000ms)
 *   Retry 2 (attempt 3): 2^2 = 4 seconds (4000ms)
 *   Retry 3 (attempt 4): 2^3 = 8 seconds (8000ms)
 * 
 * Jitter: +/- 10% to prevent thundering herd
 */
export function calculateBackoffMs(attemptNumber, retryAfterHeader = null) {
  // If remote server provided a Retry-After header on 429
  if (retryAfterHeader) {
    const parsedSeconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
      return Math.min(parsedSeconds * 1000, 60000);
    }
  }

  // attemptNumber is the attempt just finished (1, 2, 3...)
  const baseSeconds = Math.pow(2, attemptNumber); // 2, 4, 8...
  const baseMs = baseSeconds * 1000;

  // Add ±10% jitter
  const jitterRange = baseMs * 0.1;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(1000, Math.round(baseMs + jitter));
}

/**
 * Classifies HTTP response / error outcome into delivery status
 * 
 * Rules:
 * - 2xx -> succeeded
 * - 5xx, 429, timeout, network error -> retryable
 * - Other 4xx (400, 401, 403, 404, etc.) -> permanent failed (no retry)
 */
export function classifyDeliveryOutcome(responseCode, error, attemptCount, maxAttempts) {
  // Success
  if (responseCode >= 200 && responseCode < 300) {
    return {
      status: 'succeeded',
      retryable: false,
      reason: 'Delivered successfully'
    };
  }

  // Non-retryable 4xx client errors (excluding 429 Too Many Requests)
  if (responseCode >= 400 && responseCode < 500 && responseCode !== 429) {
    return {
      status: 'failed',
      retryable: false,
      reason: `Client error HTTP ${responseCode}: permanent failure, not retrying.`
    };
  }

  // Transient / Retryable failures:
  // - 5xx server errors
  // - 429 rate limit
  // - network errors (ECONNREFUSED, timeout, etc.)
  const isExhausted = attemptCount >= maxAttempts;
  return {
    status: isExhausted ? 'failed' : 'retrying',
    retryable: !isExhausted,
    reason: isExhausted
      ? `Exhausted all ${maxAttempts} attempts. Final status: ${responseCode || error?.message || 'Network error'}`
      : `Transient failure (${responseCode || error?.code || 'error'}). Rescheduling retry.`
  };
}

/**
 * Delivers webhook payload with timeout and metadata headers
 */
export async function deliverWebhook({ destinationUrl, eventId, jobId, attemptNumber, payload }) {
  const startedAt = Date.now();
  let responseCode = null;
  let errorMessage = null;
  let retryAfterHeader = null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.deliveryTimeoutMs);

  try {
    const response = await fetch(destinationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Distributed-Webhook-Dispatcher/1.0',
        'X-Webhook-Event-Id': eventId,
        'X-Webhook-Job-Id': jobId,
        'X-Webhook-Attempt': String(attemptNumber)
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    responseCode = response.status;
    retryAfterHeader = response.headers.get('retry-after');

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      errorMessage = `HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`;
    }

    return {
      responseCode,
      responseBody: text,
      errorMessage,
      durationMs: Date.now() - startedAt,
      retryAfterHeader
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      errorMessage = `Delivery timed out after ${config.deliveryTimeoutMs}ms`;
    } else {
      errorMessage = err.message || 'Network delivery error';
    }

    return {
      responseCode,
      responseBody: null,
      errorMessage,
      durationMs: Date.now() - startedAt,
      retryAfterHeader
    };
  }
}
