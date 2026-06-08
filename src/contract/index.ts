// Re-export the compiled contract module + witness wiring.
//
// Mirrors the pattern of pe-bun-3's contract-counter/src/index.ts — making
// the generated managed/contract module importable as a single namespace.

export * as TicTacToeChannel from "./managed/contract/index.js";
export type { Ledger, Status, Winner, Witnesses } from "./managed/contract/index.js";
export { Contract, ledger } from "./managed/contract/index.js";
export {
  createWitnesses,
  createTicTacToePrivateState,
  type TicTacToePrivateState,
  type TicTacToeWitnesses,
} from "./witnesses.ts";
