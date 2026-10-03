import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../ops/env-lib.mjs';
import { totp } from './harness/totp.mjs';

export const LOCAL_PORT = 8760;
export const FAKE_LQS_PORT = 8798;
export const FAKE_LQS_TOKEN = 'e2e-fake-lqstudio-token-not-a-secret-0001';
export const SAMPLE_AUDIO = fileURLToPath(new URL('../../data/fixtures/pandji/ref.wav', import.meta.url));
export const STATE_FILE = fileURLToPath(new URL('./.state.json', import.meta.url));
export const AUTH_FILE = fileURLToPath(new URL('./.auth.json', import.meta.url));
export const STAGING_CREDENTIALS = join(homedir(), '.config/lq-tts/e2e-staging.env');

export const LOCAL_USERS = [
  {
    id: 'e2e-u1', name: 'Rara Wibisono', email: 'rara.e2e@example.com', username: 'e2e-rara', password: 'e2e-pass-7391',
    totp: '482913', verified: true, suspended: false, plan: 'free', paid: false, balance: 2400,
  },
];

export const TARGET = process.env.E2E_TARGET ?? 'local';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for E2E_TARGET=${TARGET}`);
  return value;
}

export function targetConfig() {
  if (TARGET === 'local') {
    return {
      baseURL: `http://127.0.0.1:${LOCAL_PORT}`,
      headers: {},
      webServer: [
        { command: 'node harness/fake-lqstudio.mjs', port: FAKE_LQS_PORT, reuseExistingServer: false, timeout: 20_000 },
        // SIGTERM (not Playwright's default SIGKILL) so run-server can purge its engine voices and drop the schema.
        { command: 'node harness/run-server.mjs', url: `http://127.0.0.1:${LOCAL_PORT}/api/health`, reuseExistingServer: false, timeout: 90_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 } },
      ],
    };
  }
  if (TARGET === 'staging-public') {
    return {
      baseURL: 'https://tts-stg.lq-studio.com',
      headers: { 'CF-Access-Client-Id': required('CF_ACCESS_CLIENT_ID'), 'CF-Access-Client-Secret': required('CF_ACCESS_CLIENT_SECRET') },
      webServer: undefined,
    };
  }
  if (TARGET === 'prod') return { baseURL: 'https://tts.lq-studio.com', headers: {}, webServer: undefined };
  throw new Error(`unknown E2E_TARGET ${TARGET}`);
}

/** Login data: a fixed fake user locally, the seeded staging account otherwise. */
export function credentials() {
  if (TARGET === 'local') {
    const u = LOCAL_USERS[0];
    return { identifier: u.username, password: u.password, code: () => u.totp };
  }
  if (!existsSync(STAGING_CREDENTIALS)) throw new Error(`missing ${STAGING_CREDENTIALS} (Task 14 seeds it)`);
  const env = readEnvFile(STAGING_CREDENTIALS);
  return { identifier: env.LQTTS_E2E_IDENTIFIER, password: env.LQTTS_E2E_PASSWORD, code: () => totp(env.LQTTS_E2E_TOTP_SECRET) };
}
