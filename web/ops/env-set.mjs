#!/usr/bin/env node
// Usage: <value on stdin> | node ops/env-set.mjs <env-file> <KEY>
// Writes one secret into an env file (mode 600) without ever printing it.
import { readFileSync } from 'node:fs';
import { setEnvKey } from './env-lib.mjs';

const [file, key] = process.argv.slice(2);
if (!file || !key) {
  console.error('usage: <value on stdin> | node ops/env-set.mjs <env-file> <KEY>');
  process.exit(2);
}
const value = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (!value || /[\r\n]/.test(value)) {
  console.error(`refusing: value for ${key} is empty or spans several lines`);
  process.exit(1);
}
setEnvKey(file, key, value);
console.log(`${key} written to ${file} (value hidden, ${value.length} chars)`);
