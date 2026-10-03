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

async function deleteEngineVoice(id, label) {
  const del = await fetch(`${ENGINE_URL}/v1/voices/${id}`, { method: 'DELETE', headers: engineHeaders });
  process.stdout.write(`e2e cleanup: ${label} ${id} -> ${del.status}\n`);
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
async function purgeProfileVoices() {
  for (const id of profileVoiceIds()) await deleteEngineVoice(id, 'profile voice');
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

// The same CLI and metadata the release runs in the container, fed the short fixture clip on stdin.
async function seedProfile() {
  const audio = openSync(SAMPLE_AUDIO, 'r');
  try {
    const cli = spawn(process.execPath, ['server/cli/profile-add.js', '--meta', 'server/cli/profiles/pandji.json', '--filename', 'ref.wav'], {
      cwd: webDir, env, stdio: [audio, 'inherit', 'inherit'],
    });
    const code = await new Promise((resolve) => cli.on('exit', resolve));
    if (code !== 0) throw new Error(`profile-add exited ${code}`);
  } finally {
    closeSync(audio);
  }
}

await purgeProfileVoices(); // leftovers of a run that died before its cleanup
dropSchema();
await purgeEngineVoices();
await seedProfile();

// detached: Playwright signals the whole process group; the server must get exactly one SIGTERM (ours), since a
// second one during shutdown forces exit 1 (shutdown_forced).
const child = spawn(process.execPath, ['server/index.js'], { cwd: webDir, env, stdio: 'inherit', detached: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
// The schema is throwaway: drop it again once the server is gone, after its profile voice left the engine.
child.on('exit', async (code, signal) => {
  process.stderr.write(`e2e server exited code=${code} signal=${signal}\n`);
  try {
    await purgeProfileVoices();
    await purgeEngineVoices();
  } finally {
    dropSchema();
    process.exit(code ?? 0);
  }
});
