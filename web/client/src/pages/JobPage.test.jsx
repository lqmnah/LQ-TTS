import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, renderRoutes } from '../test/render.jsx';
import JobPage from './JobPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    api: { job: vi.fn(), sentences: vi.fn(), regenerate: vi.fn(), cancelJob: vi.fn(), deleteJob: vi.fn(), me: vi.fn() },
    openJobEvents: vi.fn(),
  };
});
const { api, openJobEvents } = await import('../lib/api.js');

const job = (over = {}) => ({
  id: 'j1', title: 'Halo semua. Ini kalimat kedua.', voiceId: 'v1', voiceName: 'Pandji', status: 'running', chars: 30, credits: 1,
  audioSeconds: null, revision: 1, createdAt: '2026-10-03T08:00:00Z', finishedAt: null, progress: { done: 0, total: 2 },
  needsReview: 0, settings: { speed: 0.9, pause_sentence_s: 0.45, pause_paragraph_s: 0.8, formats: ['mp3', 'wav', 'srt', 'vtt'] },
  files: {}, revisions: [1], errorCode: null, ...over,
});
const sentence = (idx, status, text = `Kalimat ${idx + 1}.`) => ({
  idx, paragraphIdx: 0, text, style: null, status, score: status === 'pending' ? null : 0.95,
  durationS: status === 'pending' ? null : 1.8, startS: null, endS: null, audioUrl: status === 'pending' ? null : `/api/jobs/j1/sentences/${idx}/audio`,
});
const FILES = {
  'final.mp3': '/api/jobs/j1/files/final.mp3?revision=1', 'final.wav': '/api/jobs/j1/files/final.wav?revision=1',
  'subs.srt': '/api/jobs/j1/files/subs.srt?revision=1', 'subs.vtt': '/api/jobs/j1/files/subs.vtt?revision=1',
};
const routes = [{ path: '/jobs/:id', element: <JobPage /> }, { path: '/history', element: <p>history page</p> }];

let handlers;
let close;
beforeEach(() => {
  vi.clearAllMocks();
  api.me.mockResolvedValue(ME);
  close = vi.fn();
  openJobEvents.mockImplementation((id, h) => {
    handlers = h;
    return close;
  });
});

describe('JobPage', () => {
  it('turns sentences done one by one from live events, then shows downloads', async () => {
    api.job.mockResolvedValue(job());
    api.sentences.mockResolvedValue([sentence(0, 'pending'), sentence(1, 'pending')]);
    renderRoutes(routes, { path: '/jobs/j1' });
    expect(await screen.findByText('0 dari 2 kalimat')).toBeInTheDocument();
    expect(openJobEvents).toHaveBeenCalledWith('j1', expect.any(Object));

    act(() => {
      handlers.onOpen();
      handlers.onEvent({ type: 'sentence_done', idx: 0, status: 'done', score: 0.97, revision: 1 });
    });
    expect(screen.getByText('1 dari 2 kalimat')).toBeInTheDocument();
    expect(screen.getByTestId('sentence-0')).toHaveAttribute('data-status', 'done');
    expect(screen.getByTestId('progress')).toHaveAttribute('data-done', '1');

    api.job.mockResolvedValue(job({ status: 'done', files: FILES, audioSeconds: 4.2 }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'done')]);
    act(() => {
      handlers.onEvent({ type: 'sentence_done', idx: 1, status: 'done', score: 0.9, revision: 1 });
      handlers.onEvent({ type: 'job_done', revision: 1 });
    });
    expect(close).toHaveBeenCalled();
    expect(await screen.findByTestId('job-finished')).toBeInTheDocument();
    expect(await screen.findByTestId('download-mp3')).toHaveAttribute('href', '/api/jobs/j1/files/final.mp3?revision=1');
    expect(screen.getByTestId('download-vtt')).toHaveAttribute('download', 'lq-tts-j1-r1.vtt');
    expect(screen.getByTestId('job-status')).toHaveAttribute('data-status', 'done');
  });

  it('regenerates one edited sentence and goes live again', async () => {
    api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'done')]);
    api.regenerate.mockResolvedValue({ revision: 2, credits: 1 });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    const row = await screen.findByTestId('sentence-1');
    expect(openJobEvents).not.toHaveBeenCalled();
    await user.click(within(row).getByRole('button', { name: 'Ubah' }));
    const box = within(row).getByLabelText('Teks kalimat');
    await user.clear(box);
    await user.type(box, 'Kalimat baru yang lebih jelas.');
    expect(within(row).getByText('Biaya 1 kredit')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Buat ulang' }));
    expect(api.regenerate).toHaveBeenCalledWith('j1', 1, { text: 'Kalimat baru yang lebih jelas.' });
    expect(await screen.findByText('Dalam antrean')).toBeInTheDocument();
    expect(screen.getByTestId('sentence-1')).toHaveAttribute('data-status', 'pending');
    expect(openJobEvents).toHaveBeenCalledTimes(1);
  });

  it('explains a failed job and the refund', async () => {
    api.job.mockResolvedValue(job({ status: 'failed', errorCode: 'synthesis_failed' }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'pending')]);
    renderRoutes(routes, { path: '/jobs/j1' });
    expect(await screen.findByText('Mesin gagal membuat audio untuk naskah ini. Kredit sudah dikembalikan.')).toBeInTheDocument();
    expect(openJobEvents).not.toHaveBeenCalled();
  });

  it('switches revisions for downloads', async () => {
    api.job.mockResolvedValue(job({ status: 'done', files: FILES, revision: 2, revisions: [1, 2] }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'done')]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    const select = await screen.findByTestId('revision-select');
    expect(select).toHaveValue('2');
    await user.selectOptions(select, '1');
    expect(screen.getByTestId('download-wav')).toHaveAttribute('href', '/api/jobs/j1/files/final.wav?revision=1');
  });

  it('deletes after an inline confirmation and returns to history', async () => {
    api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
    api.sentences.mockResolvedValue([sentence(0, 'done')]);
    api.deleteJob.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    await user.click(await screen.findByRole('button', { name: 'Hapus voiceover' }));
    expect(screen.getByText('Hapus voiceover ini beserta semua revisinya? Tindakan ini tidak bisa dibatalkan.')).toBeInTheDocument();
    const confirm = screen.getAllByRole('button', { name: 'Hapus voiceover' }).at(-1);
    await user.click(confirm);
    expect(api.deleteJob).toHaveBeenCalledWith('j1');
    expect(await screen.findByText('history page')).toBeInTheDocument();
  });

  it('shows a not-found state for a foreign or deleted job', async () => {
    const { ApiError } = await import('../lib/api.js');
    api.job.mockRejectedValue(new ApiError(404, 'not_found', ''));
    api.sentences.mockRejectedValue(new ApiError(404, 'not_found', ''));
    renderRoutes(routes, { path: '/jobs/j404' });
    expect(await screen.findByText('Voiceover tidak ditemukan')).toBeInTheDocument();
  });

  it('keeps Cancel usable and explains a busy cancel', async () => {
    const { ApiError } = await import('../lib/api.js');
    api.job.mockResolvedValue(job());
    api.sentences.mockResolvedValue([sentence(0, 'pending')]);
    api.cancelJob.mockRejectedValue(new ApiError(409, 'not_regeneratable', ''));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    await user.click(await screen.findByRole('button', { name: 'Batalkan proses' }));
    expect(await screen.findByText('Perubahan sebelumnya masih diproses. Coba batalkan lagi dalam beberapa detik.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Batalkan proses' })).toBeEnabled();
  });

  it('offers Edit only on finished jobs', async () => {
    api.job.mockResolvedValue(job({ status: 'canceled' }));
    api.sentences.mockResolvedValue([sentence(0, 'done')]);
    renderRoutes(routes, { path: '/jobs/j1' });
    const row = await screen.findByTestId('sentence-0');
    expect(within(row).getByRole('button', { name: 'Ubah' })).toBeDisabled();
  });

  it('shows the busy reason when a regenerate is refused', async () => {
    const { ApiError } = await import('../lib/api.js');
    api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
    api.sentences.mockResolvedValue([sentence(0, 'done')]);
    api.regenerate.mockRejectedValue(new ApiError(409, 'not_regeneratable', ''));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    const row = await screen.findByTestId('sentence-0');
    await user.click(within(row).getByRole('button', { name: 'Ubah' }));
    await user.click(within(row).getByRole('button', { name: 'Buat ulang' }));
    expect(await within(row).findByText('Kalimat ini belum bisa dibuat ulang. Tunggu proses yang sedang berjalan selesai.')).toBeInTheDocument();
  });

  it('maps a rejected regenerate text to the one-sentence rule', async () => {
    const { ApiError } = await import('../lib/api.js');
    api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
    api.sentences.mockResolvedValue([sentence(0, 'done')]);
    api.regenerate.mockRejectedValue(new ApiError(400, 'invalid_request', ''));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    const row = await screen.findByTestId('sentence-0');
    await user.click(within(row).getByRole('button', { name: 'Ubah' }));
    await user.click(within(row).getByRole('button', { name: 'Buat ulang' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Isi tepat satu kalimat.');
  });

  it('downloads the files the server has while a newer revision is running', async () => {
    api.job.mockResolvedValue(job({ status: 'queued', revision: 2, revisions: [1, 2], files: FILES }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'pending')]);
    renderRoutes(routes, { path: '/jobs/j1' });
    expect(await screen.findByTestId('download-mp3')).toHaveAttribute('href', '/api/jobs/j1/files/final.mp3?revision=1');
    expect(screen.getByTestId('download-mp3')).toHaveAttribute('download', 'lq-tts-j1-r1.mp3');
    expect(screen.getByTestId('final-audio')).toHaveAttribute('src', '/api/jobs/j1/files/final.mp3?revision=1');
  });
});
