import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from './db-url.js';
import { API_ENC_KEY, CALLBACK_SECRET, ENGINE_TOKEN, LQ_TOKEN, USERS, startHarness } from './helpers.js';

const INDEX = fileURLToPath(new URL('../index.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs the real entrypoint against the harness fakes and schema.
async function boot(h) {
  const child = spawn(process.execPath, [INDEX], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: '0',
      DATABASE_URL: testDatabaseUrl(),
      DB_SCHEMA: h.schema,
      ENGINE_URL: h.engine.url,
      ENGINE_TOKEN,
      ENGINE_CALLBACK_SECRET: CALLBACK_SECRET,
      ENGINE_CALLBACK_URL: 'http://127.0.0.1:8750/api/internal/engine-callback',
      LQSTUDIO_URL: h.lq.url,
      LQSTUDIO_TOKEN: LQ_TOKEN,
      LQSTUDIO_PUBLIC_URL: 'https://demo.lq-studio.com',
      COOKIE_SECURE: 'false',
      CLIENT_DIST: '/nonexistent-lq-tts-client-dist',
      API_ENC_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start listening within 10 s')), 10_000);
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const m = out.match(/"event":"listening"[^\n]*"port":(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      exited.then((code) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code} before listening`));
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'lq-tts' },
      body: JSON.stringify({ identifier: USERS.ana.email, password: USERS.ana.password }),
    });
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lqtts_sid=')).split(';')[0];
    return { child, exited, base, cookie };
  } catch (err) {
    child.kill('SIGKILL'); // never leak the child when boot fails
    throw err;
  }
}

describe('graceful shutdown', () => {
  let h;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const slowRequest = async (srv, delayMs) => {
    h.engine.state.listDelayMs = delayMs;
    const before = h.engine.state.callsTo('GET', '/v1/voices').length;
    const res = fetch(`${srv.base}/api/voices`, { headers: { cookie: srv.cookie, 'x-requested-with': 'lq-tts' } });
    while (h.engine.state.callsTo('GET', '/v1/voices').length === before) await sleep(10);
    return { res }; // wrapped: awaiting a bare fetch promise here would wait for the response
  };

  it('lets an in-flight request finish on SIGTERM, then exits 0', async () => {
    const srv = await boot(h);
    try {
      const { res } = await slowRequest(srv, 800);
      srv.child.kill('SIGTERM');
      const done = await res;
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual([]);
      expect(await srv.exited).toBe(0);
    } finally {
      srv.child.kill('SIGKILL');
      h.engine.state.listDelayMs = 0;
    }
  });

  it('exits 1 at once on a second signal', async () => {
    const srv = await boot(h);
    try {
      const { res } = await slowRequest(srv, 5000);
      res.catch(() => {});
      srv.child.kill('SIGTERM');
      await sleep(200);
      srv.child.kill('SIGINT');
      const started = Date.now();
      expect(await srv.exited).toBe(1);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      srv.child.kill('SIGKILL');
      h.engine.state.listDelayMs = 0;
    }
  });
});
