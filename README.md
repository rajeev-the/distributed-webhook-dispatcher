# Distributed Webhook Dispatcher

A robust, production-ready, distributed webhook delivery system built with **Node.js**, **Express**, and **PostgreSQL**.

The dispatcher implements asynchronous non-blocking ingestion (immediate `202 Accepted`), durable transactional queuing via PostgreSQL `FOR UPDATE SKIP LOCKED`, per-destination rate limiting and concurrency throttling, exponential backoff retries with jitter, crash-recovery visibility timeouts, and comprehensive observability.

---

## 🚀 Quickstart (60 Seconds)

### 1. Prerequisites
- **Node.js** (v18+ or v20+)
- **PostgreSQL** (Local instance, or free cloud Postgres from [Neon](https://neon.tech) / [Supabase](https://supabase.com))

### 2. Setup & Installation
```bash
# Clone and enter directory
cd assignemnet_2

# Install dependencies
npm install

# Configure environment (defaults connect to postgresql://localhost:5432/webhook_dispatcher)
cp .env.example .env

# Run database migrations
npm run migrate
```

### 3. Start the Dispatcher & Worker
```bash
npm start
```

### 4. Run Automated Tests
```bash
npm test
```

### 5. Run Live End-to-End Curl Demo
In a separate terminal while the server is running:
```bash
npm run demo
```

---

## 🏛️ Architecture & System Design

```
                     ┌───────────────────────────────────────────────┐
                     │          Distributed Webhook Dispatcher       │
                     │                                               │
Internal Service ────┼──POST /api/webhooks/dispatch──┐               │
                     │                               ▼               │
                     │                    [Input Validation / Zod]   │
                     │                    [SSRF Guard / Host check]  │
                     │                               │               │
                     │                               ▼               │
                     │   ┌─────────────────────────────────────────┐ │
                     │   │     PostgreSQL Queue (webhook_jobs)     │ │
                     │   │   - Idempotency UNIQUE(event, dest)     │ │
                     │   │   - Index on (status, next_attempt_at)  │ │
                     │   └─────────────────────────────────────────┘ │
                     │                               │               │
Caller ◄──202 (instant)──────────────────────────────┘               │
                                                     │               │
                                                     ▼               │
                                        [FOR UPDATE SKIP LOCKED]     │
                                                     │               │
                                                     ▼               │
                                  ┌────────────────────────────────┐ │
                                  │   In-Process Modular Worker    │ │
                                  │   (Visibility Timeout Recovery)│ │
                                  └────────────────────────────────┘ │
                                                     │               │
                          ┌──────────────────────────┴───────────────┴───────────────┐
                          │ Destination Host Rate Limiter & Concurrency Semaphore    │
                          │   - Token Bucket: capacity=5, refill=2 tokens/s          │
                          │   - Host Concurrency: max 2 in-flight simultaneously    │
                          └──────────────────────────┬───────────────────────────────┘
                                                     │
                                                     ▼
                                          [HTTP POST Delivery]
                                          (5000ms strict timeout)
                                                     │
                           ┌─────────────────────────┴─────────────────────────┐
                           ▼                                                   ▼
                [Transient 5xx / 429 / Net]                         [Success 2xx / 4xx Fail]
                           │                                                   │
                           ▼                                                   ▼
                Exponential Backoff (2s, 4s, 8s)                       Terminal Outcome
                           │                                                   │
                           └─────────────────────────┬─────────────────────────┘
                                                     │
                                                     ▼
                                     ┌───────────────────────────────┐
                                     │ delivery_attempts Table       │
                                     │ (duration_ms, response_code)  │
                                     └───────────────────────────────┘
```

---

## 🔑 Key Engineering Decisions

### 1. PostgreSQL as the Queue (`FOR UPDATE SKIP LOCKED`)
- **Single Dependency**: Eliminates the operational overhead of running Redis/RabbitMQ/Kafka alongside a relational DB.
- **ACID Consistency**: The webhook job status, attempt logs, and queue state live in the same transactionally safe store.
- **Fair Concurrent Claiming**: `FOR UPDATE SKIP LOCKED` allows multiple concurrent worker processes to pick jobs without lock contention or race conditions.

### 2. In-Process Worker Architecture (`src/worker/`)
- On free-tier cloud platforms (e.g., Render Web Services), separate background worker containers are not supported on the free tier.
- The worker is implemented as a clean, decoupled module in `src/worker/worker.js`.
- **Zero-Refactor Extraction**: To run the worker as a separate microservice, simply point a new entry point (`worker-service.js`) at `worker.start()` without changing a line of business logic.

### 3. Delivery Guarantees & Idempotency
- **Guarantee**: **At-least-once delivery**. If a worker crashes mid-HTTP delivery, the visibility timeout reclaims the job for another attempt.
- **Idempotency**: Webhook requests pass headers:
  - `X-Webhook-Event-Id`: The upstream event ID for receiver deduplication.
  - `X-Webhook-Job-Id`: The dispatcher's internal tracking UUID.
  - `X-Webhook-Attempt`: Monotonically increasing attempt counter.
- **Producer Deduplication**: A unique constraint on `(event_id, destination_url)` ensures duplicate dispatch calls return the existing `jobId` without duplicating delivery.

### 4. Retry Semantics & Backoff Schedule

| Failure Class | Status Codes | Action | Backoff Delay |
| :--- | :--- | :--- | :--- |
| **Success** | `200 - 299` | Marked `succeeded` | None |
| **Client Error** | `400, 401, 403, 404, 422` (except 429) | Marked `failed` permanently | **No retry** (malformed payloads won't fix themselves) |
| **Server Error** | `500, 502, 503, 504` | Marked `retrying` | `2^n` seconds ($2s \to 4s \to 8s$) + 10% jitter |
| **Downstream Rate Limit** | `429` | Marked `retrying` | Honors `Retry-After` header if present, else backoff |
| **Network / Timeout** | `ECONNRESET`, `ETIMEDOUT`, socket abort | Marked `retrying` | Exponential backoff |
| **Budget Exhaustion** | 4 total attempts exhausted | Marked `failed` (Dead-letter state) | None |

---

## 📡 API Reference

### 1. Ingest Webhook (Non-Blocking)
```http
POST /api/webhooks/dispatch
Content-Type: application/json
```
```json
{
  "eventId": "evt_order_created_9876",
  "destinationUrl": "http://localhost:3000/api/mock/receiver?mode=ok",
  "payload": {
    "orderId": "ord_9876",
    "customer": "alex@example.com",
    "amount": 149.50
  }
}
```
**Response (Instant 202 Accepted):**
```json
{
  "message": "Webhook accepted and queued for delivery",
  "jobId": "a7c9c441-f963-4264-8def-fdbaba546e08",
  "status": "queued",
  "eventId": "evt_order_created_9876",
  "destinationUrl": "http://localhost:3000/api/mock/receiver?mode=ok",
  "isDuplicate": false
}
```

---

### 2. Inspect Job & Delivery Attempts
```http
GET /api/webhooks/jobs/:id
```
**Response (200 OK):**
```json
{
  "id": "a7c9c441-f963-4264-8def-fdbaba546e08",
  "event_id": "evt_order_created_9876",
  "destination_url": "http://localhost:3000/api/mock/receiver?mode=ok",
  "destination_host": "localhost",
  "status": "succeeded",
  "attempt_count": 1,
  "max_attempts": 4,
  "created_at": "2026-11-27T09:28:52.436Z",
  "attempts": [
    {
      "id": "f55cb696-613d-4c31-8977-cf684bb64aa1",
      "attempt_number": 1,
      "status": "succeeded",
      "response_code": 200,
      "error_message": null,
      "duration_ms": 12,
      "started_at": "2026-11-27T09:28:52.500Z"
    }
  ]
}
```

---

### 3. Built-in Controllable Mock Receiver
The server includes `/api/mock/receiver` to test real worker behavior:
* `POST /api/mock/receiver?mode=ok` -> returns `200 OK`.
* `POST /api/mock/receiver?mode=slow&delay=4000` -> delays response by 4 seconds (proves non-blocking ingestion).
* `POST /api/mock/receiver?mode=fail500&failTimes=2` -> returns `500` for the first 2 attempts, then succeeds on attempt 3.
* `POST /api/mock/receiver?mode=429&retryAfter=2` -> returns `429 Too Many Requests` with `Retry-After: 2`.
* `POST /api/mock/receiver?mode=client_error` -> returns `400 Bad Request` to demonstrate immediate permanent failure.

---

### 4. Health Check (Keep-Alive Ping)
```http
GET /health
```
```json
{
  "status": "healthy",
  "database": "connected",
  "workerRunning": true,
  "activeDeliveries": 0,
  "uptimeSeconds": 312
}
```

---

## 🛡️ Security Protections

1. **SSRF Guard (`src/services/ssrfGuard.js`)**:
   - Rejects non-HTTP(S) schemes (`file://`, `ftp://`).
   - Resolves target hostnames and blocks connections to private IP ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local `169.254.169.254`, and IPv6 loopbacks).
   - Configurable via `ALLOW_INTERNAL_TARGETS=true` for local development and mock receiver tests.
2. **Payload Protection**:
   - Strict 256KB body parsing limit to prevent memory exhaustion attacks.
3. **Timeout Safeguards**:
   - Strict 5000ms AbortSignal timeout on all outgoing HTTP requests prevents hanging downstream connections from locking up worker slots.

---

## 📈 Scaling to High Throughput (Interview Discussion)

| Component | Current (Postgres Queue) | High Scale (~100,000 req/sec) |
| :--- | :--- | :--- |
| **Queue** | PostgreSQL `SKIP LOCKED` | **AWS SQS** or **Redis Streams** |
| **Worker Placement** | In-process with Fastify/Express | Autoscaling worker fleet (K8s / ECS) |
| **Rate Limiting** | In-memory token bucket per instance | Distributed **Redis + Lua script** bucket |
| **Dead-Letter Queue** | `status = 'failed'` in PostgreSQL | Dedicated DLQ with administrative replay API |
| **Signatures** | Ready for HMAC header | `X-Webhook-Signature: t=...,v1=hmac_sha256(...)` |

---

## 🧪 Interview Questions & Answers

**Q: Why Postgres instead of Redis/BullMQ?**  
*A: For an initial distributed system, Postgres gives ACID transactional durability with zero external dependencies. The queue, attempt history, and job status are updated atomically. If the system restarts or crashes, no data is lost.*

**Q: What delivery guarantee does this system provide?**  
*A: At-least-once delivery. If an attempt is sent but the worker crashes before recording the DB outcome, the 30-second visibility timeout reclaims the job. Downstream clients should use the provided `X-Webhook-Event-Id` header to deduplicate.*

**Q: What happens if a downstream host rate limits us?**  
*A: When our token bucket or host concurrency cap is reached, or when the destination returns HTTP 429, the job is rescheduled in the future without consuming an attempt budget.*
