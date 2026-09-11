// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ADVANCED = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MANIFEST = path.join(ADVANCED, "contract/keys.sha256");
const KEYS_DIR = path.join(ADVANCED, "contract/managed/keys");

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function main() {
  if (!existsSync(MANIFEST)) throw new Error(`missing manifest ${MANIFEST}`);
  if (!existsSync(KEYS_DIR)) {
    throw new Error(`no compiled keys at ${KEYS_DIR} — run \`npm run compact:advanced\` first`);
  }
  const expected = new Map<string, string>();
  for (const line of (await readFile(MANIFEST, "utf8")).split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
    if (match) expected.set(match[2], match[1]);
  }
  const present = (await readdir(KEYS_DIR))
    .filter((name) => name.endsWith(".prover") || name.endsWith(".verifier"));
  const problems: string[] = [];
  for (const [name, wanted] of expected) {
    if (!present.includes(name)) {
      problems.push(`MISSING ${name}`);
    } else {
      const actual = await sha256(path.join(KEYS_DIR, name));
      if (actual !== wanted) problems.push(`MISMATCH ${name}: expected ${wanted}, got ${actual}`);
    }
  }
  for (const name of present) {
    if (!expected.has(name)) problems.push(`UNEXPECTED ${name}`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  console.log(`✓ all ${expected.size} advanced keys match advanced/contract/keys.sha256`);
}

main().catch((error) => {
  console.error("[keys:verify:advanced]", error instanceof Error ? error.message : error);
  process.exit(1);
});
