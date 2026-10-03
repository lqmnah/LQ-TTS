import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/lq_tts',
  DB_SCHEMA: 'lq_tts_web_stg',
  ENGINE_URL: 'http://127.0.0.1:8740/',
  ENGINE_TOKEN: 'engine-token',
  ENGINE_CALLBACK_SECRET: 'callback-secret',
  ENGINE_CALLBACK_URL: 'http://127.0.0.1:8750/api/internal/engine-callback',
  LQSTUDIO_URL: 'http://100.80.128.19:3112/',
  LQSTUDIO_TOKEN: 'x'.repeat(32),
  LQSTUDIO_PUBLIC_URL: 'https://demo.lq-studio.com/',
};

describe('loadConfig', () => {
  it('derives URLs and carries the spec pricing constants', () => {
    const c = loadConfig(base);
    expect(c.engineUrl).toBe('http://127.0.0.1:8740');
    expect(c.lqstudioUrl).toBe('http://100.80.128.19:3112');
    expect(c.topupUrl).toBe('https://demo.lq-studio.com/upgrade-plan');
    expect(c.verifyUrl).toBe('https://demo.lq-studio.com/login');
    expect(c.signupUrl).toBe('https://demo.lq-studio.com/signup');
    expect(c).toMatchObject({
      host: '127.0.0.1', port: 8750, cookieSecure: true, maxUploadBytes: 99614720, reconcileIntervalMs: 60000,
      creditsPer1kChars: 10, rupiahPerCredit: 100, voiceLimitFree: 3, voiceLimitPaid: 25, consentVersion: 'v1', maxTextChars: 20000,
    });
  });

  it('turns Secure cookies off only for COOKIE_SECURE=false', () => {
    expect(loadConfig({ ...base, COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(loadConfig({ ...base, COOKIE_SECURE: '0' }).cookieSecure).toBe(true);
  });

  it('lets LQS_SIGNUP_URL override the sign-up link', () => {
    expect(loadConfig({ ...base, LQS_SIGNUP_URL: 'https://lq-studio.com/signup?ref=tts' }).signupUrl).toBe('https://lq-studio.com/signup?ref=tts');
  });

  it.each(Object.keys(base))('rejects a missing %s', (key) => {
    const env = { ...base };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });

  it('rejects a short LQ-Studio token and an unsafe schema name', () => {
    expect(() => loadConfig({ ...base, LQSTUDIO_TOKEN: 'short' })).toThrow('at least 32');
    expect(() => loadConfig({ ...base, DB_SCHEMA: 'x"; drop' })).toThrow('DB_SCHEMA');
  });
  it('requires RECONCILE_INTERVAL_MS to be a whole number of milliseconds, at least 1000', () => {
    expect(loadConfig({ ...base, RECONCILE_INTERVAL_MS: '1000' }).reconcileIntervalMs).toBe(1000);
    for (const bad of ['999', '0', '-5000', '1500.5', 'abc', '1e9x']) {
      expect(() => loadConfig({ ...base, RECONCILE_INTERVAL_MS: bad })).toThrow('RECONCILE_INTERVAL_MS');
    }
  });
});
