# Advanced protocol topic

The maintained contract in [`contract/NixNaxArena.compact`](contract/NixNaxArena.compact)
is a standalone advanced topic for readers who want to study an optimistic,
dispute-capable Nix-Nax protocol. The main teaching example remains the complete
game UI plus the smaller cooperating-player contract and JavaScript wallet/chain
boundary. The advanced contract is deliberately not wired into that UI.

This revision repairs four findings from the source-readiness review:

1. I and R Merkle proofs must occupy their canonical positions: `I(t)` is at
   index `t`, and `R(t, slot)` is at index `16*t + slot`.
2. Every caller-supplied deadline is inside a constructor-sealed interval. The
   default advanced deployment uses a 600-second minimum and 3600-second
   maximum; the constructor also caps the maximum at seven days.
3. A pending roll dispute takes precedence over move and entropy timeouts. A
   timeout decision preserves any still-open challenge right for earlier
   optimistic history.
4. The current mover can request its responder's committed R leaf. The responder
   can publish the complete proof on-chain before the deadline; withholding it
   forfeits the game to the mover.

These are tested protocol invariants, not a formal security proof.

## State and transitions

Each game stores player identities, action-token roots, index roots, random roots,
board/reserve state, the committed action log, and its current decision/timers.
The following advanced state is also public:

- `rollAnswered[gameId][turn]` records a resolved optimistic roll-class dispute.
- `entropyRequests[gameId]` records one pending `(turn, slot, respondBy)` request.
- `entropyResponses[gameId][turn]` retains the disclosed R bits, random value,
  slot, leaf and Merkle directions/siblings so any client can reconstruct and
  verify the responder's proof.

Player identity secrets, action capabilities and undisclosed I/R preimages remain
off-chain until a circuit needs them. Entries written to `entropyResponses` are
durable public ledger state; do not treat those stored R values or Merkle paths
as secret. Other disclosed circuit arguments are not copied into that response
map, so this document does not claim durable raw-argument availability for them.

The main flows are:

1. `createGame` and `joinGame` register per-game identities and roots.
2. `settle2`, `settle`, or `settle11` append a nonempty legal action-log chunk
   and set a bounded optimistic challenge deadline.
3. The waiting player may arm one nonreplaceable move timeout. A legal settlement
   clears it.
4. A responder may open one roll challenge for a committed turn. A correct answer
   clears it. An invalid or contradictory answer rejects; after the response
   cutoff, the responder can claim the mover's forfeit.
5. The current mover may call `requestEntropy` for exactly the next turn. Anyone
   can call `answerEntropy` with the responder's canonical proof. If no answer is
   published in time, anyone can call `claimEntropyTimeout` and the mover wins.
6. A winner calls `claimResult` after every applicable optimistic challenge
   deadline and receives one token of the arena's stable win-token class. A
   per-game nonce prevents a game from minting that reward twice.

Answers are valid strictly before their stored cutoff. Timeout/forfeit claims are
valid at or after it. A roll challenge opened before an optimistic cutoff may be
resolved after that cutoff, while new challenges and fraud proofs reject at the
cutoff. Cryptographically proven fraud is terminal; optimistic and timeout
outcomes retain any applicable earlier challenge window.

## Build and test

This repository targets Midnight 1.x, Compact 0.31.1, Node 22.23.2 and Bun
1.3.11. Install from the committed lockfile, then run:

```sh
bun install --frozen-lockfile
npm run compact:advanced
npm run keys:verify:advanced
npm run typecheck:advanced
npm run test:advanced
```

`test:advanced` runs the Compact simulator and shared TypeScript crypto/rules
checks. The default `npm test` and `npm run compact` commands continue to cover
the main cooperating-player contract.

The local-ledger acceptance test requires the official local node 1.0.0,
indexer 4.3.3 and proof server 8.1.0 plus full proving artifacts:

```sh
npm run test:e2e:advanced
```

That maintained command runs the three focused repaired-protocol scenarios:
roll answer plus public entropy reuse and optimistic reward; entropy withholding
plus correct-mover forfeit and reward; and an actual `settle11` submission. Other
historical files under `advanced/test/e2e` are retained as optional diagnostics
and were not executed as part of this repair's live acceptance run.

Use a fresh database and deployment file for every validation run. The advanced
deployment helper intentionally has no in-place verifier-key upgrade path.
Persisted reuse succeeds only when the requested sealed min/max configuration
matches and `findDeployedContract` verifies the maintained local verifier keys
against the chain.

## Breaking deployment change

This revision changes the constructor from one window argument to two, adds
entropy request/response ledgers, and changes timeout/dispute behavior. Its ABI
and ledger layout are incompatible with the historical advanced deployment.
Deploy a fresh advanced arena and regenerate its contract artifacts and keys.
Do not attach these circuits to an old advanced address or copy its deployment
JSON into a new environment.

## Current limits

- The advanced topic has maintained contract, SDK and local-ledger tests but no
  production UI integration.
- The contract checks the specified game rules and dispute evidence. It has not
  received a formal audit and does not establish general protocol security.
- Public response storage provides R-data availability for the requested leaf;
  clients still need reliable message exchange and local persistence for the
  wider off-chain ceremony and signed history.
- Settlement remains optimistic. Challenge participants must monitor the chain
  and act within the configured windows.
- Constructor bounds prevent caller-created infinite deadlines, while operators
  must still choose min/max values suitable for proving and confirmation latency.
- Midnight.js creates a maintenance signing key when the arena is deployed and
  stores it in the deployer's private-state provider. That authority remains
  after initial verifier-key insertion and can remove or replace circuit verifier
  keys or transfer the authority. Users must trust the arena maintainer and its
  key custody; the protocol does not lock or decentralize this authority.
- Historical node-weight observations for settle variants do not automatically
  apply after this repair. Consult the generated circuit metadata and current
  local-ledger evidence before changing the maintained `settle2`/`settle`/
  `settle11` variants.

## Provenance

- Source repository: [`effectstream/nix-nax`](https://github.com/effectstream/nix-nax)
- Source snapshot that first carried the side-by-side reference:
  [`862218219c4489011b5d6e99509acfbab2f0607b`](https://github.com/effectstream/nix-nax/commit/862218219c4489011b5d6e99509acfbab2f0607b)
- Original complete-repository snapshot: tag
  [`advanced`](https://github.com/effectstream/nix-nax/tree/advanced), commit
  [`8b1b7a337cf67cd923ffaf93a3f61bf6786d9984`](https://github.com/effectstream/nix-nax/commit/8b1b7a337cf67cd923ffaf93a3f61bf6786d9984)

The restored contract, witnesses and tests retain the original Nix-Nax author
attribution and the repository's `MIT OR Apache-2.0` license choice.
