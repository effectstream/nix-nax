# Nix-Nax

A trustless, two-player **4×4 stacked-pieces game** on the [Midnight](https://midnight.network) blockchain, settled with **zero-knowledge proofs**. Moves are played **off-chain at memory speed** and only the result is committed on-chain — cheating is cryptographically provable, and the winner mints a shielded reward token.

> Source: **[github.com/effectstream/nix-nax](https://github.com/effectstream/nix-nax)**

It's a state channel: two players run the whole game peer-to-peer, then post a short, proof-backed summary to the chain. Nobody has to trust a server or each other — the contract and the proofs enforce the rules.

---

## The game

A Gobblet-style game on a **4×4 board**. Each player has **12 pieces** — 3 each of 4 sizes (0 = smallest … 3 = largest). A larger piece **covers** (gobbles) a smaller one on the same cell; the visible top piece is what counts. **Four in a row** (any row, column, or diagonal) wins.

Every turn opens with a **joint dice roll** (0–15) that decides the move type:

- roll **< 3** (~19%) → **remove** a piece (yours *or* your opponent's) from the board,
- otherwise (~81%) → **place** a piece.

Neither player controls the roll — it is the XOR of secret bits both sides committed before the game began (see [Randomness](#randomness-the-joint-roll)). The rules live in [`src/sdk/game/rules.ts`](src/sdk/game/rules.ts) and are mirrored exactly in-circuit.

---

## Quickstart

### Prerequisites

- **macOS or Linux** (ARM64 or x86_64)
- **[Bun](https://bun.sh/)** — package manager + script runner
- **Node.js** — runtime for the TypeScript SDK
- **[Compact toolchain](https://docs.midnight.network)** — `compact --version` must work; this project pins **`+0.30.0`** (the build invokes `compact compile +0.30.0`)
- The local Midnight stack (node, indexer, proof server) is downloaded and run for you by the `@effectstream/npm-midnight-*` dev dependencies.

### Run it locally

```bash
# 1. Install root dependencies
bun install

# 2. Compile the Compact contract  ->  src/contract/managed/
bun run compact

# 3. Start the local Midnight stack and wait for "Stack is up."
#    node :9944   indexer :8088   proof server :6300   (logs in .stack-logs/)
bun run stack:up

# 4. Deploy the arena contract  ->  writes webapp/public/arena.json
bun run deploy

# 5. Start the message relay on :4310 (a dumb WebSocket switchboard for moves).
#    Required for ALL play — even Practice-vs-AI marshals moves through it.
bun --cwd relay install
bun --cwd relay run start

# 6. Start the web client on :5173 (in another terminal)
bun --cwd webapp install
bun --cwd webapp run dev
```

Open **http://localhost:5173**, click the **Wallet** button (top-right) and use the **faucet** to fund an in-browser session wallet, then hit **New game**, **Join a game**, or **Practice vs AI**.

For a two-human game, both browsers point at the same relay + the same `arena.json`; one player creates a game and shares the **game id**, the other joins with it. Tear everything down with `bun run stack:down`.

> **Serverless by design.** There is no backend that holds keys or submits transactions. The **browser** builds, proves, and submits every on-chain call through an in-browser Midnight wallet, and pays its own gas. The relay only shuttles off-chain messages between the two players.

---

## How it works

### A state channel, not a per-turn ledger

Posting every move to a blockchain is slow and expensive: each move would be its own transaction, each needing a ZK proof and a block to land in. Nix-Nax avoids that almost entirely.

```mermaid
flowchart LR
  A["Lobby<br/>New game / Join / vs AI"] --> B["createGame / joinGame<br/>(on-chain: commit identities + Merkle roots)"]
  B --> C["Off-chain ceremony via relay<br/>intent → random → signed move"]
  C -- "repeat each turn (instant, free)" --> C
  C --> D["settle (on-chain)<br/>up to 8 moves/tx + Merkle proofs"]
  D --> E["Challenge window<br/>fraud proofs can slash a cheater"]
  E --> F["claimResult (on-chain)<br/>finalize + mint win-token to winner"]
```

Only a handful of call types ever touch the chain — `createGame` / `joinGame` to open a game, `settle`, `claimResult`, the `startTimeout` / `claimTimeout` forfeit path, and the fraud proofs. Everything else happens peer-to-peer over the relay ([`relay/server.ts`](relay/server.ts), [`src/sdk/crypto/signed-move.ts`](src/sdk/crypto/signed-move.ts)): the mover sends an **intent**, the opponent replies with a **random reveal**, and the mover broadcasts a **signed move** that hash-chains to the previous one. Each side verifies locally before accepting.

### The three Merkle trees

When a game opens, each player commits **three Merkle roots** on-chain (six roots total). They never reveal the trees — only a leaf + its path, when needed, and the contract checks it against the root. Every leaf binds the **`gameId`**, so nothing can be replayed into another game. A player's per-game identity is `playerId = persistentHash("gob:id:", gameId, localSecret)` ([`src/contract/witnesses.ts`](src/contract/witnesses.ts)), proven via the `localSecret` witness — no spoofable `ownPublicKey()`.

| Tree | Depth / leaves | One leaf per… | Commits | Source |
|------|----------------|---------------|---------|--------|
| **Token (T)** | 14 / 16,384 | legal action `(turn, kind, cell, size)` — 81/turn | a salted **one-time token** authorizing that exact action | [`token-tree.ts`](src/sdk/crypto/token-tree.ts) |
| **Index (I)** | 7 / 128 | turn | the mover's chosen **slot** + their **4 roll bits** | [`index-tree.ts`](src/sdk/crypto/index-tree.ts) |
| **Random (R)** | 11 / 2,048 | `(turn, slot)` — 128 × 16 | the responder's **randomness** + their **4 roll bits** | [`random-tree.ts`](src/sdk/crypto/random-tree.ts) |

The **Token tree** is what makes cheating provable: there is exactly one token per `(turn, kind, cell, size)`. To play a move you reveal its token + path; the contract verifies it under your root. Reveal *two different* actions for the same turn and you've published two valid tokens for one turn — that's **equivocation**, and it's instantly punishable (below).

### Randomness — the joint roll

Each turn's roll is built from **both** players' pre-committed bits, so neither can bias it:

```
roll = Σ ( bit_k(mover) XOR bit_k(responder) ) · 2^k     for k in 0..3   →  0..15
remove  iff  roll < ROLL_REMOVE_THRESHOLD (= 3)          otherwise  place
```

Because both the Index and Random trees are rooted on-chain *before any turn is played*, the bits are locked in at commit time. During a turn the mover reveals their I-leaf (which picks a `slot`), the responder reveals the R-leaf at `(turn, slot)`, and `roll = XOR` of the two 4-bit values. It's a commit-then-reveal coin flip neither side can steer ([`jointRollValue` / `classOfRoll`](src/sdk/game/rules.ts), mirrored in-circuit).

### Settling on-chain, in chunks

At the end (or whenever a player wants to checkpoint), `settle` replays the agreed move log on-chain, verifying each move's Token-tree proof and detecting the win. It commits **up to 8 moves per transaction**:

```ts
// src/sdk/game/rules.ts
export const SETTLE_CHUNK = 8;
// Settle commits up to this many moves per tx. 8 keeps the settle circuit
// within the node's per-block weight budget (16 exhausted it at deploy).
```

`settle` records each move's roll *class* **optimistically** — it does not re-verify the I/R bits in-circuit (that would double the proof size). Instead, correctness is backstopped by a **challenge window** and fraud proofs.

**Why this beats submitting every turn.** A per-turn design pays one proving transaction *per move* — up to ~128 a game, each a ZK proof plus a block. Nix-Nax plays the moves **off-chain (instant, free)** and posts only the moves that matter, **8 per `settle` tx**, ending the moment someone lines up four. So a game costs roughly `⌈moves / 8⌉` settle transactions plus one `claimResult`, instead of one transaction per turn — while the fraud-proof safety net preserves the same guarantees.

### Trust model — fraud proofs & timeouts

During the challenge window after a `settle`, the opponent can slash a cheater with a single proof (the game ends immediately against the cheater):

- **`proveWrongParity`** — the claimed roll class doesn't match the XOR of the committed I/R bits.
- **`proveEquivocationByX/O`** — two valid Token-tree leaves for the same turn.
- **`proveIndexEquivocationByX/O`** — two valid Index-tree leaves for the same turn.
- **`proveRandomEquivocationByX/O`** — two valid Random-tree leaves for the same `(turn, slot)`.

If a player simply goes silent, the other arms `startTimeout` and later `claimTimeout` to claim the forfeit. Once the window closes with no successful challenge, `claimResult` finalizes the outcome. All of this lives in [`src/contract/GobbletArena.compact`](src/contract/GobbletArena.compact).

---

## Win rewards — a shielded win-token

When a decided game's challenge window closes, the **winner** calls `claimResult(gameId, recipient)`, which finalizes the game and **mints exactly one shielded "win token"** to them:

```compact
mintShieldedToken(pad(32, "nixnax:win"), 1, nonce, left<...>(recipient));
```

- **Winner-only** for decided games (enforced by `callerMark` via the `localSecret` witness); **draws mint nothing**, and a unique per-game nonce means each game mints at most once.
- All wins share one token color, so **your balance of it = your number of wins**. The client derives the token type with `rawTokenType(pad32("nixnax:win"), contractAddress)` and reads it from the wallet's shielded balances ([`webapp/src/chain/arena.ts`](webapp/src/chain/arena.ts)).
- The UI shows **"🏆 Win tokens: N"** in the wallet panel and an "earned a win token" badge on the win overlay ([`WalletButton.tsx`](webapp/src/ui/WalletButton.tsx), [`GameView.tsx`](webapp/src/ui/GameView.tsx)); the loser isn't shown a (failing) Redeem button ([`useChainActions.ts`](webapp/src/ui/useChainActions.ts)).

---

## Project structure

```
src/contract/      GobbletArena.compact — the on-chain "arena" (hosts many games) + witnesses
src/sdk/           TypeScript SDK
  crypto/            persistent hash, the three Merkle trees, signed-move ceremony
  game/              rules + GameSession (build/verify moves, settle, disputes)
  wallet, providers  in-browser Midnight wiring (build / prove / submit)
scripts/           stack-up · stack-down · deploy
relay/             message-only WebSocket switchboard (server.ts)
webapp/            Vite + React client — builds, proves, and submits in the browser
test/              contract.sim + crypto (unit) · e2e/ (live-stack)
```

---

## Testing

```bash
bun run test       # unit: contract simulation + crypto — no chain needed (55 tests)
bun run test:e2e   # end-to-end against the live local stack (happy / fraud / timeout)
bun run typecheck  # tsc --noEmit
```

`bun run test` drives the compiled circuits in pure JS via `@midnight-ntwrk/compact-runtime` (open / settle / claimResult-with-mint / equivocation / timeout, plus crypto: Merkle trees, signed-move verification, serde). `bun run test:e2e` deploys to a real local chain and plays full scenarios — it needs `stack:up` running first.

---

## Tech stack

| Layer | What |
|-------|------|
| Contract | **Compact 0.30.0** (`GobbletArena.compact`) on **Midnight** |
| Chain access | **midnight-js** (contracts, providers, indexer) |
| Wallet | in-browser **WalletFacade** (`@midnight-ntwrk/wallet-sdk-*`, shielded + dust) |
| Client | **React + Vite + TypeScript** |
| Relay | **Bun** WebSocket service (message-only) |
| Tooling | **Bun**, **Vitest**, local Midnight stack via `@effectstream/npm-midnight-*` |

---

## A note on naming

The product is **Nix-Nax**. Internally the contract is **`GobbletArena`** (on-chain identifier **`gobblet-arena`**) because the game is Gobblet-style — that identifier and the `tictactoe-*` package names are load-bearing and intentionally unchanged.

## License

License: TBD.

## Further reading

- [Midnight docs](https://docs.midnight.network) · [Compact language](https://docs.midnight.network/develop/reference/compact).
