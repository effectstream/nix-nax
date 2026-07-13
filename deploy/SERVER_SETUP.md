# Nix-Nax — Server Setup Runbook

Step-by-step instructions to clone this repository on a fresh Linux server and
bring up **every service needed for a working, browser-playable deployment**.
Written to be executed top-to-bottom by an operator (human or agent) with SSH
and sudo access. Each step ends with a **Verify** command — do not continue
past a failed verification.

**Assumptions:** Ubuntu 22.04+ / Debian 12+ (x86_64 or arm64), ≥ 8 GB RAM
(circuit key generation is memory-hungry), ≥ 20 GB free disk, sudo access,
outbound internet. Commands assume a `nixnax` service user and the repo at
`/srv/nixnax` — adjust consistently if you change either.

---

## Architecture — what has to run

The dApp is **serverless by design**: the player's *browser* builds, proves,
and submits every on-chain transaction. The server hosts:

| Service | What | Port | Managed by |
|---|---|---|---|
| Midnight node | the blockchain (dev chain) | 9944 | `bun run stack:up` |
| Midnight indexer | chain query API (GraphQL + WS) | 8088 | `bun run stack:up` |
| Midnight proof server | generates ZK proofs for browsers | 6300 | `bun run stack:up` |
| Message relay | WebSocket switchboard for off-chain moves | 4310 (loopback) | systemd (`nixnax-relay`) |
| nginx | static webapp + `/relay` proxy + ZK assets | 80 (443 with TLS) | systemd |

> **Critical consequence:** browsers connect **directly** to the indexer
> (8088), node (9944), and proof server (6300). Those ports must be reachable
> from players' machines, and the webapp must be **built** with the server's
> public address in its `VITE_*` endpoint vars (defaults are `127.0.0.1`,
> which only works on the server itself). Step 7 covers this.

**Deployment modes:**
- **Mode A (this runbook's main path):** fully self-contained demo — the
  server runs its own dev chain (`undeployed` network), site served over
  plain HTTP, players use the built-in session wallet + faucet. No external
  dependencies, fully automatable.
- **Mode B:** same, behind TLS — see [TLS variant](#mode-b--tls-variant).
- **Mode C:** point at the public **preview** network instead of a local
  chain — see [Preview network](#mode-c--preview-network). Requires a funded
  wallet seed and network endpoints; not fully automatable.

---

## Step 1 — System preparation

```bash
sudo apt-get update
# xz-utils is required by the Compact installer (it ships a .tar.xz archive); on
# minimal images its absence fails the install with "xz: Cannot exec".
sudo apt-get install -y git curl unzip xz-utils nginx

# Docker + Compose run the Midnight chain stack (Step 4). Install Docker Engine
# per https://docs.docker.com/engine/install/ for your distro, then:
sudo systemctl enable --now docker

# Service user + directory
sudo useradd -r -m -d /home/nixnax -s /bin/bash nixnax || true
sudo usermod -aG docker nixnax          # let the service user reach the Docker daemon
sudo mkdir -p /srv/nixnax
sudo chown nixnax:nixnax /srv/nixnax
```

Install **Bun** (package manager + runtime for everything here) as the
service user:

```bash
sudo -iu nixnax bash -c 'curl -fsSL https://bun.sh/install | bash'
```

Install the **Compact toolchain** (compiles the smart contract; required
because the compiled artifacts are gitignored and nginx serves the ~77 MB of
prover keys from them):

```bash
sudo -iu nixnax bash -lc "curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh"
# The installer needs xz-utils (installed in Step 1) to extract its archive.
# Then install the PINNED compiler — `compact compile +0.31.1` does NOT
# auto-download it (needs unzip, also from Step 1):
sudo -iu nixnax bash -lc "export PATH=\$HOME/.local/bin:\$PATH && compact update 0.31.1"
```

> If the installer URL 404s, get the current command from
> https://docs.midnight.network (Compact developer tools) or the
> `midnightntwrk/compact` GitHub releases page. `compact` installs to
> `~/.local/bin` — the `bash -lc` login shell picks it up via the installer's
> PATH entry; if not, add `~/.local/bin` to PATH.

**Verify:**
```bash
sudo -iu nixnax bash -lc 'bun --version && compact --version'
# expect: a bun version (1.x) and a compact CLI version string
```

---

## Step 2 — Clone and install dependencies

```bash
sudo -iu nixnax bash -lc '
  git clone https://github.com/effectstream/nix-nax.git /srv/nixnax
  cd /srv/nixnax        && bun install
  cd /srv/nixnax/relay  && bun install
  cd /srv/nixnax/webapp && bun install
'
```

**Verify:**
```bash
sudo -iu nixnax bash -lc 'ls /srv/nixnax/node_modules /srv/nixnax/webapp/node_modules /srv/nixnax/relay/node_modules >/dev/null && echo deps-ok'
```

---

## Step 3 — Compile the smart contract

Compiles 16 circuits and generates prover/verifier keys. Takes several
minutes and several GB of RAM (the `settle` circuit is k=17).

```bash
sudo -iu nixnax bash -lc 'cd /srv/nixnax && bun run compact'
```

**Verify:**
```bash
sudo -iu nixnax bash -lc 'ls /srv/nixnax/src/contract/managed/keys/*.prover | wc -l'
# expect: 16
```

---

## Step 4 — Start the Midnight chain stack

`bun run stack:up` launches node, indexer, and proof server as Docker containers
from the official public images (`deploy/docker/network-compose.yml`), at the
preview-target versions. **Requires Docker + Compose** and that the `nixnax` user
can talk to the daemon (`sudo usermod -aG docker nixnax`, then re-login).

```bash
sudo -iu nixnax bash -lc 'cd /srv/nixnax && bun run stack:up'
# wait for the containers to report healthy:
sudo -iu nixnax bash -lc 'cd /srv/nixnax && docker compose -f deploy/docker/network-compose.yml ps'
```

Containers run detached and survive the command exiting. To survive a **reboot**,
add `restart: unless-stopped` to the services (Docker restarts them on boot), or
manage the compose file with a systemd unit:

```bash
sudo tee /etc/systemd/system/nixnax-stack.service >/dev/null <<'EOF'
[Unit]
Description=Nix-Nax local Midnight stack (node + indexer + proof server)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=true
User=nixnax
WorkingDirectory=/srv/nixnax
ExecStart=/home/nixnax/.bun/bin/bun run stack:up
ExecStop=/home/nixnax/.bun/bin/bun run stack:down
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable nixnax-stack
# (don't `start` it now if stack:up is already running — it's already up)
```

**Verify (node + indexer must respond; proof server has no HTTP healthcheck but
answers `/version`):**
```bash
curl -sf http://127.0.0.1:9944/health >/dev/null && echo node-ok
curl -sf -o /dev/null http://127.0.0.1:8088/api/v3/graphql && echo indexer-ok
curl -sf http://127.0.0.1:6300/version && echo proof-ok
```
If any fail, check container logs: `docker compose -f deploy/docker/network-compose.yml logs`.

---

## Step 5 — Deploy the arena contract

One-time per chain. Deploys the contract stub, then installs 16 verifier
keys — **17 transactions, expect ~10 minutes**. Writes the contract address
to `webapp/public/arena.json`, which the browser reads at runtime.

```bash
sudo -iu nixnax bash -lc 'cd /srv/nixnax && bun run deploy'
```

Notes:
- The first ~30 s are wallet sync (`[wallet sync 30s] ... dust=true` is normal).
- On the dev chain the deployer is the pre-funded genesis wallet — no
  funding step needed.
- Re-running is safe: it validates the persisted address against the chain
  and reuses it (`nixnax.undeployed.json`).

**Verify:**
```bash
sudo -iu nixnax bash -lc 'cat /srv/nixnax/webapp/public/arena.json'
# expect: { "contractAddress": "<64 hex chars>", "networkId": "undeployed" }
```

---

## Step 6 — Start the message relay (systemd)

The relay is a dumb WebSocket switchboard for off-chain moves — no keys, no
chain access. The repo ships a hardened unit:

```bash
sudo cp /srv/nixnax/deploy/nixnax-relay.service /etc/systemd/system/
# The unit assumes bun at /home/nixnax/.bun/bin/bun and the repo at
# /srv/nixnax — edit ExecStart/WorkingDirectory if your paths differ.
sudo systemctl daemon-reload
sudo systemctl enable --now nixnax-relay
```

**Verify:**
```bash
curl -sf http://127.0.0.1:4310/api/health
# expect: {"ok":true,"role":"message-relay"}
```

---

## Step 7 — Build the webapp (public endpoints!)

This is the step most likely to be done wrong. The `VITE_*` values are
**baked into the JS bundle at build time** and are what *players' browsers*
connect to — they must be the server's public address, not localhost.

```bash
PUBLIC_HOST="$(curl -sf ifconfig.me || hostname -I | awk '{print $1}')"  # or your DNS name
sudo -iu nixnax bash -lc "cat > /srv/nixnax/.env <<EOF
# Baked into the webapp bundle — must be reachable from players' browsers.
VITE_INDEXER_URL=http://${PUBLIC_HOST}:8088/api/v3/graphql
VITE_INDEXER_WS_URL=ws://${PUBLIC_HOST}:8088/api/v3/graphql/ws
VITE_NODE_URL=http://${PUBLIC_HOST}:9944
VITE_PROOF_SERVER_URL=http://${PUBLIC_HOST}:6300
EOF"
sudo -iu nixnax bash -lc 'cd /srv/nixnax/webapp && bun run build'
```

(`VITE_NETWORK_ID` stays unset → `undeployed`, which keeps the in-browser
session wallet + faucet enabled and the `arena.json` fallback active.)

**Verify:**
```bash
sudo -iu nixnax bash -lc "grep -c \"${PUBLIC_HOST}\" /srv/nixnax/webapp/dist/assets/index-*.js"
# expect: a number ≥ 1 (the public endpoints made it into the bundle)
```

---

## Step 8 — nginx + firewall

Plain-HTTP site config for the demo (for TLS see Mode B; the repo's
[`deploy/nginx.conf.example`](nginx.conf.example) is the TLS version):

```bash
sudo tee /etc/nginx/sites-available/nixnax >/dev/null <<'EOF'
server {
    listen 80 default_server;
    server_name _;

    root /srv/nixnax/webapp/dist;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript application/json application/wasm;

    location / { try_files $uri /index.html; }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Compiled ZK assets (~77 MB of prover keys) — browsers fetch these to prove.
    location /contract/compiled/nixnax-arena/ {
        alias /srv/nixnax/src/contract/managed/;
        default_type application/octet-stream;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Off-chain message relay (WebSocket).
    location /relay {
        proxy_pass http://127.0.0.1:4310;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/nixnax /etc/nginx/sites-enabled/nixnax
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Open the firewall — the site **plus the three chain ports browsers connect
to directly**:

```bash
sudo ufw allow 80/tcp && sudo ufw allow 8088/tcp && sudo ufw allow 9944/tcp && sudo ufw allow 6300/tcp
# (cloud provider security groups: open the same four ports)
```

**Verify:**
```bash
curl -sf http://127.0.0.1/ | grep -qi "<title" && echo site-ok
curl -sf -o /dev/null http://127.0.0.1/contract/compiled/nixnax-arena/keys/settle.prover && echo zk-assets-ok
curl -sf http://127.0.0.1/arena.json && echo
```

---

## Step 9 — End-to-end verification

From your own machine (not the server):

```bash
HOST=<server ip or dns>
curl -sf http://$HOST/arena.json                      # contract address JSON
curl -sf -o /dev/null http://$HOST:8088/api/v3/graphql && echo indexer-reachable
curl -sf http://$HOST:9944/health >/dev/null && echo node-reachable
```

Then in a browser: open `http://<HOST>/` →
1. Click **Wallet** (top-right) → **Session Wallet + Auto Faucet**. First run
   syncs and funds the in-browser wallet (~1–2 min; watch the log panel).
2. Click **Practice vs AI** → a game opens (this exercises `createGame` +
   `joinGame` on-chain, proved in your browser via the server's proof server).
3. Play a few moves, open the blockchain drawer, hit **Submit** — a `settle`
   transaction should confirm.

For a two-player game: second browser, same URL, **Join a game** with the
shared game id.

**⚠ Demo-grade security:** the dev chain's genesis funds are a public,
well-known seed, and the site is HTTP. This mode is for demos/testing —
don't put anything of value on it.

---

## Mode B — TLS variant

Same as above, plus:
1. Get a domain + certificate (`certbot --nginx`).
2. Use [`deploy/nginx.conf.example`](nginx.conf.example) as the site config
   (it's the TLS version of Step 8).
3. **Mixed-content rule:** an HTTPS page cannot call `http:`/`ws:` chain
   endpoints. Either terminate TLS for ports 8088/9944/6300 too (extra
   nginx `server` blocks proxying each), or add path-based proxies
   (`/indexer/`, `/node/`, `/proof/` → the local ports, with WebSocket
   upgrade headers on indexer + node) and point the `VITE_*` vars at
   `https://domain/...` / `wss://domain/...` before rebuilding the webapp.

## Mode C — Preview network

Instead of running a local chain (skip Step 4's node/indexer; keep a **proof
server** running — deploy and browsers both need one, e.g. `bun run stack:up`
then ignore its node/indexer, or run just a proof-server 8.1.0 at :6300):

1. Deploy to preview with a **funded, DUST-registered** wallet (enough NIGHT
   for the 17 deploy transactions):

   ```bash
   MN_ENV=preview MN_MNEMONIC="word1 word2 … word24" bun run deploy:net
   # or from a raw hex seed:  MN_ENV=preview MN_SEED=<hex> bun run deploy:net
   ```

   `deploy:net` ([`scripts/deploy-network.ts`](../scripts/deploy-network.ts))
   resolves the preview endpoints, runs the full 17-tx deploy, caches the
   address in `nixnax.preview.json`, and **writes the address + node/indexer
   URLs into the root `.env`** as `VITE_ARENA_ADDRESS_PREVIEW`,
   `VITE_INDEXER_URL_PREVIEW`, `VITE_INDEXER_WS_URL_PREVIEW`,
   `VITE_NODE_URL_PREVIEW`. Override endpoints with `MN_INDEXER_URL` /
   `MN_NODE_URL` if the live network runs a newer indexer API path.
2. Webapp build: set `VITE_NETWORK_ID=preview` and a **public**
   `VITE_PROOF_SERVER_URL_PREVIEW` (browsers need a reachable proof server;
   `deploy:net` does not write this, since the deploy-time one is local). TLS
   is effectively mandatory (public users).
3. Players need a Midnight browser-extension wallet set to preview and their
   own gas — the session wallet/faucet is disabled off the dev chain.
4. Caveats: `mainnet`/`testnet`/`qanet` work the same way (`MN_ENV=<net>`) but
   confirm the network is live and the indexer API path is right before burning
   the 17 deploy transactions; the extension-wallet connector is the
   least-exercised path in the repo.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `compact: command not found` | Re-login shell (`bash -l`) or add `~/.local/bin` to PATH; installer puts the CLI there. |
| `stack:up` port already in use | A previous stack is running: `bun run stack:down`, or check `docker ps` for stray `nixnax-*` containers. |
| Deploy hangs at `[wallet sync …]` | Normal for ~30 s; if minutes, the indexer isn't healthy — `docker compose -f deploy/docker/network-compose.yml logs indexer`. |
| `gameId already exists` in tests/games after a chain reset | Stale persisted address: delete `nixnax.undeployed.json` and re-run `bun run deploy`. |
| Browser: faucet fails with `1010 … Custom error 192` | Known dev-chain dust-registration constraint; the app falls back to the genesis wallet as gas payer automatically. |
| First `settle` of a game with a **single move** rejected: `Malformed(…FeeCalculation)` | Known dev-node fee-model edge (wallet/node disagreement for the smallest settle tx) — not a contract bug. Play/submit ≥ 2 moves; details in `test/e2e/timeout.test.ts`. |
| Site loads but wallet/faucet stalls remotely | The bundle was built with localhost endpoints, or ports 8088/9944/6300 are firewalled. Redo Step 7 + Step 8's firewall, rebuild. |
| ZK asset 404s (`/contract/compiled/nixnax-arena/...`) | `src/contract/managed/` missing (Step 3 not run) or nginx `alias` path wrong. |
| Everything broke after reboot | The chain stack wasn't systemd-managed: `sudo systemctl start nixnax-stack` (or `bun run stack:up`), then `bun run deploy` reuses the arena. Chain state persists; if the chain was wiped, redeploy and rebuild is NOT needed (arena.json is runtime-fetched, only `deploy` must re-run). |

## Service management quick reference

```bash
# Chain stack
sudo systemctl {start|stop|status} nixnax-stack     # or: bun run stack:up / stack:down
docker compose -f /srv/nixnax/deploy/docker/network-compose.yml logs -f

# Relay
sudo systemctl {restart|status} nixnax-relay
journalctl -u nixnax-relay -f

# Webapp: static — rebuild + reload nginx after .env changes
sudo -iu nixnax bash -lc 'cd /srv/nixnax/webapp && bun run build'
sudo systemctl reload nginx

# Contract redeploy (e.g. after a chain wipe)
sudo -iu nixnax bash -lc 'cd /srv/nixnax && bun run deploy'
```
