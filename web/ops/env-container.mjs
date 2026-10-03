#!/usr/bin/env node
// Builds a container secrets file from the native web env (plan 2B's web/.env.stg) and, for PROD, the engine caller pair.
// Keeps keys already present in the target (e.g. LQSTUDIO_TOKEN). Prints key names only.
import { parseArgs } from 'node:util';
import { parsePairs, readEnvFile, toContainerDatabaseUrl, writeEnvFile } from './env-lib.mjs';

const { values } = parseArgs({
  options: { from: { type: 'string' }, to: { type: 'string' }, 'engine-env': { type: 'string' }, 'engine-caller': { type: 'string' } },
});
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!values.from || !values.to) fail('usage: node ops/env-container.mjs --from <native env> --to <container env> [--engine-env <file> --engine-caller <name>]');

const source = readEnvFile(values.from);
const out = readEnvFile(values.to);
if (!source.DATABASE_URL) fail(`${values.from} has no DATABASE_URL`);
try {
  out.DATABASE_URL = toContainerDatabaseUrl(source.DATABASE_URL);
} catch {
  fail(`${values.from} DATABASE_URL is not a valid URL (value hidden)`);
}

const caller = values['engine-caller'];
if (caller) {
  const engine = readEnvFile(values['engine-env'] ?? '../engine/.env');
  let tokens;
  let secrets;
  try {
    tokens = parsePairs(engine.LQTTS_TOKENS);
    secrets = parsePairs(engine.LQTTS_CALLBACK_SECRETS);
  } catch {
    fail('LQTTS_TOKENS/LQTTS_CALLBACK_SECRETS are not name:value pairs (values hidden)');
  }
  if (!tokens[caller] || !secrets[caller]) fail(`engine caller ${caller} not found in LQTTS_TOKENS/LQTTS_CALLBACK_SECRETS`);
  out.ENGINE_TOKEN = tokens[caller];
  out.ENGINE_CALLBACK_SECRET = secrets[caller];
} else {
  for (const key of ['ENGINE_TOKEN', 'ENGINE_CALLBACK_SECRET']) {
    if (!source[key]) fail(`${values.from} has no ${key}`);
    out[key] = source[key];
  }
}
try {
  writeEnvFile(values.to, out);
} catch (error) {
  fail(error.message);
}
console.log(`wrote ${Object.keys(out).sort().join(', ')} to ${values.to} (values hidden)`);
