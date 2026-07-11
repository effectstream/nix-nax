#!/usr/bin/env bash
# Runtime reproduction of README Quickstart steps 3-6, in order, on one host —
# the way a tester runs them. Fails loudly (with logs) at the first broken step
# so the clean-room experiment pinpoints exactly where the docs break.
set -euo pipefail
cd /app

log() { echo "[experiment] $*"; }
dump_stack_logs() { echo "----- .stack-logs -----"; tail -n 40 .stack-logs/*.log 2>/dev/null || true; }
trap 'log "FAILED (see output above)"; dump_stack_logs' ERR

# 3. Start the local Midnight stack (blocks until "Stack is up." then exits).
log "step 3: bun run stack:up"
bun run stack:up

# The node/indexer/proof bind inside this container; confirm the browser-facing
# ports actually answer before continuing (a bound-to-loopback service would
# publish but never connect — the classic 'game did not connect' cause).
log "verifying chain ports respond on 0.0.0.0…"
for probe in "node:9944:/health" "indexer:8088:/api/v3/graphql" "proof:6300:/"; do
  name="${probe%%:*}"; rest="${probe#*:}"; port="${rest%%:*}"; path="${rest#*:}"
  if curl -sf -o /dev/null --max-time 5 "http://127.0.0.1:${port}${path}"; then
    log "  ${name} (:${port}) OK"
  else
    log "  ${name} (:${port}) NOT RESPONDING"; dump_stack_logs; exit 1
  fi
done

# 4. Deploy the arena (writes webapp/public/arena.json).
log "step 4: bun run deploy"
bun run deploy
test -s webapp/public/arena.json || { log "arena.json not written"; exit 1; }
log "arena: $(cat webapp/public/arena.json | tr -d '\n')"

# 5. Start the relay (background) and confirm health.
log "step 5: relay on :4310"
( cd relay && bun run start ) &
RELAY_PID=$!
for i in $(seq 1 20); do
  curl -sf -o /dev/null --max-time 3 http://127.0.0.1:4310/api/health && break
  sleep 1
  [ "$i" = "20" ] && { log "relay never became healthy"; exit 1; }
done
log "  relay OK"

# 6. Start the web client. One deviation from the README: --host 0.0.0.0 so the
# published port is reachable — vite binds localhost by default, which is why a
# remote/containerised browser gets "game did not connect".
log "step 6: webapp on :5173 (0.0.0.0)"
log "ALL SERVICES UP — open http://localhost:5173"
cd webapp && exec bun run dev -- --host 0.0.0.0 --port 5173
