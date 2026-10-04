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

  it('confirms in a full-width row under the item, moving focus into and out of the prompt', async () => {
    api.jobs.mockResolvedValue({ items: [summary('a')], nextBefore: null });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/history' });
    const row = await screen.findByTestId('history-row');
    await user.click(within(row).getByRole('button', { name: 'Hapus Naskah a' }));
    const confirm = screen.getByTestId('history-confirm');
    // Layout guard: the prompt sits in the wide title cell, never the narrow actions cell it used to overflow.
    const cells = row.querySelectorAll('td');
    expect(cells[0]).toContainElement(confirm);
    expect(cells[cells.length - 1]).not.toContainElement(confirm);
    expect(within(confirm).getByRole('alert')).toHaveTextContent('tidak bisa dibatalkan');
    expect(within(confirm).getByRole('button', { name: 'Hapus voiceover' })).toHaveFocus();
    await user.click(within(confirm).getByRole('button', { name: 'Batal' }));
    expect(api.deleteJob).not.toHaveBeenCalled();
    expect(screen.queryByTestId('history-confirm')).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Hapus Naskah a' })).toHaveFocus();
  });

  it('deletes a row after confirmation', async () => {
    api.jobs.mockResolvedValue({ items: [summary('a')], nextBefore: null });
    api.deleteJob.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/history' });
    const row = await screen.findByTestId('history-row');
    await user.click(within(row).getByRole('button', { name: 'Hapus Naskah a' }));
    await user.click(within(screen.getByTestId('history-confirm')).getByRole('button', { name: 'Hapus voiceover' }));
    expect(api.deleteJob).toHaveBeenCalledWith('a');
    expect(await screen.findByText('Belum ada voiceover')).toBeInTheDocument();
  });

  it('keeps paging instead of claiming emptiness when every loaded row was deleted', async () => {
    api.jobs
      .mockResolvedValueOnce({ items: [summary('a')], nextBefore: CURSOR })
      .mockResolvedValueOnce({ items: [summary('b')], nextBefore: null });
    api.deleteJob.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/history' });
    const row = await screen.findByTestId('history-row');
    await user.click(within(row).getByRole('button', { name: 'Hapus Naskah a' }));
    await user.click(within(screen.getByTestId('history-confirm')).getByRole('button', { name: 'Hapus voiceover' }));
    expect(await screen.findByRole('button', { name: 'Muat lagi' })).toBeInTheDocument();
    expect(screen.queryByText('Belum ada voiceover')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Muat lagi' }));
    expect(api.jobs).toHaveBeenLastCalledWith({ limit: 20, before: CURSOR });
    expect(await screen.findByRole('link', { name: 'Naskah b' })).toBeInTheDocument();
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

  it('offers download only for jobs that have audio from some revision', async () => {
    api.jobs.mockResolvedValue({
      items: [
        summary('done1'),
        summary('fail1', { status: 'failed' }),
        summary('fail2', { status: 'failed', revision: 2 }),
        summary('canc2', { status: 'canceled', revision: 2 }),
        summary('run2', { status: 'running', revision: 2 }),
      ],
      nextBefore: null,
    });
    renderRoutes(routes, { path: '/history' });
    await screen.findAllByTestId('history-row');
    const btn = (id) => screen.getByRole('button', { name: `Unduh Naskah ${id}` });
    expect(btn('done1')).toBeEnabled();
    expect(btn('fail1')).toBeDisabled();
    expect(btn('fail2')).toBeEnabled();
    expect(btn('canc2')).toBeEnabled();
    expect(btn('run2')).toBeDisabled();
  });
  it('teaches the first action when empty', async () => {
    api.jobs.mockResolvedValue({ items: [], nextBefore: null });
    renderRoutes(routes, { path: '/history' });
    expect(await screen.findByRole('link', { name: 'Buat voiceover pertama' })).toHaveAttribute('href', '/');
  });

  it('marks voiceovers made through the API', async () => {
    api.jobs.mockResolvedValue({ items: [summary('a', { source: 'api' }), summary('b', { source: 'web' })], nextBefore: null });
    renderRoutes(routes, { path: '/history' });
    const rows = await screen.findAllByTestId('history-row');
    expect(within(rows[0]).getByTestId('api-chip')).toHaveTextContent('API');
    expect(within(rows[1]).queryByTestId('api-chip')).not.toBeInTheDocument();
  });
});
