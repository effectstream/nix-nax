# Advanced contract reference

The contract in [`contract/NixNaxArena.compact`](contract/NixNaxArena.compact)
is the earlier, complete Nix-Nax protocol. It is preserved for comparison with
the cooperative-player contract used by the main example.

This folder is **reference-only**. It is not compiled, deployed, or tested by
the default commands, and it must not be presented or deployed as a sound or
trustless protocol. Its state machine needs a separate redesign and security
review before it can become a supported example.

## Provenance

- Source repository: [`effectstream/nix-nax`](https://github.com/effectstream/nix-nax)
- Source snapshot that first carried this side-by-side reference: [`862218219c4489011b5d6e99509acfbab2f0607b`](https://github.com/effectstream/nix-nax/commit/862218219c4489011b5d6e99509acfbab2f0607b)
- Original complete-repository snapshot: tag [`advanced`](https://github.com/effectstream/nix-nax/tree/advanced), commit [`8b1b7a337cf67cd923ffaf93a3f61bf6786d9984`](https://github.com/effectstream/nix-nax/commit/8b1b7a337cf67cd923ffaf93a3f61bf6786d9984)

Before the source dual-license header was prepended, the contract body was
byte-for-byte the same as `src/contract/NixNaxArena.compact` at the
`advanced` tag. The main repository does not include the historical advanced
SDK, witnesses, generated bindings, or tests, so this contract cannot be
substituted into the main build.

## Known protocol limitations

The readiness review found four protocol defects in this reference:

1. **A responder can choose the roll after seeing the mover's bits.** The
   contract checks Merkle membership for random leaves but does not bind each
   reveal to its canonical `(turn, slot)` path position. A malicious root can
   contain several answers for the same semantic position.
2. **A settler can lock a result behind an arbitrary future deadline.** The
   challenge and response deadlines have minimums but no protocol-defined
   upper bounds. Anyone holding the move data can submit a legitimate winning
   history with a deadline that prevents timely reward redemption.
3. **A move timeout can erase an unresolved roll dispute.** The timeout path
   can award the game to the challenged player and clear the dispute before
   the challenged roll evidence is supplied.
4. **A responder can withhold the randomness contribution needed by the
   mover.** The state machine has no circuit that lets an honest mover compel
   the responder to reveal its selected committed random leaf or forfeit.

The first three defects were reproduced in Compact simulator tests during the
migration review. The fourth follows from the exported circuit/state-machine
paths. Fixing them requires protocol work: canonical path enforcement, bounded
deadlines, explicit dispute precedence, and an enforceable responder
obligation. Those changes require a separate source change and regression suite.

## Relationship to the main example

The main contract in [`../src/contract/NixNaxArena.compact`](../src/contract/NixNaxArena.compact)
uses an explicit cooperating-player model. It checks legal board transitions
and one-time action capabilities on-chain but does not claim to detect a player
who lies about off-chain randomness or recover when a player disappears. Read
the main teaching guide before using this reference to study the additional
mechanisms and their unresolved tradeoffs.
