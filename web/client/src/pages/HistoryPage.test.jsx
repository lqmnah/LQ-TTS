import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes } from '../test/render.jsx';
import HistoryPage from './HistoryPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { jobs: vi.fn(), job: vi.fn(), deleteJob: vi.fn() } };
});
vi.mock('../lib/download.js', () => ({ triggerDownload: vi.fn() }));
const { api } = await import('../lib/api.js');
const { triggerDownload } = await import('../lib/download.js');

// The server cursor is opaque (`<µs timestamp>|<uuid>`); the client passes it back unchanged.
const CURSOR = '2026-10-02T00:00:00.123456Z|0b6c2a4e-8f1d-4c3a-9e2b-5d7f1a0c3b9e';

const summary = (id, over = {}) => ({
  id, title: `Naskah ${id}`, voiceId: 'v1', voiceName: 'Pandji', status: 'done', chars: 1234, credits: 13,
  audioSeconds: 75.2, revision: 1, createdAt: '2026-10-03T08:00:00Z', finishedAt: '2026-10-03T08:01:00Z', ...over,
});
const routes = [{ path: '/history', element: <HistoryPage /> }, { path: '/', element: <p>tts page</p> }];

beforeEach(() => vi.clearAllMocks());

describe('HistoryPage', () => {
  it('lists voiceovers and pages with the opaque nextBefore cursor', async () => {
    api.jobs
      .mockResolvedValueOnce({ items: [summary('a'), summary('b', { voiceName: null, status: 'failed' })], nextBefore: CURSOR })
      .mockResolvedValueOnce({ items: [summary('c')], nextBefore: null });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/history' });
    expect(await screen.findByRole('link', { name: 'Naskah a' })).toHaveAttribute('href', '/jobs/a');
    expect(screen.getAllByText(/Suara terhapus/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Muat lagi' }));
    expect(api.jobs).toHaveBeenLastCalledWith({ limit: 20, before: CURSOR });
    expect(await screen.findByRole('link', { name: 'Naskah c' })).toBeInTheDocument();
    expect(screen.getAllByTestId('history-row')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Muat lagi' })).not.toBeInTheDocument();
  });

  it('confirms inline before deleting, moving focus into and out of the prompt', async () => {
    api.jobs.mockResolvedValue({ items: [summary('a')], nextBefore: null });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/history' });
    const row = await screen.findByTestId('history-row');
    const trigger = within(row).getByRole('button', { name: 'Hapus Naskah a' });
    await user.click(trigger);
    expect(within(row).getByRole('alert')).toHaveTextContent('tidak bisa dibatalkan');
    expect(within(row).getByRole('button', { name: 'Hapus voiceover' })).toHaveFocus();
    await user.click(within(row).getByRole('button', { name: 'Batal' }));
    expect(api.deleteJob).not.toHaveBeenCalled();
    expect(within(row).getByRole('button', { name: 'Hapus Naskah a' })).toHaveFocus();
  });

  it('deletes a row after confirmation', async () => {
    api.jobs.mockResolvedValue({ items: [summary('a')], nextBefore: null });
    api.deleteJob.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/history' });
    const row = await screen.findByTestId('history-row');
    await user.click(within(row).getByRole('button', { name: 'Hapus Naskah a' }));
    await user.click(within(row).getByRole('button', { name: 'Hapus voiceover' }));
    expect(api.deleteJob).toHaveBeenCalledWith('a');
    expect(await screen.findByText('Belum ada voiceover')).toBeInTheDocument();
  });

  it('downloads the file URL the server lists for the job', async () => {
    api.jobs.mockResolvedValue({ items: [summary('a1234567xyz')], nextBefore: null });
    api.job.mockResolvedValue({
      ...summary('a1234567xyz', { revision: 3 }),
      files: { 'final.wav': '/api/jobs/a1234567xyz/files/final.wav?revision=2', 'final.mp3': '/api/jobs/a1234567xyz/files/final.mp3?revision=2' },
    });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/history' });
    const row = await screen.findByTestId('history-row');
    await user.click(within(row).getByRole('button', { name: 'Unduh Naskah a1234567xyz' }));
    expect(triggerDownload).toHaveBeenCalledWith('/api/jobs/a1234567xyz/files/final.mp3?revision=2', 'lq-tts-a1234567-r2.mp3');
  });

  it('teaches the first action when empty', async () => {
    api.jobs.mockResolvedValue({ items: [], nextBefore: null });
    renderRoutes(routes, { path: '/history' });
    expect(await screen.findByRole('link', { name: 'Buat voiceover pertama' })).toHaveAttribute('href', '/');
  });
});
