import { msUntilNextStep } from '../harness/totp.mjs';
import { TARGET } from '../target.mjs';
import { expect } from './fixtures.js';

async function submitCode(page, code) {
  await page.getByLabel('Kode', { exact: true }).fill(code);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/2fa'),
    page.getByRole('button', { name: 'Verifikasi', exact: true }).click(),
  ]);
  return res;
}

/**
 * LQ-Studio refuses a TOTP step it has already seen (replay protection): when a recent run used this window, the first
 * answer is 401 and the next window's code is accepted. Only that first 401 is expected, and only on a retrying target.
 */
export async function enterTwoFactor(page, creds, guard, { retryOnReplay = TARGET !== 'local' } = {}) {
  let firstAttempt = true;
  guard.expect((res) => retryOnReplay && firstAttempt && res.status() === 401 && new URL(res.url()).pathname === '/api/auth/2fa');
  const first = await submitCode(page, creds.code());
  firstAttempt = false;
  if (first.status() !== 401 || !retryOnReplay) return;
  await expect(page.getByTestId('login-error')).toBeVisible();
  await page.waitForTimeout(msUntilNextStep() + 1_000);
  const second = await submitCode(page, creds.code());
  expect(second.status(), 'the next TOTP window is accepted').toBe(200);
}
