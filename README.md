# Nix-Nax on Midnight

Nix-Nax is a browser game that demonstrates a Compact contract and
wallet-driven chain interaction on Midnight. The React and Three.js game is
the runnable main example.

RED and BLUE take turns on a 4×4 board, aiming to show four visible top pieces
of their color in a row, column, or diagonal. The first turn places a piece; on
later turns a joint die roll determines whether to place or remove. A larger
piece can cover a smaller one of either color, and a remove turn can take the
visible top piece of either color.

Players exchange live moves and dice information off-chain. They submit move
batches through a wallet to Midnight, where the Compact contract validates and
settles them. An on-chain claim finalizes the result and mints a shielded win
token when there is a winner.

This design aims for millisecond-scale multiplayer interaction while keeping
batched moves verifiable on-chain. Sending each move as a separate on-chain
transaction would make turns wait for proving and confirmation, which can take
several seconds or longer.

- Play a complete two-player stacking game or practise against the local AI.
- Create and join games, submit settlements, and claim results through a browser
  wallet.
- Study a Compact contract that checks batched moves and mints a shielded win
  token.

![The Nix-Nax lobby: a 4×4 board floating in space, red and blue stacking pieces ranged along its edges, and the menu to start a new game, join one, or practice against the AI](docs/lobby.png)

## Requirements

- Node.js 22.23.2 for Vite, Vitest, TypeScript, and production builds (`.nvmrc`)
- Bun 1.3.11 for dependency installation, the relay, and deployment scripts
- Compact compiler 0.31.1
- Docker with Compose for the local Midnight 1.x development network

The compiler and JavaScript packages target the Midnight 1.x / ledger-v8
family. Upgrade them as one compatibility set.

## Run locally

Install both locked dependency sets:

```bash
bun install --frozen-lockfile
(cd webapp && bun install --frozen-lockfile)
```

Compile the contract and verify the generated proving and verification keys:

```bash
npm run compact
bun run keys:verify
```

Start the local chain services and deploy a fresh arena. Deployment writes the
local address to `webapp/public/arena.json`:

```bash
bun run stack:up
bun run deploy
```

Run the message relay and browser client in separate terminals:

```bash
(cd relay && bun run start)
(cd webapp && npm run dev)
```

Open <http://localhost:5173>. Use the Wallet menu to fund a local session
wallet, then create, join, reconnect to, or practise against the AI. A
two-player game needs both browsers to use the same arena and relay.

Stop the local chain when finished:

```bash
bun run stack:down
```

## On-chain game flow

Exactly four circuits mutate the main contract:

1. `createGame` stores X's private-identity commitment and action-token root.
2. `joinGame` adds O's distinct identity and token root.
3. `settle` verifies up to eight committed actions and applies the game rules.
4. `claimResult` requires the winning player's private identity secret,
   finalizes the game, and mints one shielded win token. Either player may
   finalize a draw, which mints no token.

The browser builds these calls and pays through its active wallet.

## Project layout

```text
src/contract/       Main Compact contract, witness adapter, generated bindings target
src/sdk/            Shared commitments, rules, wallet, provider, and deployment helpers
webapp/index.html   Browser entry document
webapp/src/chain/   Typed contract API, providers, public reads, calls, attachment cache
webapp/src/wallet/  React-free wallet state, React adapter, balancing, signing, submission
webapp/src/game/    Supporting session/game implementation (outside the lesson)
webapp/src/ui/      React/Three.js presentation plus focused integration hooks
relay/              Bun WebSocket message relay
test/               Contract simulator, crypto, and local-ledger tests
advanced/           Maintained dispute-capable contract, SDK, tests, and limits
deploy/             Local-stack and hosted deployment material
```

## Trust model

The main contract is designed for **cooperating players**. Moves happen
off-chain and are settled in batches. The contract guarantees that settled
board transitions are legal and that each move presents a one-time capability
committed by its player when the game opened.

It does not verify the off-chain dice ceremony, detect a player who lies about
the agreed action class, or force an absent opponent to continue. It has no
fraud proofs, roll disputes, challenge windows, or timeout forfeits. A stalled
or disagreeing game may remain unfinished.

The relay carries and temporarily retains disclosed protocol messages,
including move tokens and randomness reveals. It does not receive wallet
spending keys or unrevealed game-identity secrets, build chain transactions, or
pay gas.

The configured proof provider receives the transaction and the private circuit
inputs needed to produce a proof. It does not receive an extension wallet's
spending keys through this application, but witness values can still be
sensitive. Use a proof provider you trust, normally one run locally or supplied
by the wallet.

For the separate dispute-capable contract, its checks, and deployment beyond the
local network, see [Advanced topics](docs/ADVANCED_TOPICS.md).

## Checks

After compiling the contract, run the checks with Node:

```bash
npm test
npm run test:webapp
npm run typecheck
npm run typecheck:webapp
npm run build:webapp
```

The main local-ledger suite additionally needs a fresh Docker stack and the
binary circuit artifacts generated by `npm run compact`:

```bash
npm run test:e2e
```

CI performs frozen dependency installs, full main and advanced Compact
compilation, both key-manifest checks, the explicitly bounded main, advanced,
and browser-module test suites, all TypeScript checks, and the production web
build. Local-ledger E2E remains an explicit longer-running check.

For operational limitations and guidance on verifying them before reporting an
issue, see [Known issues](docs/KNOWN_ISSUES.md).

## License

Licensed under either of

- Apache License, Version 2.0 ([`LICENSE-APACHE`](LICENSE-APACHE))
- MIT license ([`LICENSE-MIT`](LICENSE-MIT))

at your option. SPDX: `MIT OR Apache-2.0`.
