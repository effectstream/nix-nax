// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Players are shown to users by their piece colour. Internally the protocol
// still uses marks X (1) / O (2) and roles "x" / "o"; these map those to the
// user-facing RED / BLUE labels.
export const colorOfRole = (r: "x" | "o"): "RED" | "BLUE" => (r === "x" ? "RED" : "BLUE");
export const colorOfMark = (m: number): "RED" | "BLUE" => (m === 1 ? "RED" : "BLUE");
