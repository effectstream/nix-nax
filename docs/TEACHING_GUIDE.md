# Teaching guide: contract and browser-to-chain code

This guide explains the Midnight-specific path through Nix-Nax. The complete
game UI remains useful for running the example, but its rendering, animation,
AI, and game-engine internals are not prerequisites.

The source targets the Midnight 1.x / ledger-v8 compatibility family with
Compact 0.31.1 and midnight-js 4.1.1.

## A. Read the Compact contract

Start with [`../src/contract/NixNaxArena.compact`](../src/contract/NixNaxArena.compact).
Read it in this order:

1. `GameKeys` holds each player's public identity commitment and Merkle root.
   `GameDyn`, `boards`, `tops`, `reserves`, and `actionLogs` are public ledger
   state keyed by a client-generated `gameId`.
2. `playerId` hashes `gameId` with a private per-game secret. `callerMark`
   consumes the `localSecret` witness and proves that the caller knows X's or
   O's registered secret without publishing it.
3. `createGame` and `joinGame` register the two distinct identities and their
   precommitted one-time action-token roots.
4. `tokenLeaf` and `tokenIsUnder` bind a token to one game, absolute turn,
   action kind, cell, and size. A token from another game or action cannot be
   replayed under an honest canonical tree.
5. `settle` checks each token, applies up to eight actions, enforces reserves,
   stacking/removal/pass rules, stops at a win, and records the next turn.
6. `claimResult` uses the witness-backed identity to authorize the winner and
   mint one shielded reward. A draw can be finalized by either participant and
   mints nothing.

[`../src/contract/witnesses.ts`](../src/contract/witnesses.ts) implements the
single witness. The generated module under `src/contract/managed/` is created
by `npm run compact`; [`../src/contract/index.ts`](../src/contract/index.ts)
provides the stable import surface used by the TypeScript code.

### What the contract proves

The contract proves legal public state transitions and membership of each
revealed action capability under the recorded player's root. It authenticates
the winning caller through a private secret.

It does not prove that players followed the dice ceremony or agreed on a
single off-chain transcript. It cannot recover from a player who stops
participating. These are deliberate consequences of the cooperating-player
model, not guarantees to infer from Merkle membership.

## B. Follow the HTML and JavaScript/TypeScript chain path

[`../webapp/index.html`](../webapp/index.html) is the HTML entry document. Vite
compiles the TypeScript modules below to browser JavaScript. Read them in this
order:

1. [`../webapp/src/chain/env.ts`](../webapp/src/chain/env.ts) selects the network
   and its indexer, node, proof-provider, and arena configuration. A hosted
   build requires an address for its selected network; local development uses
   the generated `public/arena.json`.
2. [`../webapp/src/chain/compiled.ts`](../webapp/src/chain/compiled.ts) combines
   the generated contract class, witness implementation, and compiled circuit
   assets into the object midnight-js can deploy or attach to.
3. [`../webapp/src/wallet/connector.ts`](../webapp/src/wallet/connector.ts) and
   [`../webapp/src/wallet/useWallet.ts`](../webapp/src/wallet/useWallet.ts)
   discover browser wallets, request authorization, validate the selected
   network, and expose explicit connect/disconnect state.
4. [`../webapp/src/wallet/connector-adapter.ts`](../webapp/src/wallet/connector-adapter.ts)
   adapts the authorized extension API to midnight-js wallet and Midnight
   providers, including the balance, sign, submit, and transaction-identifier
   boundary. [`../webapp/src/chain/providers.ts`](../webapp/src/chain/providers.ts)
   assembles the indexer, private-state, ZK-configuration, proof, and wallet
   providers for either extension-wallet or local-development mode.
5. [`../webapp/src/chain/arena.ts`](../webapp/src/chain/arena.ts) resolves the
   arena address, attaches with the correct per-game private state, reads the
   public ledger, calls `createGame`, `joinGame`, `settle`, and `claimResult`,
   and waits for the submitted operation to appear in indexed contract state.
6. [`../webapp/src/wallet/submit.ts`](../webapp/src/wallet/submit.ts) provides
   small create/join convenience wrappers around the arena API and records the
   resulting status. It does not balance or sign extension-wallet transactions.

`webapp/src/ui/useChainActions.ts` connects those chain functions to the full
game's progress and error messages. You can stop reading there: `Board3D`, UI
layout, AI policy, and player-session ceremony code demonstrate the complete
application but are outside the Midnight lesson.

### One transaction from click to confirmation

```text
UI action
  -> arena API attaches the current game private state
  -> compiled contract consumes public arguments and any circuit witness
  -> proof provider proves the unproven transaction
  -> active wallet balances fees, signs, and submits
  -> public-data provider observes the operation in indexed contract state
  -> UI reports confirmed state or a recoverable error
```

Public contract state can be queried through the public-data provider without
revealing the player's per-game secret. A state-changing call attaches a
private-state provider containing the secret required by that circuit. In the
main contract, `claimResult` is the exported circuit that consumes
`localSecret`; create, join, and settle authenticate their supplied commitments
or action tokens instead.

### Wallet keys, witnesses, and the proof provider

An extension wallet keeps its spending keys behind the connector API. That does
not mean every private contract input stays hidden from the prover. The proof
provider receives the unproven transaction and circuit witness data needed to
produce a proof. Treat per-game secrets and revealed token material as
sensitive and use a trusted proof provider, usually one run locally or supplied
by the wallet.

### Persistence and transport limits

Private per-game identities and action trees must survive creation, joining,
reloads, and uncertain transaction confirmation. Losing them can make an
on-chain game impossible to resume or claim. The client therefore persists a
session before submitting registration and must never overwrite an existing
identity during reconnect.

The WebSocket relay carries only off-chain messages. It is not a chain backend
and does not pay gas. Before sending, the client durably records its own
protocol progress. When the relay opens again, it replays its last authored
move and any current intent or randomness response; a receiving PlayerSession
ignores an identical historical move instead of advancing twice. This repairs a lost final send when both players
reconnect, including after a relay restart.

The relay still does not authenticate room roles or reconcile arbitrary
histories. Divergent or corrupt saved turns, hostile role takeover, and relay
history-cap loss beyond the immediately replayable messages need an
authenticated turn/hash handshake, acknowledgements, and a broader protocol
redesign before this can be treated as robust public multiplayer transport.

## C. Keep the complete protocol separate

[`../advanced/README.md`](../advanced/README.md) contains the original complete
contract as a reference. It adds commitment trees, disputes, deadlines,
timeouts, and fraud-proof circuits, but four known defects invalidate its
security/liveness claims. It is excluded from default compilation and is not a
supported deployment. Study it only after the main contract and chain path.
