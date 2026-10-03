#!/usr/bin/env node
// Usage: node ops/env-check.mjs <env-file> KEY... ; prints presence and length only.
import { statSync } from 'node:fs';
import { readEnvFile } from './env-lib.mjs';

const [file, ...keys] = process.argv.slice(2);
const mode = statSync(file).mode & 0o777;
let bad = mode === 0o600 ? 0 : 1;
console.log(`${mode === 0o600 ? 'ok     ' : 'BAD    '} mode ${mode.toString(8)}`);
const env = readEnvFile(file);
for (const key of keys) {
  const value = env[key];
  const ok = typeof value === 'string' && value.length > 0 && (key !== 'LQSTUDIO_TOKEN' || value.length >= 32);
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok     ' : 'MISSING'} ${key}${value ? ` (${value.length} chars)` : ''}`);
}
process.exit(bad ? 1 : 0);
