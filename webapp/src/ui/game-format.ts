// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { KIND_PLACE, KIND_REMOVE, type Action } from "../../../src/sdk/game/rules.ts";

export const shortHex = (b: Uint8Array): string => {
  const h = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}…${h.slice(-8)}`;
};

export const fmtAction = (a: Action): string =>
  a.kind === KIND_PLACE ? `place s${a.size}@c${a.cell}`
  : a.kind === KIND_REMOVE ? `remove @c${a.cell}`
  : "pass";
