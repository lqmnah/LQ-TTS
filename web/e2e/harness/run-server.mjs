// Runs the real plan-2B server natively for Playwright: real engine (caller lq-tts-stg) and real Postgres
// (throwaway schema lq_tts_web_e2e, dropped first), fake LQ-Studio. Secrets are read from web/.env.stg and never printed.
// Before the server starts, the VO Profile CLI seeds the Pandji profile from the short fixture clip.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readEnvFile, toHostDatabaseUrl } from '../../ops/env-lib.mjs';
import { FAKE_LQS_PORT, FAKE_LQS_TOKEN, LOCAL_PORT, LOCAL_USERS, SAMPLE_AUDIO } from '../target.mjs';

const webDir = fileURLToPath(new URL('../../', import.meta.url));
const base = readEnvFile(fileURLToPath(new URL('../../.env.stg', import.meta.url)));
for (const key of ['DATABASE_URL', 'ENGINE_TOKEN', 'ENGINE_CALLBACK_SECRET']) {
  if (!base[key]) throw new Error(`web/.env.stg lacks ${key} (plan 2B setup)`);
}

const SCHEMA = 'lq_tts_web_e2e';
const PSQL = '/opt/homebrew/opt/postgresql@16/bin/psql';
const dropSchema = () => execFileSync(PSQL, ['-d', 'lq_tts', '-v', 'ON_ERROR_STOP=1', '-qc', `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`], { stdio: 'inherit' });

const ENGINE_URL = 'http://127.0.0.1:8740';
const engineHeaders = { Authorization: `Bearer ${base.ENGINE_TOKEN}` };

// The engine's answer to the delete, or 0 when it could not be reached.
async function deleteEngineVoice(id, label) {
  let status = 0;
  try {
    status = (await fetch(`${ENGINE_URL}/v1/voices/${id}`, { method: 'DELETE', headers: engineHeaders })).status;
  } catch {
    // engine unreachable: the voice stays recorded for the next run
  }
  process.stdout.write(`e2e cleanup: ${label} ${id} -> ${status || 'unreachable'}\n`);
  return status;
}

// The engine is shared: voices of the fake users (and their jobs, engine cascade) never outlive a run.
async function purgeEngineVoices() {
  for (const user of LOCAL_USERS) {
    const res = await fetch(`${ENGINE_URL}/v1/voices?owner_ref=${encodeURIComponent(user.id)}`, { headers: engineHeaders });
    if (!res.ok) throw new Error(`engine voice list answered ${res.status}`);
    for (const voice of await res.json()) await deleteEngineVoice(voice.id, 'engine voice');
  }
}

// Profile voices are owner_ref "library" under the same engine caller as the staging container, so they are removed
// by the ids this run's schema recorded, never by owner_ref (that would also take staging's Pandji).
function profileVoiceIds() {
  try {
    const out = execFileSync(PSQL, ['-d', 'lq_tts', '-v', 'ON_ERROR_STOP=1', '-Atqc', `SELECT voice_id FROM ${SCHEMA}.voice_profiles`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch {
    return []; // no schema or table yet
  }
}
// The recorded profile voices that are still on the engine (any answer other than 204 or 404).
async function purgeProfileVoices() {
  const kept = [];
  for (const id of profileVoiceIds()) {
    if (![204, 404].includes(await deleteEngineVoice(id, 'profile voice'))) kept.push(id);
  }
  return kept;
}

const env = {
  ...process.env,
  ...base,
  HOST: '127.0.0.1',
  PORT: String(LOCAL_PORT),
  DB_SCHEMA: SCHEMA,
  DATABASE_URL: toHostDatabaseUrl(base.DATABASE_URL),
  ENGINE_URL,
  ENGINE_CALLBACK_URL: `http://127.0.0.1:${LOCAL_PORT}/api/internal/engine-callback`,
  LQSTUDIO_URL: `http://127.0.0.1:${FAKE_LQS_PORT}`,
  LQSTUDIO_TOKEN: FAKE_LQS_TOKEN,
  LQSTUDIO_PUBLIC_URL: 'https://demo.lq-studio.com',
  COOKIE_SECURE: 'false',
  CLIENT_DIST: fileURLToPath(new URL('../../client/dist', import.meta.url)),
};

// One child at a time (the CLI, then the server). A signal is forwarded to it exactly once; with no child running,
// the run stops at the next step. Both children are detached: Playwright signals the whole process group, and the
// server must get exactly one SIGTERM (ours), since a second one during shutdown forces exit 1 (shutdown_forced).
let current = null;
let currentSignalled = false;
let stopSignal = null;
function signalCurrent(signal) {
  if (!current || currentSignalled) return;
  currentSignalled = true;
  current.kill(signal);
}
function startChild(args, stdio) {
  current = spawn(process.execPath, args, { cwd: webDir, env, stdio, detached: true });
  currentSignalled = false;
  return current;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopSignal) return;
    stopSignal = signal;
    signalCurrent(signal);
  });
}
const signalExitCode = (signal) => (signal === 'SIGINT' ? 130 : 143);

// The CLI waits up to 15 min for the voice; this harness gives it 6, below the 7 min Playwright webServer timeout
// in target.mjs, so a stuck seed ends with the CLI's own SIGTERM discard instead of a Playwright kill.
const SEED_TIMEOUT_MS = 360_000;

// The same CLI and metadata the release runs in the container, fed the short fixture clip on stdin.
// Answers the exit code to run with, or null when the profile is seeded.
async function seedProfile() {
  const audio = openSync(SAMPLE_AUDIO, 'r');
  try {
    const cli = startChild(['server/cli/profile-add.js', '--meta', 'server/cli/profiles/pandji.json', '--filename', 'ref.wav'], [audio, 'inherit', 'inherit']);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = !currentSignalled;
      signalCurrent('SIGTERM'); // the CLI deletes its new voice and exits
    }, SEED_TIMEOUT_MS);
    const code = await new Promise((resolve) => cli.on('exit', (exitCode) => resolve(exitCode ?? 1)));
    clearTimeout(timer);
    current = null;
    if (code === 0) return null;
    process.stderr.write(`e2e seed: profile-add exited ${code}${timedOut ? ` after the ${SEED_TIMEOUT_MS / 1000} s seed limit` : ''}\n`);
    return stopSignal && !timedOut ? signalExitCode(stopSignal) : 1;
  } finally {
    closeSync(audio);
  }
}

// The schema is throwaway, but it is the only record of the profile voices: it is dropped only once each of them
// is confirmed gone from the engine (204 or 404). Otherwise it stays for the next run and the run fails.
async function cleanupAndExit(code) {
  const kept = await purgeProfileVoices();
  let exitCode = code;
  try {
    await purgeEngineVoices();
  } catch (error) {
    process.stderr.write(`e2e cleanup: ${error.message}\n`);
    exitCode = exitCode || 1;
  }
  if (kept.length) {
    process.stderr.write(`e2e cleanup: schema ${SCHEMA} kept, profile voices still on the engine: ${kept.join(' ')}\n`);
    process.exit(exitCode || 1);
  }
  dropSchema();
  process.exit(exitCode);
}

const leftovers = await purgeProfileVoices(); // of a run that died before its cleanup
if (leftovers.length) {
  process.stderr.write(`e2e setup: schema ${SCHEMA} kept, leftover profile voices still on the engine: ${leftovers.join(' ')}\n`);
  process.exit(1);
}
dropSchema();
await purgeEngineVoices();
if (stopSignal) await cleanupAndExit(signalExitCode(stopSignal));
const seedFailure = await seedProfile();
if (seedFailure !== null) await cleanupAndExit(seedFailure);
if (stopSignal) await cleanupAndExit(signalExitCode(stopSignal));

startChild(['server/index.js'], 'inherit').on('exit', async (code, signal) => {
  process.stderr.write(`e2e server exited code=${code} signal=${signal}\n`);
  // A clean stop is exit 0, or death by the very signal we forwarded; anything else is a failure.
  await cleanupAndExit(code ?? (signal && signal === stopSignal ? 0 : 1));
});
