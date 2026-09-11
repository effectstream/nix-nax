# Known issues

> **Before opening an issue:** Verify that the item still applies to the current
> code and environment. Include reproduction steps, exact software versions,
> and relevant logs with the report.

- The client durably saves its own protocol progress before sending and, when
  the relay opens again, replays its last authored move plus any current intent
  or randomness response. A receiving client ignores an identical historical
  move instead of advancing twice. This recovers the bounded case where the final send is lost and both players
  reconnect, including after a relay restart. It is not a general history
  reconciliation protocol: divergent or corrupt saved histories, or relay
  history-cap loss beyond the immediately replayable messages, still require
  an authenticated turn/hash handshake and acknowledgement protocol.
- Relay room roles are not authenticated. Anyone who learns a game ID can claim
  an existing role and disconnect that socket. One-time action commitments
  still protect on-chain settlement, but the bundled relay is suitable for
  local/demo coordination, not an availability-sensitive public service.
- On a fresh local stack using `midnight-node:1.0.0` with `ledger-v8:8.1.0`,
  three attempts at one legal opening-move `settle` were rejected by the node
  as `Malformed(FeeCalculation)`. This is a measured limitation of that tested
  stack, not a claim about every deployment. The client batches settlement when
  possible; a history containing only one move has no client-side workaround.
