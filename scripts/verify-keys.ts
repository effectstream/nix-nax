/**
 * Verify the locally-compiled prover/verifier keys match the committed
 * manifest, by checksum. `compact compile +0.31.1` is deterministic — the same
 * compiler + source produce byte-identical keys — so a matching checksum means
 * your build produced exactly the circuits this source describes, and any arena
 * deployed from the same commit will accept the proofs it generates.
 *
 *   bun run keys:verify        (after `bun run compact`)
 *
 * NOTE: the manifest tracks THIS SOURCE, not any particular hosted deployment —
 * it must be regenerated whenever the contract changes. A match does not prove
 * that some remote arena is running this code; deploy from a matching commit.
 *
 * The expected checksums live in src/contract/keys.sha256 (committed). Exits
 * non-zero on any mismatch/missing/extra key so it can gate a build or CI.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MANIFEST = path.join(ROOT, "src/contract/keys.sha256");
const KEYS_DIR = path.join(ROOT, "src/contract/managed/keys");

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function main() {
  if (!existsSync(MANIFEST)) throw new Error(`missing manifest ${MANIFEST}`);
  if (!existsSync(KEYS_DIR)) {
    throw new Error(`no compiled keys at ${KEYS_DIR} — run \`bun run compact\` first`);
  }

  // Parse "hash  basename" lines into expected map.
  const expected = new Map<string, string>();
  for (const line of (await readFile(MANIFEST, "utf8")).split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m) expected.set(m[2], m[1]);
  }

  const present = (await readdir(KEYS_DIR)).filter((f) => f.endsWith(".prover") || f.endsWith(".verifier"));
  const problems: string[] = [];

  for (const [name, want] of expected) {
    if (!present.includes(name)) {
      problems.push(`MISSING   ${name}`);
      continue;
    }
    const got = await sha256(path.join(KEYS_DIR, name));
    if (got !== want) problems.push(`MISMATCH  ${name}\n            expected ${want}\n            got      ${got}`);
  }
  for (const name of present) {
    if (!expected.has(name)) problems.push(`UNEXPECTED ${name} (not in manifest)`);
  }

  if (problems.length) {
    console.error(`✗ key verification FAILED (${problems.length} problem(s)):\n` + problems.join("\n"));
    console.error(
      `\nYour compiled keys do NOT match src/contract/keys.sha256. Recompile with the\n` +
        `pinned compiler: \`compact update 0.31.1 && bun run compact\`. If it still\n` +
        `differs, the contract source changed — regenerate the manifest and redeploy,\n` +
        `because an arena deployed from the old source won't accept these proofs.`,
    );
    process.exit(1);
  }

  console.log(`✓ all ${expected.size} keys match src/contract/keys.sha256 — build matches this source.`);
}

main().catch((e) => {
  console.error("[keys:verify]", e instanceof Error ? e.message : e);
  process.exit(1);
});
