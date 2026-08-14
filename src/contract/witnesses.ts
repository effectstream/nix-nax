// Witness implementations for the NixNaxArena contract.
//
// The contract declares `witness localSecret(): Bytes<32>` — this is the
// caller's player secret. Authentication asserts in-circuit that
// `persistentHash("nixnax:id:", secret) == idX || idO`, so the caller cannot
// fake it. The witness shape (function on the witnesses object) and tuple
// return `[newPrivateState, value]` follows the standard pattern.

export type NixNaxPrivateState = {
  // The player's 32-byte identity secret. Used to authenticate startTimeout.
  // For settle / proveEquivocation / claimTimeout / claimResult, the payload
  // (or on-chain state) is the authenticator, so localSecret can be a
  // dummy value — but startTimeout requires the real one.
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
