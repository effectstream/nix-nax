# Nix-Nax

![The Nix-Nax lobby: a 4×4 board floating in space, red and blue stacking pieces ranged along its edges, and the menu to start a new game, join one, or practice against the AI](docs/lobby.png)

A two-player **4×4 stacked-pieces game** on the [Midnight](https://midnight.network) blockchain, settled with **zero-knowledge proofs**. Moves are played **off-chain at memory speed** and only the result is committed on-chain. The winner mints a shielded reward token.

What the contract teaches, one concept at a time ([`src/contract/NixNaxArena.compact`](src/contract/NixNaxArena.compact)):

- **Ledger state**: `Map`s keyed by a client-generated `gameId`, so one deployment hosts any number of games.
- **Circuits + asserts**: `settle` replays the agreed moves and enforces every board rule in-circuit, so the chain can never hold an illegal position.
- **Merkle commitments**: each player commits ONE root (the token tree) at create/join; every settled move must reveal its salted one-time token + path, verified in-circuit with `merkleTreePathRoot` under the mover's root.
- **Witnesses + private identity**: `playerId = persistentHash("nixnax:id:", gameId, localSecret)`. The caller proves knowledge of their secret without revealing it; no spoofable public key.
- **Shielded tokens**: `claimResult` mints exactly one `nixnax:win` token to the winner; your balance of that color = your win count.

---

## The game

A stacked-pieces game on a **4×4 board**. Each player has **12 pieces**, 3 each of 4 sizes (0 = smallest … 3 = largest). A larger piece **covers** a smaller one on the same cell; the visible top piece is what counts. **Four in a row** (any row, column, or diagonal) wins.

Every turn opens with a **joint dice roll** (0–15) that decides the move type:

- roll **< 3** (~19%) → **remove** a piece (yours *or* your opponent's) from the board,
- otherwise (~81%) → **place** a piece.

Neither player controls the roll: it is the XOR of secret bits both sides committed before the game began (see [Randomness](#randomness-the-joint-roll-off-chain)). The rules live in [`src/sdk/game/rules.ts`](src/sdk/game/rules.ts) and are mirrored exactly in-circuit. (In the simplified contract the roll happens purely off-chain, and the chain trusts the agreed place/remove choice.)

---

## Quickstart

### Prerequisites

- **macOS or Linux** (ARM64 or x86_64)
- **[Bun](https://bun.sh/)** ≥ 1.1, the package manager and runtime that runs everything here (no Node.js required)
- **[Compact toolchain](https://docs.midnight.network)**: `compact --version` must work, **and** the pinned compiler must be installed: `compact update 0.31.1` (the build invokes `compact compile +0.31.1`, which does *not* auto-download it). The installer needs `xz-utils`, and installing a compiler version needs `unzip`. Both are present on most systems but absent from minimal images.
- **[Docker](https://docs.docker.com/get-docker/)** with Compose, which runs the local Midnight stack (node, indexer, proof server) from the official public images at the preview-target versions. Multi-arch, so it works on Apple Silicon too.

### Run it locally

```bash
# 1. Install root dependencies
bun install

# 2. Compile the Compact contract  ->  src/contract/managed/
bun run compact
#    (optional) confirm your keys match the deployed contract (see below):
#    bun run keys:verify

# 3. Start the local Midnight stack (Docker) and wait for the containers healthy.
#    node :9944   indexer :8088   proof server :6300
bun run stack:up

# 4. Deploy the arena contract  ->  writes webapp/public/arena.json
bun run deploy

# 5. Start the message relay on :4310 (a dumb WebSocket switchboard for moves).
#    Required for ALL play; even Practice-vs-AI marshals moves through it.
#    NOTE: use `cd <dir> && bun …`; `bun --cwd relay install` is (mis)parsed as
#    `bun run install` by current Bun and fails with "Script not found".
(cd relay && bun install && bun run start)     # relay has no deps; install is a no-op

# 6. Start the web client on :5173 (in another terminal)
(cd webapp && bun install && bun run dev)
```

Open **http://localhost:5173**, click the **Wallet** button (top-right) and use the **faucet** to fund an in-browser session wallet, then hit **New game**, **Join a game**, or **Practice vs AI**.

For a two-human game, both browsers point at the same relay + the same `arena.json`; one player creates a game and shares the **game id**, the other joins with it. Tear everything down with `bun run stack:down`.

> **No game backend.** Nothing server-side holds keys, owns game state, or submits transactions: the **browser** builds every on-chain call through an in-browser Midnight wallet, signs it, submits it to the node, and pays its own gas. The relay only shuttles off-chain messages between the two players.
>
> It is *not* dependency-free, though. Two external services are required, and both are in the Quickstart above: a **node** (+ indexer) to talk to the chain, and a **proof server** that actually generates the zero-knowledge proofs. The browser hands it the unproven transaction over HTTP (`httpClientProofProvider`) and gets the proof back. A connected extension wallet may supply its own proof server, in which case that one is used. The proof server sees the transaction's witness data but never your wallet keys, which is why it is normally run locally or by your wallet rather than by whoever hosts the site.

---

## How it works

### Off-chain play, on-chain settlement

Posting every move to a blockchain is slow and expensive: each move would be its own transaction, each needing a ZK proof and a block to land in. Nix-Nax avoids that almost entirely.

```mermaid
flowchart LR
  A["Lobby<br/>New game / Join / vs AI"] --> B["createGame / joinGame<br/>(on-chain: commit identity + token root)"]
  B --> C["Off-chain ceremony via relay<br/>intent → random → signed move"]
  C -- "repeat each turn (instant, free)" --> C
  C --> D["settle (on-chain)<br/>up to 8 moves/tx + token proofs,<br/>board rules re-checked"]
  D --> E["claimResult (on-chain)<br/>finalize + mint win-token to winner"]
```

Exactly **four circuits** touch the chain: `createGame` / `joinGame` to open a game, `settle`, and `claimResult`. Everything else happens peer-to-peer over the relay ([`relay/server.ts`](relay/server.ts), [`src/sdk/crypto/signed-move.ts`](src/sdk/crypto/signed-move.ts)): the mover sends an **intent**, the opponent replies with a **random reveal**, and the mover broadcasts a **signed move** that hash-chains to the previous one. Each side verifies the game rules locally before accepting.

### The token tree: one Merkle commitment per player

When a game opens, each player commits **one Merkle root** on-chain: the root of their **token tree**, one salted leaf per legal action `(turn, kind, cell, size)`, 81 per turn, depth 14 / 16,384 leaves ([`token-tree.ts`](src/sdk/crypto/token-tree.ts)). The tree is never revealed: to settle a move you reveal just that move's **one-time token** (its salt) plus a Merkle path, and the contract recomputes the leaf with `persistentHash` and checks it sits under your committed root with `merkleTreePathRoot`. Every leaf binds the `gameId`, so nothing replays across games. (The [complete version](#simplified-vs-complete-contract) commits two MORE trees per player to make the dice roll provable.)

### Identity: a witness, not a public key

A player's per-game identity is `playerId = persistentHash("nixnax:id:", gameId, localSecret)`, computed by the `playerId` circuit in [`NixNaxArena.compact`](src/contract/NixNaxArena.compact), fed by the `localSecret` **witness** implemented in [`witnesses.ts`](src/contract/witnesses.ts) and mirrored client-side by `computePlayerId` in [`persistent-hash.ts`](src/sdk/crypto/persistent-hash.ts). The secret enters the circuit privately and never appears on-chain. That is how `claimResult` stays winner-only without any spoofable `ownPublicKey()`.

### Randomness: the joint roll (off-chain)

Each turn's roll is built from **both** players' bits, so neither can bias it:

```
roll = Σ ( bit_k(mover) XOR bit_k(responder) ) · 2^k     for k in 0..3   →  0..15
remove  iff  roll < ROLL_REMOVE_THRESHOLD (= 3)          otherwise  place
```

The clients still run the full commit-then-reveal ceremony from the [complete version](#simplified-vs-complete-contract) (each side pre-commits its bits in local Merkle trees, and reveals leaves per turn), so the dice stay fair between honest players ([`jointRollValue` / `classOfRoll`](src/sdk/game/rules.ts)). The simplified **contract** does not re-verify any of it; it trusts the agreed place/remove classes.

### Settling on-chain, in chunks

At the end (or whenever a player wants to checkpoint), `settle` replays the agreed move log on-chain, **up to 8 moves per transaction** (`SETTLE_CHUNK` in [`rules.ts`](src/sdk/game/rules.ts)), verifying each move's one-time token under the mover's committed root, enforcing every board rule in-circuit (reserves, stacking, removals, pass legality), and detecting the win. So a game costs `createGame + joinGame + ⌈moves / 8⌉ settles + claimResult`, instead of one transaction per turn.

### Trust model: the players

**The simplified contract trusts the players.** It guarantees the board can never reach an illegal position (a buggy client can't corrupt a game) and that every settled move was authorized by the mover's own commitment (the token proof), but it does not try to catch a *lying* one: there are no fraud proofs, no roll verification or dispute, no timeouts, and no challenge windows. If your opponent disappears mid-game, the game simply never finishes. For how all of that is solved when players are NOT trusted (equivocation slashing over the token tree, two extra committed trees making the dice roll provable, the optimistic roll class with its dispute protocol, and timeout forfeits), see [Simplified vs complete contract](#simplified-vs-complete-contract).

---

## Win rewards: the shielded win-token

When a game is decided, the **winner** calls `claimResult(gameId, recipient)` (immediately; there is no waiting window in this version), which finalizes the game and **mints exactly one shielded "win token"** to them:

```compact
mintShieldedToken(pad(32, "nixnax:win"), 1, nonce, left<...>(recipient));
```

- **Winner-only** for decided games (enforced by `callerMark` via the `localSecret` witness); **draws mint nothing**, and a unique per-game nonce means each game mints at most once.
- All wins share one token color, so **your balance of it = your number of wins**. The client derives the token type with `rawTokenType(pad32("nixnax:win"), contractAddress)` and reads it from the wallet's shielded balances ([`webapp/src/chain/arena.ts`](webapp/src/chain/arena.ts)).
- The count is shown as **"Wins: 🏆 N"** in the wallet panel and on the wallet chip, as a **"Win tokens"** readout in the in-game HUD, and as a **"🏆 You earned a win token!"** line on the win overlay ([`WalletButton.tsx`](webapp/src/ui/WalletButton.tsx), [`GameView.tsx`](webapp/src/ui/GameView.tsx)); the loser isn't shown a (failing) Redeem button ([`useChainActions.ts`](webapp/src/ui/useChainActions.ts)).

---

## Project structure

```
src/contract/      NixNaxArena.compact: the on-chain "arena" (hosts many games) + witnesses
src/sdk/           TypeScript SDK
  crypto/            persistent hash, the three Merkle trees, signed-move ceremony
  game/              rules + shared move/messaging codecs
  wallet, providers  in-browser Midnight wiring (build / balance / submit; proofs via proof server)
scripts/           deploy · deploy-network · upgrade-arena · faucet · verify-keys
                   (stack:up / stack:down are docker-compose package.json scripts)
relay/             message-only WebSocket switchboard (server.ts)
webapp/            Vite + React client: builds and submits in the browser (proof server does the proving)
test/              contract.sim + crypto (unit) · e2e/ (live-stack)
```

---

## Testing

```bash
bun run test       # unit: contract simulation + crypto, no chain needed (52 tests)
bun run test:e2e   # end-to-end against the live local stack (happy paths)
bun run typecheck  # tsc --noEmit
```

`bun run test` drives the compiled circuits in pure JS via `@midnight-ntwrk/compact-runtime`: lifecycle, every board rule per action kind, wins on rows/columns/diagonals, the 128-turn draw, and `claimResult` authorization (winner-only mint, draw by either, double-claim rejection). `bun run test:e2e` deploys to a real local chain and plays full games (single- and multi-chunk settles, asserting the win-token actually mints). It needs `stack:up` running first; the suite deploys its own arena (`nixnax.e2e.json`) so it never clobbers the main one.

---

## Deploying to a real network (preview / preprod / mainnet)

All configuration lives in **one root `.env`** (copy [`.env.example`](.env.example)):

- **`MIDNIGHT_*`**: read at runtime by the Node scripts (deploy, stack, e2e). `MIDNIGHT_WALLET_SEED` is the only secret.
- **`VITE_*`**: baked into the webapp bundle at `vite build` time (public, not secrets). The arena address and chain endpoints are **suffixed per network** (`VITE_ARENA_ADDRESS_PREVIEW`, `VITE_INDEXER_URL_MAINNET`, …) so one `.env` holds every network; **`VITE_NETWORK_ID`** selects which row a build targets. With nothing set, everything defaults to the local `undeployed` stack.

Per network, deploy the contract once with that network's `MIDNIGHT_*` endpoints (`bun run deploy` prints the `VITE_ARENA_ADDRESS_<NETWORK>=…` line to record), then build the webapp with `VITE_NETWORK_ID` set to that network. On real networks the in-browser session wallet/faucet and genesis wallet are disabled; players connect a browser-extension wallet and pay their own gas. Endpoints must be `https`/`wss` when the site is served over TLS.

For a Linux server, **[`deploy/SERVER_SETUP.md`](deploy/SERVER_SETUP.md)** is the full runbook: clone, install toolchains, compile, start the chain stack, deploy the arena, and serve the webapp, with per-step verification. Supporting files: [`deploy/nginx.conf.example`](deploy/nginx.conf.example) (serves `webapp/dist`, aliases the ~49 MB of compiled ZK assets at `/contract/compiled/nixnax-arena/`, proxies the `/relay` WebSocket) and [`deploy/nixnax-relay.service`](deploy/nixnax-relay.service) (systemd unit for the relay).

---

## Known issues

### Single-move `settle` rejected by the node (`FeeCalculation`): needs an upstream fix

**Symptom.** A `settle` that carries **only one move** can be rejected from the mempool with `Malformed(MalformedError::FeeCalculation)` ("exceeded the maximum time to dismiss for transaction size") and surfaces client-side as `1010: Invalid Transaction: Custom error: 168` / `SubmissionError`. It never reaches contract execution. The trigger is a settle transaction that is too *small* for its (constant) verification time. It was observed for the first 1-move settle of a game in the complete version, and for every 1-move settle in an interim build without token-path payloads.

**Root cause (not the contract).** The fee the wallet/`midnight-js` balancing attaches and the fee the node's cost model demands disagree for the smallest possible settle transaction (minimal state reads + a single write). We verified this is **not** a contract bug and **not** related to Merkle/trie insertion cost:

- the same 1-move settle passes in the circuit simulator (no fee layer);
- a 1-move settle succeeds on-chain once the game already has committed state (a 1-move settle on turn 4, on a *deeper* ledger trie, passes, so depth is not the trigger);
- any multi-move settle passes (it performs a *superset* of the same trie inserts).

So the defect lives in the fee layer (the wallet SDK's estimate or the node's validator-side calculation) and needs fixing **upstream** (Midnight wallet SDK / node), not here.

**Workaround.** Batch every settle with **≥ 2 moves**: the client chunker rebalances tails (…7+2 instead of 8+1, [`player-session.ts`](webapp/src/game/player-session.ts)). This is a client-side batching choice, not a contract rule; the contract accepts single-move settles (`assert(n > 0)`). A settle whose *total* new history is a single move cannot be worked around client-side until the upstream fix. (The isolating experiment lived in the complete version's `test/e2e/timeout.test.ts`; see the `advanced` tag.)

---

## Tech stack

| Layer | What |
|-------|------|
| Contract | **Compact 0.31.1** (`NixNaxArena.compact`) on **Midnight** |
| Chain access | **midnight-js** (contracts, providers, indexer) |
| Wallet | in-browser **WalletFacade** (`@midnight-ntwrk/wallet-sdk-*`, shielded + dust) |
| Client | **React + Vite + TypeScript** |
| Relay | **Bun** WebSocket service (message-only) |
| Tooling | **Bun**, **Vitest**, local Midnight stack via **Docker** (official preview images) |

> **Version compatibility.** The compiler, JS runtime, and SDKs are pinned as a **coherent set** targeting the Midnight **preview** network, and they must move together (the compiler determines the verifier-key/ledger format the runtime and proof server must match). Current pins:
>
> | Component | Version | | Component | Version |
> |---|---|---|---|---|
> | Compact compiler (`+`) | 0.31.1 | | `@midnight-ntwrk/ledger-v8` | 8.1.0 |
> | Compact devtools (`compact`) | 0.5.1 | | `@midnight-ntwrk/onchain-runtime-v3` | 3.0.0 |
> | `@midnight-ntwrk/compact-runtime` | 0.16.0 | | `@midnight-ntwrk/midnight-js-*` | 4.1.1 |
> | `@midnight-ntwrk/compact-js` | 2.5.1 | | `@midnight-ntwrk/wallet-sdk-*` (set) | facade 4.1.0, dust-wallet 4.2.0, capabilities 3.3.1, address-format 3.1.2, unshielded 3.1.0, shielded 3.0.2, hd 3.0.3, abstractions 2.1.0 |
>
> Preview network components: node 1.0.0, indexer 4.3.3, proof server 8.1.0. `bun run stack:up` runs exactly these versions locally from the official public Docker images (see [`deploy/docker`](deploy/docker/README.md)).
>
> **Reproducible keys.** `compact compile +0.31.1` is deterministic: the same compiler + source produce byte-identical prover/verifier keys. So a frontend built from this source generates proofs that verify against the verifier keys installed on-chain at deploy. `bun run keys:verify` checksums your compiled `src/contract/managed/keys/*` against the committed manifest [`src/contract/keys.sha256`](src/contract/keys.sha256) and fails on any drift. Run it after `bun run compact` to confirm your build produces the same circuits as this source. The manifest holds 8 entries (prover + verifier for each of the 4 circuits) and tracks *this* contract; it is not a record of any hosted deployment, so it must be regenerated whenever the contract changes.

---

## A note on naming

The product is **Nix-Nax**; the contract is **`NixNaxArena`** (on-chain identifier **`nixnax-arena`**). Package names, private-state store/DB names, and `nixnax:*` localStorage keys all follow the same `nixnax` naming.

## License

Licensed under either of

- Apache License, Version 2.0 ([`LICENSE-APACHE`](LICENSE-APACHE) · <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([`LICENSE-MIT`](LICENSE-MIT) · <http://opensource.org/licenses/MIT>)

at your option. SPDX: `MIT OR Apache-2.0`.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this work by you, as defined in the Apache-2.0 license, shall
be dual licensed as above, without any additional terms or conditions.

## Further reading

- [Midnight docs](https://docs.midnight.network) · [Compact language](https://docs.midnight.network/develop/reference/compact).

## Watch it play

A game against the built-in AI on a local stack: rolling the joint dice, placing and covering pieces, settling the agreed history on-chain, and the win-token counter in the HUD.

https://github.com/user-attachments/assets/3cd7e9cd-d4c9-43f1-8d64-315e642a9e99

---

## Simplified vs complete contract

The contract in this repo is the **simplified** one, written to be taught. The **complete** one, the original fully trustless state channel, is preserved at the git tag **`advanced`**.

The game is identical in both. What differs is how much the chain is willing to believe.

**Simplified** trusts the two players not to cheat. That single assumption deletes the fraud proofs, the roll dispute, the timeout/forfeit path, the challenge windows, and two of the three Merkle trees, leaving **4 circuits** you can read in one sitting. It still refuses to hold an illegal position: every board rule is checked in-circuit, and every settled move must reveal a one-time token committed before the game began. What it will not do is catch a player who lies about the dice, or rescue a game whose opponent walks away.

**Complete** assumes the opposite and pays for it: **18 circuits**, three committed trees per player, and an optimistic settle backed by fraud proofs, so cheating is provable on-chain and a silent opponent forfeits.

|  | simplified | complete (`advanced`) |
|---|---|---|
| Contract | 459 lines, 4 circuits | 1111 lines, 18 circuits |
| Merkle roots committed per player | 1 (token) | 3 (token, index, random) |
| `settle` circuit size | k=15 | k=17 |
| Dice roll | agreed off-chain, trusted by the chain | committed up front, provable on-chain |
| Cheating | not detected on-chain | provable and slashable |
| Abandoned game | never finishes | resolved by timeout forfeit |

Two ways to reach the complete version:

- **To run it**: `git checkout advanced`, a self-consistent snapshot of the whole repo at that design.
- **To read it side by side**: [`src/contract/NixNaxArena.advanced.compact`](src/contract/NixNaxArena.advanced.compact), kept here for exactly that. It still compiles on its own, but it is **reference only** and will not build into this repo: the witness it needs (`wit_divMod2`), the deploy stub's ledger layout, the constructor's `minWindow` argument, the `MIN_*_SECS` constants and the multi-variant settle client were all removed alongside the machinery they served.

Read the simplified contract first, then the complete one to see what removing trust costs.
