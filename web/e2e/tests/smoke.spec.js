import { mkdirSync } from 'node:fs';
import { assertLayout } from '../harness/layout.mjs';
import { anonymousProbe, expect, test } from './fixtures.js';

test('public smoke: health, login page at 3 widths, wrong password reaches LQ-Studio', async ({ page, guard }) => {
  guard.expect(anonymousProbe);
  const health = await page.request.get('/api/health');
  expect(health.status()).toBe(200);
  const body = await health.json();
  expect(body).toMatchObject({ engine: 'ok', lqstudio: 'ok' });
  expect(body.signupUrl).toMatch(/\/signup$/);

  const dir = new URL('../artifacts/smoke/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const vp of [{ name: '390', width: 390, height: 844 }, { name: '768', width: 768, height: 1024 }, { name: '1440', width: 1440, height: 900 }]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Masuk ke LQ TTS', exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await assertLayout(page, vp);
    await page.screenshot({ path: new URL(`login-${vp.name}.png`, dir).pathname, fullPage: true });
  }

  // Expected 401: a made-up account proves the browser → web → LQ-Studio internal API chain answers.
  guard.expect((res) => res.status() === 401 && res.url().endsWith('/api/auth/login'));
  await page.getByLabel('Email atau username', { exact: true }).fill('tts-smoke-no-such-user');
  await page.getByLabel('Kata sandi', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page.getByTestId('login-error')).toHaveText('Email/username atau kata sandi salah.');
});
