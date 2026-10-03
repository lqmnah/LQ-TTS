import { mkdirSync, readFileSync } from 'node:fs';
import { assertLayout } from '../harness/layout.mjs';
import { AUTH_FILE, STATE_FILE } from '../target.mjs';
import { anonymousProbe, expect, routeAccess, test } from './fixtures.js';

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, touch: true },
  { name: '768', width: 768, height: 1024, touch: true },
  { name: '1440', width: 1440, height: 900, touch: false },
];

test.describe.configure({ mode: 'serial' });

async function settle(page) {
  await expect(page.locator('[data-skeleton]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page, viewport, name) {
  const dir = new URL(`../artifacts/${viewport.name}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  // animations: 'disabled' fast-forwards state transitions (e.g. the composer's button turning enabled) to their end.
  await page.screenshot({ path: new URL(`${name}.png`, dir).pathname, fullPage: true, animations: 'disabled' });
}

for (const vp of VIEWPORTS) {
  test(`screens at ${vp.name}px`, async ({ browser, guard, baseURL }) => {
    const { jobId, voiceName } = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    // browser.newContext() does not inherit `use` options or fixtures: baseURL is passed and the Access route added explicitly.
    const contextOptions = { baseURL, viewport: { width: vp.width, height: vp.height }, colorScheme: 'dark', locale: 'id-ID', isMobile: vp.touch, hasTouch: vp.touch };

    const anon = await browser.newContext(contextOptions);
    await routeAccess(anon, baseURL);
    const loginPage = await anon.newPage();
    let anonymous = true;
    guard.expect((res) => anonymous && anonymousProbe(res));
    guard.watch(loginPage);
    await loginPage.goto('/login');
    await expect(loginPage.getByRole('heading', { level: 1, name: 'Masuk ke LQ TTS', exact: true })).toBeVisible();
    await settle(loginPage);
    await assertLayout(loginPage, vp, { touch: vp.touch });
    await shot(loginPage, vp, 'login');
    await anon.close();
    anonymous = false;

    const context = await browser.newContext({ ...contextOptions, storageState: AUTH_FILE });
    await routeAccess(context, baseURL);
    const page = await context.newPage();
    guard.watch(page);
    const screens = [
      ['tts', '/', 'Teks ke Suara'],
      ['job', `/jobs/${jobId}`, null],
      ['voices', '/voices', 'Suara'],
      ['history', '/history', 'Riwayat'],
      ['credits', '/credits', 'Kredit'],
    ];
    for (const [name, path, heading] of screens) {
      await page.goto(path);
      if (heading) await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
      else await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done');
      await settle(page);
      // The restored draft is ready to send: the screenshot must show the real, enabled primary action.
      if (name === 'tts') await expect(page.getByTestId('generate')).toBeEnabled();
      const m = await assertLayout(page, vp, { touch: vp.touch });
      if (vp.width === 1440) expect(m.sidebar?.width).toBe(232);
      if (vp.width === 768) expect(m.sidebar?.width).toBe(72);
      if (vp.width === 390) {
        expect(m.sidebar).toBeNull();
        expect(m.bottomNav?.height).toBe(64);
      }
      await shot(page, vp, name);
    }

    if (vp.width === 1440) {
      await page.emulateMedia({ colorScheme: 'light' });
      for (const [name, path] of [['tts-light', '/'], ['job-light', `/jobs/${jobId}`]]) {
        await page.goto(path);
        await settle(page);
        await shot(page, vp, name);
      }
      await page.emulateMedia({ colorScheme: 'dark' });
      // Delete the voiceover from its page with the inline confirm; the page then lands on History.
      await page.goto(`/jobs/${jobId}`);
      await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done');
      await page.getByRole('button', { name: 'Hapus voiceover', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Hapus voiceover ini beserta semua revisinya?' })).toBeVisible();
      const [jobDeleted] = await Promise.all([
        page.waitForResponse((res) => res.request().method() === 'DELETE' && new URL(res.url()).pathname === `/api/jobs/${jobId}`),
        page.getByRole('button', { name: 'Hapus voiceover', exact: true }).click(),
      ]);
      expect(jobDeleted.status()).toBe(204);
      await expect(page).toHaveURL(/\/history$/);
      await expect(page.locator(`[data-testid="history-row"][data-job-id="${jobId}"]`)).toHaveCount(0);

      // Cleanup: the voice (the engine also drops any voiceover left on it).
      await page.goto('/voices');
      const row = page.getByTestId('voice-row').filter({ hasText: voiceName });
      await row.getByRole('button', { name: `Hapus suara ${voiceName}`, exact: true }).click();
      const [deleted] = await Promise.all([
        page.waitForResponse((res) => res.request().method() === 'DELETE' && /\/api\/voices\/[^/]+$/.test(res.url())),
        row.getByRole('button', { name: 'Hapus', exact: true }).click(),
      ]);
      expect(deleted.status()).toBe(204);
      await expect(row).toHaveCount(0);

      // Log out from the account menu: from the click on, the app probes /api/me anonymously again (401 expected).
      let signedOut = false;
      guard.expect((res) => signedOut && anonymousProbe(res));
      await page.getByTestId('account-button').click();
      signedOut = true;
      const [loggedOut] = await Promise.all([
        page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/auth/logout'),
        page.getByTestId('logout').click(),
      ]);
      expect(loggedOut.status()).toBe(204);
      await expect(page).toHaveURL(/\/login(\?.*)?$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Masuk ke LQ TTS', exact: true })).toBeVisible();
      await page.reload();
      await expect(page).toHaveURL(/\/login(\?.*)?$/);
    }
    await context.close();
  });
}
