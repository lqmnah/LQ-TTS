import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers.js';

describe('health', () => {
  let h;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('reports both upstreams without a session', async () => {
    const res = await request(h.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ engine: 'ok', lqstudio: 'ok', signupUrl: 'https://demo.lq-studio.com/signup' });
  });

  it('reports a restarting engine and a down LQ-Studio, still with 200', async () => {
    h.engine.state.healthStatus = 503;
    h.lq.state.down = true;
    try {
      const res = await request(h.app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ engine: 'restarting', lqstudio: 'down', signupUrl: 'https://demo.lq-studio.com/signup' });
    } finally {
      h.engine.state.healthStatus = 200;
      h.lq.state.down = false;
    }
  });

  it('answers unknown API paths with a JSON 404 for signed-in users', async () => {
    const res = await h.as(await h.login()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('client hosting', () => {
  let h;
  let dist;
  beforeAll(async () => {
    dist = await fs.mkdtemp(path.join(os.tmpdir(), 'lqtts-dist-'));
    await fs.mkdir(path.join(dist, 'assets'));
    await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    await fs.writeFile(path.join(dist, 'assets', 'app-1a2b.css'), 'body{margin:0}');
    h = await startHarness({ env: { CLIENT_DIST: dist } });
  });
  afterAll(async () => {
    await h.close();
    await fs.rm(dist, { recursive: true, force: true });
  });

  it('serves hashed assets as immutable', async () => {
    const res = await request(h.app).get('/assets/app-1a2b.css');
    expect(res.status).toBe(200);
    expect(res.text).toBe('body{margin:0}');
    expect(res.headers['cache-control']).toContain('immutable');
    expect((await request(h.app).get('/assets/missing.js')).status).toBe(404);
  });

  it('denies framing on the page, the API and SPA routes', async () => {
    for (const url of ['/', '/api/health', '/voices/123']) {
      const res = await request(h.app).get(url);
      expect(res.headers['content-security-policy'], url).toBe("frame-ancestors 'none'");
      expect(res.headers['x-frame-options'], url).toBe('DENY');
    }
  });
  it('falls back to index.html for app routes but never for /api', async () => {
    const page = await request(h.app).get('/voices/123');
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="root"');
    const api = await request(h.app).get('/api/unknown');
    expect(api.status).toBe(401);
    expect(api.body.error.code).toBe('unauthorized');
  });
});
