import { statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_FILE, SAMPLE_AUDIO, STATE_FILE, credentials } from '../target.mjs';
import { anonymousProbe, expect, test } from './fixtures.js';
import { enterTwoFactor } from './two-factor.js';

const SCRIPT = [
  'Halo, ini uji suara dari LQ TTS untuk memastikan semuanya berjalan dengan baik.',
  'Kalimat kedua memastikan progres tampil satu per satu di layar.',
  'Terima kasih sudah mendengarkan sampai selesai.',
].join(' ');
const NEW_SECOND = 'Kalimat kedua sekarang dibuat ulang dengan teks yang baru.';
const PANDJI_SCRIPT = 'Halo, ini Pandji dari LQ TTS. Suara ini bisa dipakai semua akun.';

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

test('journey: login with 2FA, VO Profile voiceover, clone, generate, live progress, regenerate, download, ID and EN', async ({ page, guard }) => {
  const creds = credentials();
  let signedIn = false;
  guard.expect((res) => !signedIn && anonymousProbe(res));

  // 1. Login with 2FA
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Masuk ke LQ TTS', exact: true })).toBeVisible();
  await page.getByLabel('Email atau username', { exact: true }).fill(creds.identifier);
  await page.getByLabel('Kata sandi', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Verifikasi dua langkah', exact: true })).toBeVisible();
  await enterTwoFactor(page, creds, guard);
  await expect(page.getByRole('heading', { level: 1, name: 'Teks ke Suara', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  signedIn = true;

  // Leftovers of an earlier failed run must not eat the plan's voice limit.
  const before = await apiCall(page, 'GET', '/voices');
  for (const v of before.json.filter((x) => x.name.startsWith('E2E '))) await apiCall(page, 'DELETE', `/voices/${v.id}`);

  // 1b. VO Profile: the Pandji card is on the Voices page, previews, and makes one short voiceover at the normal price
  await page.getByRole('link', { name: 'Suara', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'VO Profile', exact: true })).toBeVisible();
  const pandjiCard = page.getByTestId('profile-card').filter({ hasText: 'Pandji' });
  await expect(pandjiCard).toHaveAttribute('data-status', 'ready');
  await expect(pandjiCard.getByRole('button', { name: /^Hapus/ })).toHaveCount(0);
  const pandjiPreview = pandjiCard.getByRole('button', { name: 'Dengarkan contoh Pandji', exact: true });
  await pandjiPreview.click();
  await expect(pandjiPreview).toHaveAttribute('aria-pressed', 'true');
  await pandjiPreview.click();
  await expect(pandjiPreview).toHaveAttribute('aria-pressed', 'false');
  await pandjiCard.getByRole('link', { name: 'Pakai suara ini: Pandji', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Teks ke Suara', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/); // ?voice= was adopted into the draft and dropped from the URL
  await expect(page.getByLabel('Suara', { exact: true }).locator('option:checked')).toHaveText('Pandji');
  await page.getByLabel('Naskah', { exact: true }).fill(PANDJI_SCRIPT);
  await expect(page.getByTestId('price')).toHaveText('Sekitar 1 kredit (Rp100)');
  // Evidence for SOP G5: the composer with the VO Profile selected.
  await page.screenshot({ path: new URL('../artifacts/journey/tts-pandji.png', import.meta.url).pathname, animations: 'disabled' });
  await page.getByTestId('generate').click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const pandjiJobId = new URL(page.url()).pathname.split('/').pop();
  await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done', { timeout: 300_000 });
  await expect(page.getByText('Pandji', { exact: true }).first()).toBeVisible();
  // Leave the job page before deleting it, so nothing on screen asks for a job that is gone.
  await page.getByRole('link', { name: 'Suara', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Suara', exact: true })).toBeVisible();
  const pandjiJobDeleted = await apiCall(page, 'DELETE', `/jobs/${pandjiJobId}`);
  expect(pandjiJobDeleted.status).toBe(204);

  // 2. Clone a voice (consent is required)
  await page.getByRole('link', { name: 'Suara', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Suara', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Kloning suara', exact: true }).click();
  const voiceName = `E2E Pandji ${Date.now().toString(36)}`;
  // Too large is refused in the browser before any upload (95 MB + 1 byte, sparse file, no network request).
  const tooBig = join(tmpdir(), 'lq-tts-e2e-too-big.mp3');
  writeFileSync(tooBig, '');
  truncateSync(tooBig, 95 * 1024 * 1024 + 1);
  await page.getByLabel('Rekaman', { exact: true }).setInputFiles(tooBig);
  await expect(page.getByText('Berkas lebih dari 95 MB. Ekspor ulang rekamannya sebagai MP3 atau M4A supaya lebih kecil.', { exact: true })).toBeVisible();
  await page.getByLabel('Rekaman', { exact: true }).setInputFiles(SAMPLE_AUDIO);
  await expect(page.getByText('Berkas lebih dari 95 MB. Ekspor ulang rekamannya sebagai MP3 atau M4A supaya lebih kecil.', { exact: true })).toHaveCount(0);
  await page.getByLabel('Nama suara', { exact: true }).fill(voiceName);
  await page.getByRole('radio', { name: 'Indonesia', exact: true }).click();
  await page.getByRole('button', { name: 'Mulai kloning', exact: true }).click();
  await expect(page.getByText('Centang persetujuan dulu sebelum mengkloning suara.', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /^Saya pemilik suara ini/ }).check();
  await page.getByRole('button', { name: 'Mulai kloning', exact: true }).click();
  const voiceRow = page.getByTestId('voice-row').filter({ hasText: voiceName });
  await expect(voiceRow).toHaveAttribute('data-status', 'ready', { timeout: 240_000 });
  const preview = voiceRow.getByRole('button', { name: `Dengarkan contoh ${voiceName}`, exact: true });
  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'false');

  // 3. Generate with the live price
  await page.getByRole('link', { name: 'Teks ke Suara', exact: true }).click();
  await page.getByLabel('Naskah', { exact: true }).fill(SCRIPT);
  await expect(page.getByLabel('Naskah', { exact: true })).toHaveValue(SCRIPT);
  await page.getByLabel('Suara', { exact: true }).selectOption({ label: voiceName });
  const credits = Math.max(1, Math.ceil([...SCRIPT].length / 100));
  await expect(page.getByTestId('price')).toHaveText(`Sekitar ${credits} kredit (Rp${(credits * 100).toLocaleString('id-ID')})`);
  const events = page.waitForResponse((r) => /\/api\/jobs\/[^/]+\/events$/.test(r.url()) && (r.headers()['content-type'] ?? '').startsWith('text/event-stream'));
  await page.getByTestId('generate').click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobId = new URL(page.url()).pathname.split('/').pop();
  await events;

  // 4. Live progress: sentences turn done one by one
  const progress = page.getByTestId('progress');
  const seen = new Set();
  await expect.poll(async () => {
    const done = Number(await progress.getAttribute('data-done'));
    const total = Number(await progress.getAttribute('data-total'));
    seen.add(`${done}/${total}`);
    return total > 0 && done === total ? 'complete' : 'pending';
  }, { timeout: 300_000, intervals: [100] }).toBe('complete');
  const partial = [...seen].some((v) => { const [d, t] = v.split('/').map(Number); return d > 0 && d < t; });
  expect(partial, `a partial state was rendered live: ${[...seen].join(', ')}`).toBe(true);
  await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  await expect(page.getByTestId('job-finished')).toBeVisible();

  // 5. Play one sentence
  const play1 = page.getByTestId('sentence-0').getByRole('button', { name: 'Putar kalimat 1', exact: true });
  await play1.click();
  await expect(play1).toHaveAttribute('aria-pressed', 'true');
  await play1.click();

  // 6. Edit and regenerate one sentence, revision 2 appears
  const s1 = page.getByTestId('sentence-1');
  await s1.getByRole('button', { name: 'Ubah', exact: true }).click();
  const box = s1.getByLabel('Teks kalimat', { exact: true });
  await box.fill(NEW_SECOND);
  await expect(box).toHaveValue(NEW_SECOND);
  await s1.getByRole('button', { name: 'Buat ulang', exact: true }).click();
  await expect(page.getByTestId('job-status')).not.toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done', { timeout: 240_000 });
  await expect(page.getByTestId('revision-select')).toHaveValue('2');
  await expect(page.getByTestId('sentence-1')).toContainText(NEW_SECOND);

  // 7. Download MP3 of the current revision
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-mp3').click()]);
  expect(download.suggestedFilename()).toMatch(/\.mp3$/);
  expect(statSync(await download.path()).size).toBeGreaterThan(10_000);

  // 7b. Switch back to revision 1 and fetch that revision's MP3
  await page.getByTestId('revision-select').selectOption('1');
  await expect(page.getByTestId('revision-select')).toHaveValue('1');
  await expect(page.getByTestId('download-mp3')).toHaveAttribute('href', /[?&]revision=1(&|$)/);
  const [download1] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-mp3').click()]);
  expect(download1.url()).toMatch(/[?&]revision=1(&|$)/);
  expect(download1.suggestedFilename()).toMatch(/\.mp3$/);
  expect(statSync(await download1.path()).size).toBeGreaterThan(10_000);
  await page.getByTestId('revision-select').selectOption('2');

  // 8. ID ⇄ EN, persisted on the server session
  await page.getByTestId('account-button').click();
  await page.getByRole('radio', { name: 'English', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Voices', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Sentences', exact: true })).toBeVisible();

  // 9. History and Credits reflect the job and both charges
  await page.getByRole('link', { name: 'History', exact: true }).click();
  const historyRow = page.locator(`[data-testid="history-row"][data-job-id="${jobId}"]`);
  await expect(historyRow).toHaveCount(1);
  // 9b. History plays the newest revision in a player under its row
  await historyRow.getByTestId('history-play').click();
  // The player is its own row under the voiceover's row.
  const historyPlayer = page.locator(`[data-testid="history-player"][data-job-id="${jobId}"]`);
  const historyAudio = historyPlayer.locator('audio');
  await expect(historyAudio).toHaveAttribute('src', /\/files\/final\.mp3\?revision=2$/);
  await expect.poll(() => historyAudio.evaluate((a) => !a.paused && a.currentTime > 0), { timeout: 15_000 }).toBe(true);
  await expect(historyRow.getByTestId('history-play')).toHaveAttribute('aria-pressed', 'true');
  await historyPlayer.getByRole('button', { name: 'Close player', exact: true }).click();
  await expect(historyPlayer).toHaveCount(0);
  await page.getByRole('link', { name: 'Credits', exact: true }).click();
  await expect(page.locator(`[data-testid="usage-row"][data-job-id="${jobId}"]`)).toHaveCount(2);

  // Back to Indonesian for the screenshot pass, keep the session for it.
  const back = await apiCall(page, 'PATCH', '/me', { lang: 'id' });
  expect(back.status).toBe(200);
  writeFileSync(STATE_FILE, JSON.stringify({ jobId, voiceName }));
  await page.context().storageState({ path: AUTH_FILE });
});
