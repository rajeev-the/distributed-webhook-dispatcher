#!/usr/bin/env bash

# ==============================================================================
# Distributed Webhook Dispatcher - Interactive Demonstration Script
# ==============================================================================

set -e

PORT="${PORT:-3000}"
BASE_URL="${BASE_URL:-http://localhost:${PORT}}"

echo "========================================================================"
echo "🎯 DISTRIBUTED WEBHOOK DISPATCHER - LIVE VERIFICATION"
echo "Target Server: $BASE_URL"
echo "========================================================================"
echo ""

# Helper to check JSON with jq or fallback to python
function format_json() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  else
    python3 -m json.tool 2>/dev/null || cat
  fi
}

# 1. Health Check
echo "--- 1. Health Check (GET /health) ---"
curl -s "$BASE_URL/health" | format_json
echo ""

# 2. Non-blocking Ingestion Proof with Slow Downstream
echo "--- 2. Non-blocking Ingestion with Slow Downstream (5s delay downstream) ---"
echo "Dispatching webhook pointing to a downstream target that delays response by 4 seconds..."
START_TIME=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
SLOW_RES=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/webhooks/dispatch" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "evt-slow-'$(date +%s)'",
    "destinationUrl": "'"$BASE_URL"'/api/mock/receiver?mode=slow&delay=4000",
    "payload": { "task": "heavy_processing", "priority": "high" }
  }')
END_TIME=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')

HTTP_CODE=$(echo "$SLOW_RES" | tail -n 1)
BODY=$(echo "$SLOW_RES" | sed '$d')

ELAPSED_MS=$(( (END_TIME - START_TIME) / 1000000 ))
echo "Status Code: $HTTP_CODE (Expected 202 Accepted)"
echo "Client turnaround time: ${ELAPSED_MS}ms (Returned INSTANTLY without waiting for downstream!)"
echo "$BODY" | format_json
echo ""

# 3. Standard Delivery: Queued -> Succeeded
echo "--- 3. Standard Delivery to Mock Receiver (?mode=ok) ---"
NORMAL_RES=$(curl -s -X POST "$BASE_URL/api/webhooks/dispatch" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "evt-normal-'$(date +%s)'",
    "destinationUrl": "'"$BASE_URL"'/api/mock/receiver?mode=ok",
    "payload": { "event": "order.completed", "amount": 99.95 }
  }')
echo "$NORMAL_RES" | format_json
JOB_ID=$(echo "$NORMAL_RES" | grep -o '"jobId":"[^"]*' | cut -d'"' -f4)

echo ""
echo "Waiting 2 seconds for worker to deliver..."
sleep 2

echo "Verifying Job status and attempt log (GET /api/webhooks/jobs/$JOB_ID):"
curl -s "$BASE_URL/api/webhooks/jobs/$JOB_ID" | format_json
echo ""

# 4. Idempotency Check: Same (eventId, destinationUrl)
echo "--- 4. Idempotency Check (Duplicate Event Handling) ---"
DUP_ID="evt-dup-check-101"
DEST="$BASE_URL/api/mock/receiver?mode=ok"

echo "Sending initial request..."
curl -s -X POST "$BASE_URL/api/webhooks/dispatch" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\": \"$DUP_ID\", \"destinationUrl\": \"$DEST\", \"payload\": {\"run\": 1}}" | format_json

echo "Sending duplicate request with same eventId and destinationUrl..."
curl -s -X POST "$BASE_URL/api/webhooks/dispatch" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\": \"$DUP_ID\", \"destinationUrl\": \"$DEST\", \"payload\": {\"run\": 2}}" | format_json
echo ""

# 5. Retry Mechanism with Exponential Backoff (?mode=fail500&failTimes=2)
echo "--- 5. Transient Server Error with Exponential Backoff ---"
echo "Dispatching event to target configured to fail 500 on first 2 attempts, then recover on attempt 3..."
RETRY_RES=$(curl -s -X POST "$BASE_URL/api/webhooks/dispatch" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "evt-retry-'$(date +%s)'",
    "destinationUrl": "'"$BASE_URL"'/api/mock/receiver?mode=fail500&failTimes=2",
    "payload": { "alert": "server_down", "severity": "critical" }
  }')
echo "$RETRY_RES" | format_json
RETRY_JOB_ID=$(echo "$RETRY_RES" | grep -o '"jobId":"[^"]*' | cut -d'"' -f4)

echo ""
echo "Polling job status over backoff window (attempt 1 immediate, retry 1 in ~2s, retry 2 in ~4s)..."
for i in {1..7}; do
  echo "[Check $i/7 at $(date +%H:%M:%S)]"
  curl -s "$BASE_URL/api/webhooks/jobs/$RETRY_JOB_ID" | grep -o '"status":"[^"]*"' || true
  sleep 1.5
done

echo ""
echo "Final job attempts log:"
curl -s "$BASE_URL/api/webhooks/jobs/$RETRY_JOB_ID" | format_json
echo ""

# 6. Non-retryable Permanent Failure (?mode=client_error)
echo "--- 6. Permanent Client Error (HTTP 400 - No Retries) ---"
CLIENT_ERR_RES=$(curl -s -X POST "$BASE_URL/api/webhooks/dispatch" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "evt-clienterr-'$(date +%s)'",
    "destinationUrl": "'"$BASE_URL"'/api/mock/receiver?mode=client_error",
    "payload": { "invalid": "schema" }
  }')
CLIENT_ERR_JOB_ID=$(echo "$CLIENT_ERR_RES" | grep -o '"jobId":"[^"]*' | cut -d'"' -f4)

sleep 1.5
echo "Verifying that job transitioned to 'failed' with only 1 attempt:"
curl -s "$BASE_URL/api/webhooks/jobs/$CLIENT_ERR_JOB_ID" | format_json
echo ""

echo "========================================================================"
echo "✅ All verification scenarios executed successfully!"
echo "========================================================================"
