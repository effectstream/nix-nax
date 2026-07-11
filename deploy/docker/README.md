# deploy/docker

Two independent Docker setups live here.

## 1. `network-compose.yml` — the local Midnight network at preview versions

Runs node + indexer + proof server from the **official public Docker Hub images**
(`midnightntwrk/*`) at the preview-compatibility matrix (`network.env`): node
1.0.0, indexer-standalone 4.3.3, proof-server 8.1.0. This is the version-matching
alternative to `bun run stack:up`, whose `@effectstream/npm-midnight-*` wrappers
are pinned to older dev binaries (node 0.22.5 / indexer v4.2.0 /
proof-server ledger-8.0.3).

```bash
bun run stack:net                    # up -d (node:9944, indexer:8088, proof:6300)
# wait for all three healthy, then:
bun run deploy
# …run the webapp/relay as usual…
bun run stack:net:down               # down -v
```

The images are public and multi-arch (amd64 + arm64) — no login, and it runs
natively on Apple Silicon. Note the registry path is Docker Hub `midnightntwrk/*`
(no hyphen); the reference testkit's `ghcr.io/midnight-ntwrk/*` (hyphen) is a
**private** org mirror (401/403 anonymously) — the Docker Hub copies are the
public ones.

Which local stack to use:

| | `bun run stack:up` (@effectstream) | `bun run stack:net` (Docker Hub compose) |
|---|---|---|
| Versions | node 0.22.5 / proof ledger-8.0.3 (older) | node 1.0.0 / proof 8.1.0 (**preview target**) |
| Access | public, no login | public, no login |
| arm64 | ✗ (proof-server 8.0.3 has no arm64 build) | ✓ (multi-arch images) |
| Docker | not required (spawns binaries) | required |

Our upgraded JS (ledger 8.1.0 / midnight-js 4.1.1) is verified working against
both: the `stack:up` 8.0.3 binaries (deploy + e2e mint) and `stack:net`'s
preview-target node 1.0.0 / indexer 4.3.3 / proof-server 8.1.0 — the full 17-tx
deploy (stub + 16 verifier keys) lands cleanly and writes `arena.json`.

## 2. `Dockerfile` + `docker-compose.yml` — clean-room setup experiment

A single container that runs the README quickstart end-to-end (chain → deploy →
relay → webapp) to catch setup breakage a fresh clone hits. Pinned `linux/amd64`
(the `@effectstream` dev proof-server binary has no arm64 build). See the header
comments in those files. Run: `docker compose -f deploy/docker/docker-compose.yml up --build`.
