import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18n } from '../i18n/index.jsx';
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

  it('keeps the earlier revision when a regenerate fails, refunding only that change', async () => {
    api.job.mockResolvedValue(job({ status: 'failed', errorCode: 'synthesis_failed', revision: 2 }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'done')]);
    renderRoutes(routes, { path: '/jobs/j1' });
    expect(
      await screen.findByText('Perubahan ini gagal. Hanya kredit perubahan ini yang dikembalikan; revisi 1 masih tersedia di bawah.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Kredit sudah dikembalikan/)).not.toBeInTheDocument();
  });
  it('explains a failed job and the refund', async () => {
    api.job.mockResolvedValue(job({ status: 'failed', errorCode: 'synthesis_failed' }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'pending')]);
    renderRoutes(routes, { path: '/jobs/j1' });
    expect(await screen.findByText('Mesin gagal membuat audio untuk naskah ini. Kredit sudah dikembalikan.')).toBeInTheDocument();
    expect(openJobEvents).not.toHaveBeenCalled();
  });

  it('switches revisions for downloads', async () => {
    const files2 = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, v.replace('revision=1', 'revision=2')]));
    api.job.mockResolvedValue(job({ status: 'done', files: files2, revision: 2, revisions: [1, 2] }));
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
    expect(within(row).getByRole('button', { name: 'Ubah' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Ubah' }));
    expect(within(row).queryByLabelText('Teks kalimat')).not.toBeInTheDocument();
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

  it('shows a failed delete as a translated notice that follows the language', async () => {
    const { ApiError } = await import('../lib/api.js');
    function English() {
      const { setLang } = useI18n();
      return <button type="button" onClick={() => setLang('en')}>to-en</button>;
    }
    const withSwitch = [{ path: '/jobs/:id', element: <><JobPage /><English /></> }];
    api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
    api.sentences.mockResolvedValue([sentence(0, 'done')]);
    api.deleteJob.mockRejectedValue(new ApiError(503, 'engine_unavailable', ''));
    const user = userEvent.setup();
    renderRoutes(withSwitch, { path: '/jobs/j1' });
    await user.click(await screen.findByRole('button', { name: 'Hapus voiceover' }));
    await user.click(screen.getAllByRole('button', { name: 'Hapus voiceover' }).at(-1));
    expect(await screen.findByText('Mesin suara sedang tidak dapat dihubungi. Coba lagi sebentar lagi.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'to-en' }));
    expect(screen.getByText('The voice engine is unreachable right now. Try again shortly.')).toBeInTheDocument();
  });

  it('moves focus into the delete prompt and back on cancel', async () => {
    api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
    api.sentences.mockResolvedValue([sentence(0, 'done')]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    await user.click(await screen.findByRole('button', { name: 'Hapus voiceover' }));
    const confirm = screen.getByRole('button', { name: 'Hapus voiceover' });
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAccessibleDescription('Hapus voiceover ini beserta semua revisinya? Tindakan ini tidak bisa dibatalkan.');
    await user.click(screen.getByRole('button', { name: 'Batal' }));
    expect(screen.getByRole('button', { name: 'Hapus voiceover' })).toHaveFocus();
  });

  it('focuses the sentence editor and returns focus to Edit on cancel and after a regenerate', async () => {
    api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
    api.sentences.mockResolvedValue([sentence(0, 'done')]);
    api.regenerate.mockResolvedValue({ revision: 2, credits: 1 });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    const row = await screen.findByTestId('sentence-0');
    const edit = within(row).getByRole('button', { name: 'Ubah' });
    await user.click(edit);
    expect(within(row).getByLabelText('Teks kalimat')).toHaveFocus();
    await user.click(within(row).getByRole('button', { name: 'Batal' }));
    expect(edit).toHaveFocus();
    await user.click(edit);
    await user.click(within(row).getByRole('button', { name: 'Buat ulang' }));
    await waitFor(() => expect(edit).toHaveFocus());
    expect(edit).toHaveAttribute('aria-disabled', 'true');
  });

  describe('when the event stream closes for good', () => {
    afterEach(() => vi.useRealTimers());

    it('reloads after a backoff and reopens the stream', async () => {
      api.job.mockResolvedValue(job());
      api.sentences.mockResolvedValue([sentence(0, 'pending'), sentence(1, 'pending')]);
      renderRoutes(routes, { path: '/jobs/j1' });
      await screen.findByText('0 dari 2 kalimat');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      act(() => handlers.onError({ closed: false }));
      expect(screen.getByText('Menyambung ulang ke progres langsung...')).toBeInTheDocument();
      expect(close).not.toHaveBeenCalled();
      act(() => handlers.onError({ closed: true }));
      expect(close).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(1999));
      expect(api.job).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(1));
      expect(api.job).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
      await waitFor(() => expect(openJobEvents).toHaveBeenCalledTimes(2));
    });

    async function closeAndReload() {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      act(() => handlers.onError({ closed: true }));
      await act(async () => vi.advanceTimersByTime(2000));
      vi.useRealTimers();
    }

    it('shows the not-found state and stops reopening when the job was deleted meanwhile', async () => {
      const { ApiError } = await import('../lib/api.js');
      api.job.mockResolvedValue(job());
      api.sentences.mockResolvedValue([sentence(0, 'pending')]);
      renderRoutes(routes, { path: '/jobs/j1' });
      await screen.findByText('0 dari 1 kalimat');
      api.job.mockRejectedValue(new ApiError(404, 'not_found', ''));
      api.sentences.mockRejectedValue(new ApiError(404, 'not_found', ''));
      await closeAndReload();
      expect(await screen.findByText('Voiceover tidak ditemukan')).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 20));
      expect(openJobEvents).toHaveBeenCalledTimes(1);
    });

    it('shows other reload failures and keeps trying', async () => {
      const { ApiError } = await import('../lib/api.js');
      api.job.mockResolvedValue(job());
      api.sentences.mockResolvedValue([sentence(0, 'pending')]);
      renderRoutes(routes, { path: '/jobs/j1' });
      await screen.findByText('0 dari 1 kalimat');
      api.job.mockRejectedValue(new ApiError(503, 'engine_unavailable', ''));
      await closeAndReload();
      expect(await screen.findByText('Mesin suara sedang tidak dapat dihubungi. Coba lagi sebentar lagi.')).toBeInTheDocument();
      await waitFor(() => expect(openJobEvents).toHaveBeenCalledTimes(2));
    });

    it('settles a job that ended while the stream was down: balance refresh, Cancel reset, no reopen', async () => {
      api.job.mockResolvedValue(job());
      api.sentences.mockResolvedValue([sentence(0, 'pending')]);
      api.cancelJob.mockReturnValue(new Promise(() => {}));
      const user = userEvent.setup();
      renderRoutes(routes, { path: '/jobs/j1' });
      await user.click(await screen.findByRole('button', { name: 'Batalkan proses' }));
      expect(screen.getByRole('button', { name: 'Batalkan proses' })).toHaveAttribute('aria-busy', 'true');
      const meCalls = api.me.mock.calls.length;
      api.job.mockResolvedValue(job({ status: 'failed', errorCode: 'synthesis_failed' }));
      await closeAndReload();
      expect(await screen.findByText('Mesin gagal membuat audio untuk naskah ini. Kredit sudah dikembalikan.')).toBeInTheDocument();
      await waitFor(() => expect(api.me.mock.calls.length).toBeGreaterThan(meCalls));
      expect(openJobEvents).toHaveBeenCalledTimes(1);
    });

    it('clears a pending Cancel when the reload finds the job done, so a later regenerate can cancel again', async () => {
      api.job.mockResolvedValue(job());
      api.sentences.mockResolvedValue([sentence(0, 'pending')]);
      api.cancelJob.mockReturnValue(new Promise(() => {}));
      api.regenerate.mockResolvedValue({ revision: 2, credits: 1 });
      const user = userEvent.setup();
      renderRoutes(routes, { path: '/jobs/j1' });
      await user.click(await screen.findByRole('button', { name: 'Batalkan proses' }));
      api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
      api.sentences.mockResolvedValue([sentence(0, 'done')]);
      await closeAndReload();
      expect(await screen.findByTestId('job-finished')).toBeInTheDocument();
      const row = screen.getByTestId('sentence-0');
      await user.click(within(row).getByRole('button', { name: 'Ubah' }));
      await user.click(within(row).getByRole('button', { name: 'Buat ulang' }));
      expect(await screen.findByRole('button', { name: 'Batalkan proses' })).not.toHaveAttribute('aria-busy');
    });
  });

  describe('single audio', () => {
    let play;
    let pause;
    beforeEach(() => {
      play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(function play() {
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      });
      pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(function pause() {
        this.dispatchEvent(new Event('pause'));
      });
    });
    afterEach(() => {
      play.mockRestore();
      pause.mockRestore();
    });

    it('pauses a sentence clip when the final audio plays, and the other way round', async () => {
      api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
      api.sentences.mockResolvedValue([sentence(0, 'done')]);
      const user = userEvent.setup();
      renderRoutes(routes, { path: '/jobs/j1' });
      const final = await screen.findByTestId('final-audio');
      fireEvent.play(final);
      await user.click(screen.getByRole('button', { name: 'Putar kalimat 1' }));
      expect(pause.mock.contexts).toContain(final);
      expect(screen.getByRole('button', { name: 'Putar kalimat 1' })).toHaveAttribute('aria-pressed', 'true');
      pause.mockClear();
      fireEvent.play(final);
      expect(pause).toHaveBeenCalledTimes(1);
      expect(pause.mock.contexts[0]).not.toBe(final);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Putar kalimat 1' })).toHaveAttribute('aria-pressed', 'false'));
    });
  });
});
