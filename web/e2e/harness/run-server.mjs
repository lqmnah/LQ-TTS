// Runs the real plan-2B server natively for Playwright: real engine (caller lq-tts-stg) and real Postgres
// (throwaway schema lq_tts_web_e2e, dropped first), fake LQ-Studio. Secrets are read from web/.env.stg and never printed.
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnvFile, toHostDatabaseUrl } from '../../ops/env-lib.mjs';
import { FAKE_LQS_PORT, FAKE_LQS_TOKEN, LOCAL_PORT, LOCAL_USERS } from '../target.mjs';

const webDir = fileURLToPath(new URL('../../', import.meta.url));
const base = readEnvFile(fileURLToPath(new URL('../../.env.stg', import.meta.url)));
for (const key of ['DATABASE_URL', 'ENGINE_TOKEN', 'ENGINE_CALLBACK_SECRET']) {
  if (!base[key]) throw new Error(`web/.env.stg lacks ${key} (plan 2B setup)`);
}

const SCHEMA = 'lq_tts_web_e2e';
const dropSchema = () => execFileSync('/opt/homebrew/opt/postgresql@16/bin/psql', ['-d', 'lq_tts', '-v', 'ON_ERROR_STOP=1', '-qc', `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`], { stdio: 'inherit' });

// The engine is shared: voices of the fake users (and their jobs, engine cascade) never outlive a run.
const ENGINE_URL = 'http://127.0.0.1:8740';
async function purgeEngineVoices() {
  const headers = { Authorization: `Bearer ${base.ENGINE_TOKEN}` };
  for (const user of LOCAL_USERS) {
    const res = await fetch(`${ENGINE_URL}/v1/voices?owner_ref=${encodeURIComponent(user.id)}`, { headers });
    if (!res.ok) throw new Error(`engine voice list answered ${res.status}`);
    for (const voice of await res.json()) {
      const del = await fetch(`${ENGINE_URL}/v1/voices/${voice.id}`, { method: 'DELETE', headers });
      process.stdout.write(`e2e cleanup: engine voice ${voice.id} -> ${del.status}\n`);
    }
  }
}

dropSchema();
await purgeEngineVoices();

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

const child = spawn(process.execPath, ['server/index.js'], { cwd: webDir, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
// The schema is throwaway: drop it again once the server is gone.
child.on('exit', async (code) => {
  try {
    await purgeEngineVoices();
  } finally {
    dropSchema();
    process.exit(code ?? 0);
  }
});
