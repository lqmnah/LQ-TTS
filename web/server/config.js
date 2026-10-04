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
// Whole decimal numbers only: Number() turns 'abc' into NaN and '1e3' into 1000 without complaint.
const wholeNumber = (env, key, fallback, min, max) => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be a whole number, at least ${min} and at most ${max}`);
  }
  return n;
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
    port: wholeNumber(env, 'PORT', 8750, 0, 65535),
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
    maxUploadBytes: wholeNumber(env, 'MAX_UPLOAD_BYTES', 99614720, 1, 99614720), // 95 MB: Cloudflare rejects bodies over 100 MB
    reconcileIntervalMs: wholeNumber(env, 'RECONCILE_INTERVAL_MS', 60000, 1000, 2147483647),
    ...PRICING,
  });
}
