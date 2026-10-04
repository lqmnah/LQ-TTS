import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { assertLayout } from '../harness/layout.mjs';
import { TARGET, accessHeaders, apiCredentials } from '../target.mjs';
import { anonymousProbe, expect, test } from './fixtures.js';
import { enterTwoFactor } from './two-factor.js';

const SCRIPT = 'Halo, ini voiceover pertama dari LQ TTS API. Terima kasih sudah mencoba.';
const ARTIFACTS = new URL('../artifacts/api/', import.meta.url);

async function apiCall(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'lq-tts' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  }, { method, path, body });
}

// Local webhook receiver; next() waits for the next POST.
async function startReceiver() {
  const hits = [];
  const waiters = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const hit = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    res.writeHead(200).end('ok');
    const waiter = waiters.shift();
    if (waiter) waiter(hit);
    else hits.push(hit);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/lqtts-hook`,
    next: (ms) => (hits.length ? Promise.resolve(hits.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(settle), 1);
        reject(new Error(`no webhook within ${ms} ms`));
      }, ms);
      const settle = (hit) => {
        clearTimeout(timer);
        resolve(hit);
      };
      waiters.push(settle);
    })),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test('api: key from the UI, voiceover through /v1, webhook or polling, download, delete, revoke', async ({ page, guard, baseURL }) => {
  const creds = apiCredentials();
  let signedIn = false;
  guard.expect((res) => !signedIn && anonymousProbe(res));
  mkdirSync(ARTIFACTS, { recursive: true });

  // 1. Sign in as a Pro account
  await page.goto('/login');
  await page.getByLabel('Email atau username', { exact: true }).fill(creds.identifier);
  await page.getByLabel('Kata sandi', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  if (creds.code) {
    await expect(page.getByRole('heading', { level: 1, name: 'Verifikasi dua langkah', exact: true })).toBeVisible();
    await enterTwoFactor(page, creds, guard);
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Teks ke Suara', exact: true })).toBeVisible();
  signedIn = true;

  // 2. API page: revoke leftovers of an earlier failed run, create a key, read it from the one-time panel
  await page.getByRole('link', { name: 'API', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'API', exact: true })).toBeVisible();
  const before = await apiCall(page, 'GET', '/keys');
  for (const k of before.json.keys.filter((x) => x.name.startsWith('E2E '))) await apiCall(page, 'DELETE', `/keys/${k.id}`);
  await page.reload();
  const keyName = `E2E ${Date.now().toString(36)}`;
  await page.getByLabel('Nama kunci', { exact: true }).fill(keyName);
  await page.getByRole('button', { name: 'Buat kunci', exact: true }).click();
  const panel = page.getByTestId('new-key-panel');
  await expect(panel).toBeVisible();
  const key = (await panel.getByTestId('new-key-value').textContent()).trim();
  const webhookSecret = (await panel.getByTestId('new-webhook-secret').textContent()).trim();
  expect(key).toMatch(/^lqtts_[a-z2-7]{12}_[a-z2-7]{52}$/);
  expect(webhookSecret).toMatch(/^whsec_[a-z2-7]{52}$/);
  await page.screenshot({
    path: new URL('key-created-1440.png', ARTIFACTS).pathname, fullPage: true, animations: 'disabled',
    mask: [panel.getByTestId('new-key-value'), panel.getByTestId('new-webhook-secret')],
  });
  await panel.getByRole('button', { name: 'Sudah saya simpan', exact: true }).click();
  const row = page.getByTestId('api-key-row').filter({ hasText: keyName });
  await expect(row).toHaveCount(1);

  // 3. The curl-equivalent flow from Node (server to server: no cookies)
  const v1 = (method, path, body, headers = {}) => fetch(new URL(`/v1${path}`, baseURL), {
    method,
    headers: { authorization: `Bearer ${key}`, ...accessHeaders(), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  expect((await fetch(new URL('/v1/voices', baseURL), { headers: accessHeaders() })).status).toBe(401);
  const { voices } = await (await v1('GET', '/voices')).json();
  const voice = TARGET === 'local'
    ? voices.find((v) => v.kind === 'profile' && v.name === 'Pandji')
    : voices.find((v) => v.kind === 'own');
  expect(voice, `a usable voice among ${JSON.stringify(voices.map((v) => `${v.kind}:${v.name}`))}`).toBeTruthy();
  const chars = [...SCRIPT].length;
  expect(await (await v1('POST', '/estimate', { text: SCRIPT })).json()).toEqual({ chars, credits: Math.max(1, Math.ceil(chars / 100)), sentences: 2 });

  const receiver = TARGET === 'local' ? await startReceiver() : null;
  try {
    const idem = `e2e-${crypto.randomUUID()}`;
    const body = { voiceId: voice.id, text: SCRIPT, formats: ['mp3', 'srt'], ...(receiver ? { webhookUrl: receiver.url } : {}) };
    const created = await v1('POST', '/tts', body, { 'idempotency-key': idem });
    expect(created.status).toBe(202);
    const { jobId, credits, status } = await created.json();
    expect(status).toBe('queued');
    const replay = await v1('POST', '/tts', body, { 'idempotency-key': idem });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect((await replay.json()).jobId).toBe(jobId);

    // 4. Poll until done (both targets); locally the signed webhook arrives too
    let job;
    await expect.poll(async () => {
      job = await (await v1('GET', `/tts/${jobId}`)).json();
      return job.status;
    }, { timeout: 300_000, intervals: [2_000] }).toBe('done');
    expect(job).toMatchObject({
      jobId, credits, errorCode: null,
      files: { mp3: `/v1/tts/${jobId}/files/final.mp3`, srt: `/v1/tts/${jobId}/files/subtitles.srt` },
    });
    if (receiver) {
      const hit = await receiver.next(60_000);
      expect(hit.headers['lqtts-event']).toBe('job.done');
      const [, t, v1sig] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hit.headers['lqtts-signature']);
      expect(crypto.createHmac('sha256', webhookSecret).update(`${t}.${hit.body}`).digest('hex')).toBe(v1sig);
      expect(JSON.parse(hit.body)).toMatchObject({ event: 'job.done', jobId, status: 'done', credits, files: job.files });
    }

    // 5. Download under the public names
    const mp3 = await v1('GET', `/tts/${jobId}/files/final.mp3`);
    expect(mp3.status).toBe(200);
    expect(mp3.headers.get('content-type')).toBe('audio/mpeg');
    expect((await mp3.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
    expect(await (await v1('GET', `/tts/${jobId}/files/subtitles.srt`)).text()).toContain(' --> ');

    // 6. The web app shows it: History chip, and locally the delivered webhook on the API page
    await page.getByRole('link', { name: 'Riwayat', exact: true }).click();
    await expect(page.locator(`[data-testid="history-row"][data-job-id="${jobId}"]`).getByTestId('api-chip')).toHaveText('API');
    await page.getByRole('link', { name: 'API', exact: true }).click();
    if (receiver) await expect(page.getByTestId('delivery-row').first()).toHaveAttribute('data-state', 'delivered');
    for (const vp of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await expect(page.locator('[data-skeleton]')).toHaveCount(0);
      await assertLayout(page, vp);
      await page.screenshot({ path: new URL(`api-page-${vp.name}.png`, ARTIFACTS).pathname, fullPage: true, animations: 'disabled' });
    }
    await page.goto('/developers');
    await expect(page.getByRole('heading', { level: 1, name: 'Dokumentasi API LQ TTS', exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await assertLayout(page, { width: 390 });
    await page.screenshot({ path: new URL('docs-390.png', ARTIFACTS).pathname, fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await assertLayout(page, { width: 1440 });
    await page.screenshot({ path: new URL('docs-1440.png', ARTIFACTS).pathname, fullPage: true, animations: 'disabled' });

    // 7. Delete through the API (a done job is deleted, its charge stays settled)
    expect((await v1('DELETE', `/tts/${jobId}`)).status).toBe(204);
    expect((await v1('GET', `/tts/${jobId}`)).status).toBe(404);
  } finally {
    await receiver?.close();
  }

  // 8. Revoke in the UI; the key stops at once
  await page.goto('/api-keys');
  await row.getByRole('button', { name: `Cabut kunci ${keyName}`, exact: true }).click();
  await page.getByTestId('api-key-confirm').getByRole('button', { name: 'Cabut kunci', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await v1('GET', '/voices')).status).toBe(401);
});
