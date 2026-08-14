# deploy/docker

`network-compose.yml` runs the local Midnight network — node + indexer + proof
server — from the **official public Docker Hub images** (`midnightntwrk/*`) at
the preview-compatibility matrix (`network.env`): node 1.0.0,
indexer-standalone 4.3.3, proof-server 8.1.0. This is what `bun run stack:up`
starts, so the versions you run locally match the preview network exactly.

```bash
bun run stack:up                     # up -d (node:9944, indexer:8088, proof:6300)
# wait for the containers to report healthy, then:
bun run deploy
# …run the webapp/relay as usual…
bun run stack:down                   # down -v
```

The images are public and multi-arch (amd64 + arm64) — no login, and it runs
natively on Apple Silicon. Note the registry path is Docker Hub `midnightntwrk/*`
(no hyphen); the reference testkit's `ghcr.io/midnight-ntwrk/*` (hyphen) is a
**private** org mirror (401/403 anonymously) — the Docker Hub copies are the
public ones.

Verified: the full 5-tx deploy (stub + 4 verifier keys) lands cleanly against
this stack and writes `arena.json`, and our upgraded JS (ledger 8.1.0 /
midnight-js 4.1.1) drives it end-to-end.

## Notes on the compose

- **Indexer needs `APP__INFRA__SPO_NODE__URL`** pointed at the node. Without it,
  the SPO sub-indexer crashes "Connection refused" and takes the whole
  indexer-standalone down. SPO is a no-op here (`BLOCKFROST_ID` is a dummy).
- **The proof-server has no healthcheck** — its image ships no shell/curl, so any
  probe reports "unhealthy" even when the server is fine. Nothing depends on it;
  check it out-of-band with `curl http://localhost:6300/version` → `8.1.0`.
- **`NETWORK_ID: undeployed`** matches the local dev chain the webapp/wallet expect.
