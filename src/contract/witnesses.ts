// Witness implementations for the TicTacToeChannel contract.
//
// The contract declares `witness localSecret(): Bytes<32>` — this is the
// caller's player secret. Authentication asserts in-circuit that
// `persistentHash("ttt:id:", secret) == idX || idO`, so the caller cannot
// fake it. The witness shape (function on the witnesses object) and tuple
// return `[newPrivateState, value]` follows the standard pattern.

export type TicTacToePrivateState = {
  // The player's 32-byte identity secret. Used to authenticate startTimeout.
  // For settle / proveEquivocation / claimTimeout / claimResult, the payload
  // (or on-chain state) is the authenticator, so localSecret can be a
  // dummy value — but startTimeout requires the real one.
  secret: Uint8Array;
};

export const createTicTacToePrivateState = (secret: Uint8Array): TicTacToePrivateState => {
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  return { secret };
};

export const createWitnesses = () => ({
  localSecret(ctx: { privateState: TicTacToePrivateState }): [TicTacToePrivateState, Uint8Array] {
    return [ctx.privateState, ctx.privateState.secret];
  },
  // Division-by-2 witness for the in-circuit parity check (isEvenTurn): the
  // quotient/remainder are computed here, off-circuit, and the circuit
  // verifies 2*half + bit == value. Wrong values only fail our own proof.
  wit_divMod2(
    ctx: { privateState: TicTacToePrivateState },
    value: bigint,
  ): [TicTacToePrivateState, [bigint, bigint]] {
    return [ctx.privateState, [value / 2n, value % 2n]];
  },
});

export type TicTacToeWitnesses = ReturnType<typeof createWitnesses>;
