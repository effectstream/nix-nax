// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Witness implementations for the NixNaxArena contract.
//
// The contract declares `witness localSecret(): Bytes<32>` — this is the
// caller's player secret. Authentication asserts in-circuit that
// `persistentHash("nixnax:id:", secret) == idX || idO`, so the caller cannot
// fake it. The witness shape (function on the witnesses object) and tuple
// return `[newPrivateState, value]` follows the standard pattern.

export type NixNaxPrivateState = {
  // The player's 32-byte per-game identity secret. The main contract consumes
  // it in claimResult via callerMark, so a winner must retain the real secret
  // to finalize and mint the reward. createGame, joinGame, and settle do not
  // consume this witness.
  secret: Uint8Array;
};

export const createNixNaxPrivateState = (secret: Uint8Array): NixNaxPrivateState => {
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  return { secret };
};

export const createWitnesses = () => ({
  localSecret(ctx: { privateState: NixNaxPrivateState }): [NixNaxPrivateState, Uint8Array] {
    return [ctx.privateState, ctx.privateState.secret];
  },
});

export type NixNaxWitnesses = ReturnType<typeof createWitnesses>;
