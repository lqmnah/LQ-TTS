import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PRICING = Object.freeze({
  creditsPer1kChars: 10,
  rupiahPerCredit: 100,
  voiceLimitFree: 3,
  voiceLimitPaid: 25,
  consentVersion: 'v1',
  maxTextChars: 20000,
});

const trimSlash = (url) => url.replace(/\/+$/, '');
const intervalMs = (raw) => {
  const ms = Number(raw || 60000);
  if (!Number.isInteger(ms) || ms < 1000 || ms > 2147483647 || (raw && !/^\d+$/.test(raw))) {
    throw new Error('RECONCILE_INTERVAL_MS must be a whole number of milliseconds, at least 1000 and at most 2147483647');
  }
  return ms;
};
export function loadConfig(env = process.env) {
  const req = (key) => {
    const value = env[key];
    if (value === undefined || value === '') throw new Error(`missing required setting ${key}`);
    return value;
  };
  const dbSchema = req('DB_SCHEMA');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbSchema)) throw new Error('DB_SCHEMA must be a lowercase SQL identifier');
  const lqstudioToken = req('LQSTUDIO_TOKEN');
  if (lqstudioToken.length < 32) throw new Error('LQSTUDIO_TOKEN must be at least 32 characters');
  const publicUrl = trimSlash(req('LQSTUDIO_PUBLIC_URL'));
  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8750),
    databaseUrl: req('DATABASE_URL'),
    dbSchema,
    engineUrl: trimSlash(req('ENGINE_URL')),
    engineToken: req('ENGINE_TOKEN'),
    engineCallbackSecret: req('ENGINE_CALLBACK_SECRET'),
    engineCallbackUrl: req('ENGINE_CALLBACK_URL'),
    lqstudioUrl: trimSlash(req('LQSTUDIO_URL')),
    lqstudioToken,
    topupUrl: `${publicUrl}/upgrade-plan`,
    verifyUrl: `${publicUrl}/login`,
    signupUrl: env.LQS_SIGNUP_URL || `${publicUrl}/signup`,
    cookieSecure: env.COOKIE_SECURE !== 'false',
    clientDist: path.resolve(env.CLIENT_DIST || path.join(WEB_DIR, 'client', 'dist')),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 99614720), // 95 MB: Cloudflare rejects bodies over 100 MB
    reconcileIntervalMs: intervalMs(env.RECONCILE_INTERVAL_MS),
    ...PRICING,
  });
}
