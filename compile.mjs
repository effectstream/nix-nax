// Lightweight syntactic compile check via the bundled WASM compactc.
// This complements `bun run compact` (the full compile to managed/).
// Exits non-zero with a compiler error if the contract is malformed.
//
// Usage: node compile.mjs src/contract/TicTacToeChannel.compact
import { compile } from '/Users/edwardalvarado/midnight-ref-ai/compact/wasm/dist/compactc.mjs';
import { readFileSync } from 'fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node compile.mjs <path/to/contract.compact>');
  process.exit(2);
}
const src = readFileSync(file, 'utf8');
try {
  const res = await compile(src, { filename: file });
  console.log('OK. circuits:', [...res.zkir.keys()].join(', ') || '(none)');
  if (res.contractInfo) {
    console.log('contractInfo circuits:', JSON.stringify(Object.keys(res.contractInfo)));
  }
} catch (e) {
  console.error('COMPILE ERROR:\n' + e.message);
  process.exit(2);
}
