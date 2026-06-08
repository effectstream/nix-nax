# Tic-Tac-Toe state channel on Midnight

A two-player tic-tac-toe game that plays **off-chain at memory speed** and
settles **on-chain in one transaction**, with cryptographic anti-cheat —
equivocation is provable, silence is timed out. Implements the design from
`midnight-ref-ai/experiments/tic-tac-toe-channel/IMPLEMENTATION_SPEC.md`.

## What's in the box

```
src/contract/TicTacToeChannel.compact   Merged Compact contract — 6 circuits.
src/contract/witnesses.ts                localSecret witness for caller auth.
src/sdk/                                 Bun + TypeScript SDK.
  crypto/                                  persistentHash + token-tree + SignedMove.
  game/                                    GameSession (build moves, settle, dispute).
  env, wallet, providers, deploy           Vendored, trimmed midnight-js wiring.
src/cli/ttt.ts                           Tiny manual CLI (open, show, decode-move).
scripts/{stack-up,stack-down}.ts          Start/stop local node + indexer + proof-server.
test/                                    14 contract sim tests + 15 crypto tests + 3 e2e.
relay/server.ts                          Bun HTTP+WS service: chain API + move relay.
webapp/                                  Vite + React SPA — clickable game board.
```

## Compact contract — six circuits

1. **constructor** — registers `idX`, `idO` (identity commitments) and
   `rootX`, `rootO` (one-time-token Merkle roots).
2. **`settle(nMoves, cells, secrets, paths, untilTime)`** — replays an
   off-chain move log on-chain. Verifies each new move's one-time token under
   the mover's root, places the mark, detects win/draw, and arms a challenge
   window. A longer valid history may override within the window.
3. **`claimResult()`** — finalises after the challenge window elapses.
4. **`startTimeout(untilTime)`** — the waiting player (proving their secret)
   arms a deadline.
5. **`claimTimeout()`** — permissionless; once the deadline passes, the
   player-to-move forfeits.
6. **`proveEquivocationByX(turn, cellA, secretA, pathA, cellB, secretB, pathB)`** —
   two valid X-tokens for the same turn at different cells. **O wins
   instantly**, channel settles, no challenge window.
7. **`proveEquivocationByO(...)`** — symmetric.

**Authentication.** No circuit uses `ownPublicKey()` (a spoofable witness —
OZ audit C-01). Instead, callers prove knowledge of `skP` via
`persistentHash("ttt:id:", skP) == idP` (the bboard pattern). For the
permissionless circuits (`settle`, `proveEquivocation*`, `claimTimeout`,
`claimResult`), the payload (one-time tokens) and on-chain state are the
authenticator — they need no caller check.

**One-time tokens (see `src/sdk/crypto/token-tree.ts`).** Each player generates
81 secrets indexed by `(turn, cell)`. Each leaf = `persistentHash(domainSep,
turn, cell, secret)`. The depth-10 Merkle root is registered on-chain at open.
Authorising the move at `(turn k, cell c)` reveals `s[k][c]` and its path —
verified in-circuit by `tokenIsUnder`. Equivocating means revealing two
tokens for the same turn → trivially provable fraud.

## Prerequisites

- macOS or Linux (ARM64 or x86_64).
- [Bun](https://bun.sh/) — `bun install` and the test runner.
- The [Compact toolchain](https://github.com/midnightntwrk/compact) — `compact
  --version` must work. Then `compact update 0.30.0` to pin the language
  version this project uses.

## One-time setup

```bash
bun install
bun run compact          # compile .compact -> src/contract/managed/
```

`bun run compact:check` runs the WASM-only syntactic compile (faster, no
artifacts).

## Run the tests

### Unit (contract simulation + crypto) — no chain required

```bash
bun run test
```

14 contract-simulation tests drive the compiled circuits in pure JS through
`@midnight-ntwrk/compact-runtime` — open, settle (happy path / override /
draw), claimResult, equivocation, timeout, negatives. 15 crypto tests cover
token-tree parity, SignedMove verification, equivocation builder, JSON serde.

### End-to-end (real local stack)

Bring up the local Midnight stack (node 9944, indexer 8088, proof server 6300):

```bash
bun run stack:up
```

Logs land in `.stack-logs/`. When you see `wait-on` exit cleanly:

```bash
bun run test:e2e
```

Three e2e tests, total ~5 minutes:
- **happy** — deploy, play a 5-move X win off-chain, settle, claimResult.
- **fraud** — X equivocates, O calls `proveEquivocationByX`, O wins instantly.
- **timeout** — X plays one move, O is silent, X arms `startTimeout`, claims
  forfeit after the deadline.

Stop the stack:

```bash
bun run stack:down
```

## Manual play

```bash
bun run cli open          # deploy a fresh channel; prints contract address
bun run cli show          # query on-chain state
```

The CLI is intentionally minimal — full game flow is exercised by the e2e
tests, which thread two `GameSession` instances through the protocol.

## Web frontend (`webapp/` + `relay/`)

A Vite + React UI lives in `webapp/`; a tiny Bun service in `relay/` exposes
the on-chain SDK over HTTP and forwards `SignedMove`s over WebSocket. To
play in a browser:

```bash
# 1. Local Midnight stack (node + indexer + proof server)
bun run stack:up

# 2. Relay / chain backend on port 4310 (boots once; reuses one wallet).
#    This blocks until the wallet syncs (~30-60s on a fresh chain).
bun --cwd relay install
bun --cwd relay run start

# 3. Vite dev server on port 5173 (in another terminal)
bun --cwd webapp install
bun --cwd webapp run dev
```

Open two browser tabs at `http://localhost:5173`. Tab A clicks *Open new
game (X)* — the deploy takes ~20 s and switches into the game board. Tab A
copies the contract address (Status panel → *copy*); Tab B pastes it into
*Join an existing game* and clicks *Restore as O*. The two tabs now share
the channel: clicks on the board send `SignedMove`s through the relay in
both directions in <100 ms. The Status panel polls `/api/state/:addr` every
3 s and shows live on-chain progress.

Action buttons appear contextually:
- *Settle on-chain* — enabled once your local log has more moves than
  `committedTurns`.
- *Claim result* — enabled once `challengeUntil` has elapsed.
- *Start timeout* / *Claim timeout* — for when the opponent goes silent.
- *Prove fraud* — lights up automatically if the opponent has sent two
  `SignedMove`s for the same turn (auto-detected via `detectEquivocation`).

The browser never holds the Midnight wallet — only the player's identity
secret and token-tree, both of which stay in `localStorage`. Every on-chain
call is a single POST to the relay.

> **Local-dev only.** The relay uses the genesis-funded seed
> (`0x0…01`); `localStorage` stores the player's `skP` unencrypted. Both
> are fine for a local demo, neither is safe for testnet or production.

## Key implementation details

- **Block-time units.** Substrate's Timestamp pallet is in seconds since
  epoch. `GameSession.settle` / `startTimeout` convert from `Date.now()` ms
  to seconds before calling the circuit.
- **Settle override invariant.** `settle` does NOT clear the board between
  calls — the loop body skips indices below `committedTurns` (those are
  already placed on chain). An override must therefore use *real* tokens at
  the right `(turn, cell)` indices, which only the actual player could have
  revealed. The natural `!board.member(c)` check on new indices catches any
  contradicting placement.
- **Indexer lag.** Between two sequential txs, the off-chain indexer needs
  to ingest the first tx before the second's call can be built against fresh
  state. The timeout test sleeps 20 s between `settle` and `startTimeout`.
- **`localSecret` witness.** Returned to the circuit from the player's
  private state (stored in the level DB). Each `GameSession` attaches with a
  distinct `privateStateStoreName` so X and O don't share secret storage.

## Out of scope (deliberate)

- Escrow / unshielded-token deposits / payout slashing (M3 in the spec).
  The contract is structured so escrow can be bolted on without re-architecting:
  add a `deposit` circuit, two boolean ledger flags, and a `claimPayout` that
  reads `winner` and uses the std-lib `sendUnshielded`.
- Web dApp UI (M4).
- Real multi-wallet e2e — the tests use one wallet for both players. The
  cryptographic separation (identity commitments, token roots, witness
  secrets) is what isolates the two players, not the on-chain submitter.

## References

- `IMPLEMENTATION_SPEC.md` (in `midnight-ref-ai/experiments/tic-tac-toe-channel/`).
- `midnight-ref-ai/compact/wasm/dist/standard-library.compact` — `merkleTreePathRoot`,
  `persistentHash`, `tokenType`, unshielded coin ops.
- `pe-bun-3/e2e/shared/contracts/midnight/contract-counter/` — the working
  pattern this project mirrors for compile/deploy/test wiring.
