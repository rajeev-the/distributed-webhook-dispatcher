# Distributed Webhook Dispatcher

A robust, production-ready, distributed webhook delivery system built with **Node.js**, **Express**, and **PostgreSQL**.

The dispatcher implements asynchronous non-blocking ingestion (immediate `202 Accepted`), durable transactional queuing via PostgreSQL `FOR UPDATE SKIP LOCKED`, per-destination rate limiting and concurrency throttling, exponential backoff retries with jitter, crash-recovery visibility timeouts, and a real-time streaming console log feed.

---

## 🌐 Live Service & Real-Time Log Feed

- **Live Base URL**: [https://distributed-webhook-dispatcher-unjr.onrender.com/](https://distributed-webhook-dispatcher-unjr.onrender.com/)

> **Live Console View:** Open the base URL in any web browser. It displays a real-time, streaming console UI (via Server-Sent Events) that logs every incoming dispatch, background worker attempt, and destination receiver response live as events occur.

---

## 📊 System Flowchart (End-to-End Lifecycle)

### High-Level Architecture Flow

```mermaid
flowchart TD
    Client(["Caller / External Client"]) -->|1. POST /api/webhooks/dispatch| Ingest["Ingestion Layer - Express"]
    Ingest -->|2. Check Unique Idempotency Key| Idemp{"Duplicate Event?"}
    
    Idemp -->|Yes| RetDup["Return HTTP 200 OK - Existing Job"]
    RetDup --> Client
    
    Idemp -->|No| Enqueue[("PostgreSQL Queue - webhook_jobs")]
    Enqueue --> FastResp["Return HTTP 202 Accepted - Instant"]
    FastResp --> Client

    subgraph Engine ["Background Delivery Engine"]
        Worker["Modular Background Worker"] -->|3. Claim Due Jobs SKIP LOCKED| Enqueue
        Worker --> RateLimit{"Host Rate Limiter and Concurrency Gate"}
        RateLimit -->|Exceeded or Saturated| Reschedule["Reschedule Job for Next Refill"]
        RateLimit -->|Slot Granted| Dispatch["HTTP POST Delivery - 5s Timeout"]
        
        Dispatch --> Dest["Destination Endpoint - /api/mock/receiver"]
        Dest --> Result{"HTTP Response"}
        
        Result -->|HTTP 2xx| Success["Mark status = succeeded"]
        Result -->|HTTP 4xx Client Error| FailPermanent["Mark status = failed - No Retry"]
        Result -->|HTTP 5xx or 429 or Timeout| RetryCheck{"Attempts remaining?"}
        
        RetryCheck -->|Yes - Retry| Backoff["Exponential Backoff - status = retrying"]
        RetryCheck -->|No - Exhausted| DLQ["Dead-Letter State - status = failed"]
        
        Success --> Attempts[("Insert delivery_attempts Record")]
        FailPermanent --> Attempts
        Backoff --> Attempts
        DLQ --> Attempts
    end

    Worker -.->|Broadcast Live Logs| SSE["Real-Time SSE Stream - GET /"]
    SSE -.-> BrowserUI(["Browser Live Log Feed"])
```

### Text Flowchart

```
[Caller]
   │
   │ 1. POST /api/webhooks/dispatch
   ▼
[Ingestion API] ──── (Instant 202 Accepted) ────► [Caller Receives Job ID]
   │
   │ 2. Atomically insert into PostgreSQL (Idempotency checked)
   ▼
[PostgreSQL Queue] ◄─── (FOR UPDATE SKIP LOCKED) ───► [Background Worker]
                                                              │
                                                              │ 3. Rate Limit Check
                                                              ▼
                                                   [Rate Limiter & Concurrency]
                                                              │
                                                              │ 4. HTTP POST (5s Timeout)
                                                              ▼
                                                   [Destination Server]
                                                              │
                                ┌─────────────────────────────┴─────────────────────────────┐
                                ▼                                                           ▼
                    [Success (2xx)]                                            [Failure (5xx / 429 / Timeout)]
                                │                                                           │
                                ▼                                                           ▼
                    Mark Job 'succeeded'                                       Calculate Exponential Backoff (2^n s)
                                                                                            │
                                                                                            ▼
                                                                               Retry attempt (Up to 4 times)
```

---

## 📡 Core API Reference

### 1. Webhook Dispatch API
Accepts incoming webhook events asynchronously and queues them for reliable delivery.

- **Endpoint**: `POST /api/webhooks/dispatch`
- **Method**: `POST`
- **Content-Type**: `application/json`

#### Request Payload Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `eventId` | `string` | **Yes** | Unique event identifier for idempotency and deduplication (e.g. `evt_live_1002`). |
| `destinationUrl` | `string` | **Yes** | Fully qualified HTTP or HTTPS destination endpoint. |
| `payload` | `object` | **Yes** | Arbitrary JSON payload data delivered to the destination. |

#### Example `curl` Command
```bash
curl -X POST "https://distributed-webhook-dispatcher-unjr.onrender.com/api/webhooks/dispatch" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "evt_live_1002",
    "destinationUrl": "https://distributed-webhook-dispatcher-unjr.onrender.com/api/mock/receiver",
    "payload": {
      "event": "payment.succeeded",
      "amount": 149.00
    }
  }'
```

#### Responses

- **First-time ingestion (HTTP 202 Accepted):**
```json
{
  "message": "Webhook accepted and queued for delivery",
  "jobId": "40116d5a-60f2-4f6f-8dfb-7082e238a92d",
  "status": "queued",
  "eventId": "evt_live_1002",
  "destinationUrl": "https://distributed-webhook-dispatcher-unjr.onrender.com/api/mock/receiver",
  "isDuplicate": false
}
```

- **Duplicate submission (HTTP 200 OK — Idempotent):**
```json
{
  "message": "Duplicate event detected. Existing job returned.",
  "jobId": "40116d5a-60f2-4f6f-8dfb-7082e238a92d",
  "status": "succeeded",
  "eventId": "evt_live_1002",
  "destinationUrl": "https://distributed-webhook-dispatcher-unjr.onrender.com/api/mock/receiver",
  "isDuplicate": true
}
```

---

### 2. Job Status & Attempts Inspection API
Inspects the live lifecycle state of any job, including its full audit trail of delivery attempts, response codes, latency, and error logs.

- **Endpoint**: `GET /api/webhooks/jobs/:id`
- **Method**: `GET`

#### URL Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `:id` | `UUID` | **Yes** | The `jobId` returned from the dispatch endpoint. |

#### Example `curl` Command
```bash
curl -X GET "https://distributed-webhook-dispatcher-unjr.onrender.com/api/webhooks/jobs/40116d5a-60f2-4f6f-8dfb-7082e238a92d"
```

#### Response (HTTP 200 OK)
```json
{
  "id": "40116d5a-60f2-4f6f-8dfb-7082e238a92d",
  "event_id": "evt_live_1002",
  "destination_url": "https://distributed-webhook-dispatcher-unjr.onrender.com/api/mock/receiver",
  "destination_host": "distributed-webhook-dispatcher-unjr.onrender.com",
  "status": "succeeded",
  "attempt_count": 1,
  "max_attempts": 4,
  "created_at": "2026-11-27T17:47:08.123Z",
  "updated_at": "2026-11-27T17:47:09.456Z",
  "attempts": [
    {
      "id": "a9d7e63b-189f-4315-bb82-99071350a41d",
      "attempt_number": 1,
      "status": "succeeded",
      "response_code": 200,
      "error_message": null,
      "duration_ms": 667,
      "started_at": "2026-11-27T17:47:09.001Z"
    }
  ]
}
```

#### Job Status Lifecycle Values
- `queued`: Newly ingested, waiting for worker pickup.
- `processing`: Claimed by a worker; active HTTP delivery in-flight.
- `retrying`: Transient failure occurred; scheduled for next exponential backoff attempt.
- `succeeded`: Terminal success (`HTTP 2xx` received from destination).
- `failed`: Terminal failure (`HTTP 4xx` client error, or all 4 retry attempts exhausted).

---

### 3. Built-in Controllable Mock Receiver API
A built-in webhook receiver endpoint to test deliveries, simulations, timeouts, and failure recovery.

- **Endpoint**: `POST /api/mock/receiver`
- **Method**: `POST`
- **Content-Type**: `application/json`

#### Query Parameters for Testing & Simulation
| Query Param | Values / Format | Description |
| :--- | :--- | :--- |
| `mode` | `ok` *(default)* | Responds with immediate `HTTP 200 OK`. |
| `mode` | `fail500` | Returns `HTTP 500 Internal Server Error`. Combine with `failTimes` to test retries. |
| `failTimes` | `integer` (e.g. `2`) | Fails the first `N` attempts with `500`, then returns `200` on the `(N+1)`th attempt. |
| `mode` | `slow` | Delays response. Combine with `delay` to simulate slow endpoints or timeouts. |
| `delay` | `milliseconds` (e.g. `3000`) | Number of milliseconds to delay the response before returning `200`. |
| `mode` | `429` | Returns `HTTP 429 Too Many Requests` (honoring `retryAfter` if set). |
| `retryAfter` | `seconds` (e.g. `2`) | Adds `Retry-After: 2` header to `429` response. |
| `mode` | `client_error` | Returns `HTTP 400 Bad Request` (proves immediate failure without unnecessary retries). |

#### Example: Direct Test of Receiver
```bash
curl -X POST "https://distributed-webhook-dispatcher-unjr.onrender.com/api/mock/receiver" \
  -H "Content-Type: application/json" \
  -d '{ "ping": "pong" }'
```

#### Example: Testing 2-Time Failure With Automatic Retry Recovery
```bash
curl -X POST "https://distributed-webhook-dispatcher-unjr.onrender.com/api/webhooks/dispatch" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "evt_test_retry_01",
    "destinationUrl": "https://distributed-webhook-dispatcher-unjr.onrender.com/api/mock/receiver?mode=fail500&failTimes=2",
    "payload": { "orderId": 999 }
  }'
```

---

## 🔑 Key Architectural Features

1. **Transactional PostgreSQL Queue (`FOR UPDATE SKIP LOCKED`)**:
   - Zero external message broker dependencies (no Redis/RabbitMQ required).
   - Atomic job state transitions and concurrent worker safety without lock contention.

2. **Strict Per-Destination Rate Limiting & Concurrency Control**:
   - In-memory **Token Bucket** per target hostname (capacity: 5 tokens, refill: 2 tokens/s).
   - Concurrency semaphore (max 2 concurrent in-flight requests per host) prevents overwhelming receivers.

3. **Exponential Backoff with Full Jitter**:
   - Retry delays: $2^n$ seconds ($2s \to 4s \to 8s$) with a random $\pm 10\%$ jitter factor.
   - Non-retryable `4xx` responses are immediately marked `failed` to prevent wasted compute.

4. **Crash-Recovery Visibility Timeout**:
   - Jobs in `processing` state for longer than 30 seconds (due to server reboot or container migration) are automatically recovered and rescheduled.

5. **SSRF Guard & Security**:
   - Strict protocol enforcement (`http:` and `https:` only).
   - Blocks internal/private IP ranges (`127.0.0.0/8`, `10.0.0.0/8`, `169.254.0.0/16`, etc.) when `ALLOW_INTERNAL_TARGETS` is disabled.
   - Strict 5000ms request timeout via `AbortSignal`.

---

## 💻 Local Development Setup

### 1. Installation
```bash
git clone https://github.com/rajeev-the/distributed-webhook-dispatcher.git
cd distributed-webhook-dispatcher
npm install
```

### 2. Environment Configuration
Create a `.env` file based on `.env.example`:
```env
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/webhook_dispatcher?sslmode=disable
ALLOW_INTERNAL_TARGETS=true
```

### 3. Run Migrations & Start
```bash
# Run database schema migration
npm run migrate

# Start server and background worker
npm start
```

### 4. Run Test Suite
```bash
npm test
```
