import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app.js';
import { createEngine } from '../clients/engine.js';
import { createLqStudio } from '../clients/lqstudio.js';
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { createPool, migrate } from '../db/pool.js';
import { testDatabaseUrl } from './db-url.js';
import { startFakeEngine } from './fakes/fake-engine.js';
import { startFakeLqStudio } from './fakes/fake-lqstudio.js';

export const LQ_TOKEN = 'lq-test-token-'.padEnd(40, 'x');
export const ENGINE_TOKEN = 'engine-test-token';
export const CALLBACK_SECRET = 'callback-test-secret';
export const API_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

const user = (id, extra = {}) => ({
  id, name: id, email: `${id}@example.com`, username: id, password: 'secret-pass', totp: null,
  verified: true, suspended: false, plan: 'free', paid: false, balance: 100, ...extra,
});

export const USERS = {
  ana: user('ana'),
  budi: user('budi', { plan: 'pro', paid: true, balance: 1000 }),
  cici: user('cici', { plan: 'ultra', paid: true, balance: 1000 }),
  tfa: user('tfa', { totp: '123456' }),
  unverified: user('unverified', { verified: false }),
  suspended: user('suspended', { suspended: true }),
  poor: user('poor', { balance: 0 }),
};

export const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
export const text = (res, cb) => binary(res, (err, buf) => cb(err, buf.toString('utf8')));

export function sessionCookie(res) {
  const line = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('lqtts_sid='));
  if (!line) throw new Error('no session cookie');
  return line.split(';')[0];
}

export function signCallback(payload, { secret = CALLBACK_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  return { body, headers: { 'content-type': 'application/json', 'x-lq-timestamp': String(ts), 'x-lq-signature': signature } };
}

export async function startHarness({ env = {}, app: appOptions = {} } = {}) {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const pool = createPool(testDatabaseUrl(), schema, { max: 4 });
  await migrate(pool, schema);
  const lq = await startFakeLqStudio({ token: LQ_TOKEN, users: Object.values(USERS) });
  const engine = await startFakeEngine({ token: ENGINE_TOKEN });
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    DB_SCHEMA: schema,
    ENGINE_URL: engine.url,
    ENGINE_TOKEN,
    ENGINE_CALLBACK_SECRET: CALLBACK_SECRET,
    ENGINE_CALLBACK_URL: 'http://127.0.0.1:8750/api/internal/engine-callback',
    LQSTUDIO_URL: lq.url,
    LQSTUDIO_TOKEN: LQ_TOKEN,
    LQSTUDIO_PUBLIC_URL: 'https://demo.lq-studio.com',
    COOKIE_SECURE: 'false',
    CLIENT_DIST: '/nonexistent-lq-tts-client-dist',
    API_ENC_KEY,
    ...env,
  });
  const logs = [];
  const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (fields, msg) => logs.push({ level, msg, ...fields })]));
  const ctx = createContext({
    config, pool, log,
    lqstudio: createLqStudio({ baseUrl: lq.url, token: LQ_TOKEN, timeoutMs: 3000 }),
    engine: createEngine({ baseUrl: engine.url, token: ENGINE_TOKEN, timeoutMs: 3000 }),
  });
  const app = createApp(ctx, { healthCacheMs: 0, ...appOptions });
  return {
    schema, pool, lq, engine, ctx, app, logs, config,
    async login(u = USERS.ana) {
      const res = await request(app).post('/api/auth/login').set('x-requested-with', 'lq-tts')
        .send({ identifier: u.email, password: u.password });
      if (res.body.status !== 'ok') throw new Error(`login failed: ${JSON.stringify(res.body)}`);
      return sessionCookie(res);
    },
    as(cookie) {
      const go = (r) => r.set('cookie', cookie).set('x-requested-with', 'lq-tts');
      return {
        get: (p) => go(request(app).get(p)),
        post: (p, body) => go(request(app).post(p)).send(body ?? {}),
        patch: (p, body) => go(request(app).patch(p)).send(body ?? {}),
        del: (p) => go(request(app).delete(p)),
        upload: (p) => go(request(app).post(p)),
      };
    },
    // A live API key for the user, made through the store (the browser route needs a session).
    async apiKey(userId = 'budi', { tv = 0 } = {}) {
      return (await ctx.apiKeys.create(userId, { name: 'test key', tv })).key;
    },
    api(key) {
      const go = (r) => (key ? r.set('authorization', `Bearer ${key}`) : r);
      return {
        get: (p) => go(request(app).get(p)),
        post: (p, body) => go(request(app).post(p)).send(body ?? {}),
        del: (p) => go(request(app).delete(p)),
      };
    },
    async close() {
      await lq.close();
      await engine.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}
