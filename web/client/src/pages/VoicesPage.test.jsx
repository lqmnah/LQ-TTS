import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, renderRoutes } from '../test/render.jsx';
import VoicesPage from './VoicesPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { voices: vi.fn(), voiceProfiles: vi.fn(), deleteVoice: vi.fn(), me: vi.fn() }, createVoice: vi.fn() };
});
const { api, createVoice, ApiError } = await import('../lib/api.js');

const voice = (over) => ({ id: 'v1', name: 'Pandji', language: 'id', status: 'ready', errorCode: null, refSeconds: 14.2, createdAt: '2026-10-03T08:00:00.000Z', previewUrl: '/api/voices/v1/preview', ...over });
const routes = [{ path: '/voices', element: <VoicesPage /> }];
const profile = (over) => ({
  id: 'p1', slug: 'pandji', name: 'Pandji', gender: 'male', language: 'id', status: 'ready', errorCode: null,
  description: { id: 'Pria, bariton hangat.', en: 'Male, warm baritone.' },
  tags: [{ id: 'Pria', en: 'Male' }, { id: 'Tegas', en: 'Firm' }],
  bestFor: { id: 'Narasi, podcast.', en: 'Narration, podcasts.' },
  previewUrl: '/api/voices/p1/preview',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.me.mockResolvedValue(ME);
  api.voiceProfiles.mockResolvedValue([]);
});

describe('VoicesPage', () => {
  it('requires consent before uploading', async () => {
    api.voices.mockResolvedValueOnce([]).mockResolvedValue([voice({ id: 'v9', status: 'processing', previewUrl: null })]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    await user.upload(screen.getByLabelText('Rekaman'), new File(['RIFF'], 'pandji.wav', { type: 'audio/wav' }));
    await user.type(screen.getByLabelText('Nama suara'), 'Pandji');
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(screen.getByText('Centang persetujuan dulu sebelum mengkloning suara.')).toBeInTheDocument();
    expect(createVoice).not.toHaveBeenCalled();

    createVoice.mockResolvedValue({ id: 'v9', status: 'processing' });
    await user.click(screen.getByRole('checkbox', { name: /Saya pemilik suara ini/ }));
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(createVoice).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pandji', language: 'auto', transcript: '', consent: true }),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(await screen.findByText('Suara sedang diproses. Biasanya selesai dalam satu menit.')).toBeInTheDocument();
  });

  it('rejects unsupported files in the browser', async () => {
    api.voices.mockResolvedValue([]);
    const user = userEvent.setup({ applyAccept: false });
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    await user.upload(screen.getByLabelText('Rekaman'), new File(['x'], 'clip.ogg', { type: 'audio/ogg' }));
    expect(screen.getByText('Format ini tidak didukung. Pakai MP3, WAV, M4A, atau FLAC.')).toBeInTheDocument();
  });

  it('refuses recordings over 95 MB and suggests MP3 or M4A', async () => {
    api.voices.mockResolvedValue([]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    const big = new File(['RIFF'], 'long-take.wav', { type: 'audio/wav' });
    Object.defineProperty(big, 'size', { value: 95 * 1024 * 1024 + 1 });
    await user.upload(screen.getByLabelText('Rekaman'), big);
    expect(screen.getByText('Berkas lebih dari 95 MB. Ekspor ulang rekamannya sebagai MP3 atau M4A supaya lebih kecil.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Nama suara'), 'Panjang');
    await user.click(screen.getByRole('checkbox', { name: /Saya pemilik suara ini/ }));
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(createVoice).not.toHaveBeenCalled();
  });

  it('blocks cloning at the plan limit and counts failed voices out', async () => {
    api.voices.mockResolvedValue([voice({ id: 'a' }), voice({ id: 'b', status: 'processing' }), voice({ id: 'c' }), voice({ id: 'd', status: 'failed', errorCode: 'no_clean_speech' })]);
    renderRoutes(routes, { path: '/voices' });
    expect(await screen.findByText('3 dari 3 suara terpakai')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kloning suara' })).toBeDisabled();
    expect(screen.getByTestId('voice-limit')).toHaveTextContent('Batas 3 suara untuk paket kamu sudah penuh.');
    expect(screen.getByText('Rekaman perlu minimal 8 detik ucapan jernih tanpa musik atau jeda panjang.')).toBeInTheDocument();
  });

  it('shows the server reason when the upload is refused', async () => {
    api.voices.mockResolvedValue([]);
    createVoice.mockRejectedValue(new ApiError(403, 'voice_limit_reached', ''));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    await user.upload(screen.getByLabelText('Rekaman'), new File(['RIFF'], 'a.wav', { type: 'audio/wav' }));
    await user.type(screen.getByLabelText('Nama suara'), 'A');
    await user.click(screen.getByRole('checkbox', { name: /Saya pemilik suara ini/ }));
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(await screen.findByText('Batas suara paket kamu sudah penuh. Hapus satu suara atau upgrade paket.')).toBeInTheDocument();
  });

  it('deletes a voice after an inline confirmation', async () => {
    api.voices.mockResolvedValueOnce([voice()]).mockResolvedValueOnce([]);
    api.deleteVoice.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    const row = await screen.findByTestId('voice-row');
    await user.click(within(row).getByRole('button', { name: 'Hapus suara Pandji' }));
    expect(within(row).getByText('Hapus Pandji? Semua voiceover yang memakai suara ini ikut terhapus.')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Hapus' }));
    expect(api.deleteVoice).toHaveBeenCalledWith('v1');
    expect(await screen.findByText('Belum ada suara')).toBeInTheDocument();
  });

  it('explains a concurrent upload (409 voice_not_ready) instead of the job-level text', async () => {
    api.voices.mockResolvedValue([]);
    createVoice.mockRejectedValue(new ApiError(409, 'voice_not_ready', ''));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    await user.upload(screen.getByLabelText('Rekaman'), new File(['RIFF'], 'a.wav', { type: 'audio/wav' }));
    await user.type(screen.getByLabelText('Nama suara'), 'A');
    await user.click(screen.getByRole('checkbox', { name: /Saya pemilik suara ini/ }));
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(await screen.findByText('Masih ada unggahan suara lain yang berjalan. Tunggu sampai selesai, lalu coba lagi.')).toBeInTheDocument();
  });

  it('caps name and transcript at the server limits', async () => {
    api.voices.mockResolvedValue([]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    expect(screen.getByLabelText('Nama suara')).toHaveAttribute('maxLength', '80');
    expect(screen.getByLabelText('Transkrip (opsional)')).toHaveAttribute('maxLength', '5000');
  });

  it('renders a voice without a language and still lists it', async () => {
    api.voices.mockResolvedValue([voice({ language: null })]);
    renderRoutes(routes, { path: '/voices' });
    const row = await screen.findByTestId('voice-row');
    expect(within(row).getByText('Pandji')).toBeInTheDocument();
    expect(within(row).getByText('–')).toBeInTheDocument();
  });

  it('shows an en dash when the voice list cannot load and the count is unknown', async () => {
    api.voices.mockRejectedValue(new ApiError(502, 'engine_unavailable', ''));
    renderRoutes(routes, { path: '/voices', me: { ...ME, voiceCount: null } });
    expect(await screen.findByText('– dari 3 suara terpakai')).toBeInTheDocument();
  });

  async function openFilledForm(user) {
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    await user.upload(screen.getByLabelText('Rekaman'), new File(['RIFF'], 'a.wav', { type: 'audio/wav' }));
    await user.type(screen.getByLabelText('Nama suara'), 'A');
    await user.click(screen.getByRole('checkbox', { name: /Saya pemilik suara ini/ }));
  }

  it('cancels an in-flight upload quietly and announces progress in steps', async () => {
    api.voices.mockResolvedValue([]);
    let seen;
    createVoice.mockImplementation((_fields, { onProgress, signal }) => new Promise((_resolve, reject) => {
      seen = signal;
      onProgress(10);
      onProgress(52);
      signal.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError')));
    }));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await openFilledForm(user);
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(await screen.findByTestId('upload-live')).toHaveTextContent('Mengunggah 50%');
    await user.click(screen.getByRole('button', { name: 'Batal' }));
    expect(seen.aborted).toBe(true);
    expect(await screen.findByRole('button', { name: 'Mulai kloning' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('moves focus into the form and back to the clone button', async () => {
    api.voices.mockResolvedValue([]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    expect(screen.getByRole('heading', { name: 'Kloning suara baru' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Batal' }));
    expect(screen.getByRole('button', { name: 'Kloning suara' })).toHaveFocus();
  });

  it('focuses the delete confirmation and returns focus on cancel', async () => {
    api.voices.mockResolvedValue([voice()]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    const row = await screen.findByTestId('voice-row');
    await user.click(within(row).getByRole('button', { name: 'Hapus suara Pandji' }));
    const confirm = within(row).getByRole('button', { name: 'Hapus' });
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAccessibleDescription('Hapus Pandji? Semua voiceover yang memakai suara ini ikut terhapus.');
    await user.click(within(row).getByRole('button', { name: 'Batal' }));
    expect(within(row).getByRole('button', { name: 'Hapus suara Pandji' })).toHaveFocus();
  });

  it('drops a deleted row even while the reload is still pending', async () => {
    api.voices.mockResolvedValueOnce([voice(), voice({ id: 'v2', name: 'Rara' })]).mockReturnValue(new Promise(() => {}));
    api.deleteVoice.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    const [row] = await screen.findAllByTestId('voice-row');
    await user.click(within(row).getByRole('button', { name: 'Hapus suara Pandji' }));
    await user.click(within(row).getByRole('button', { name: 'Hapus' }));
    expect(await screen.findAllByTestId('voice-row')).toHaveLength(1);
    expect(screen.queryByText('Pandji')).not.toBeInTheDocument();
  });

  it('refreshes the list and session when the server says the limit is reached', async () => {
    const full = [voice({ id: 'a' }), voice({ id: 'b' }), voice({ id: 'c' })];
    api.voices.mockResolvedValueOnce([]).mockResolvedValue(full);
    createVoice.mockRejectedValue(new ApiError(403, 'voice_limit_reached', ''));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await openFilledForm(user);
    const meCalls = api.me.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(await screen.findByTestId('voice-limit')).toBeInTheDocument();
    expect(screen.queryByTestId('clone-form')).not.toBeInTheDocument();
    expect(api.voices).toHaveBeenCalledTimes(2);
    expect(api.me.mock.calls.length).toBeGreaterThan(meCalls);
    expect(screen.getByTestId('voice-limit').parentElement).toHaveFocus();
  });

  it('moves focus to the limit notice when the last allowed voice is created', async () => {
    const two = [voice({ id: 'a' }), voice({ id: 'b' })];
    api.voices.mockResolvedValueOnce(two).mockResolvedValue([...two, voice({ id: 'v9', status: 'processing', previewUrl: null })]);
    createVoice.mockResolvedValue({ id: 'v9', status: 'processing' });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await openFilledForm(user);
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(await screen.findByTestId('voice-limit')).toBeInTheDocument();
    expect(screen.getByTestId('voice-limit').parentElement).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Kloning suara' })).toBeDisabled();
  });

  it('re-reads the list after a cancel once the upload reached 100 %', async () => {
    api.voices.mockResolvedValue([]);
    createVoice.mockImplementation((_fields, { onProgress, signal }) => new Promise((_resolve, reject) => {
      onProgress(100);
      signal.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError')));
    }));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await openFilledForm(user);
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    await screen.findByText('Mengunggah 100%', { selector: '[data-testid="upload-live"]' });
    await user.click(screen.getByRole('button', { name: 'Batal' }));
    await vi.waitFor(() => expect(api.voices).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains a 413 with the 95 MB export hint', async () => {
    api.voices.mockResolvedValue([]);
    createVoice.mockRejectedValue(new ApiError(413, 'too_large', ''));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await openFilledForm(user);
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(await screen.findByText('Berkas lebih dari 95 MB. Ekspor ulang rekamannya sebagai MP3 atau M4A supaya lebih kecil.')).toBeInTheDocument();
  });

  it('hides the processing notice once the new voice is ready', async () => {
    api.voices.mockResolvedValueOnce([]).mockResolvedValue([voice({ id: 'v9' })]);
    createVoice.mockResolvedValue({ id: 'v9', status: 'processing' });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await openFilledForm(user);
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(await screen.findByTestId('voice-row')).toHaveAttribute('data-status', 'ready');
    expect(screen.queryByText('Suara sedang diproses. Biasanya selesai dalam satu menit.')).not.toBeInTheDocument();
  });

  it('flags a preview that fails to play and retries with a fresh element', async () => {
    const made = [];
    class FakeAudio extends EventTarget {
      constructor(src) { super(); this.src = src; this.dataset = {}; made.push(this); }
      play() { return made.length === 1 ? Promise.reject(new Error('decode')) : (this.dispatchEvent(new Event('play')), Promise.resolve()); }
      pause() { this.dispatchEvent(new Event('pause')); }
    }
    vi.stubGlobal('Audio', FakeAudio);
    try {
      api.voices.mockResolvedValue([voice()]);
      const user = userEvent.setup();
      renderRoutes(routes, { path: '/voices' });
      const play = await screen.findByRole('button', { name: 'Dengarkan contoh Pandji' });
      await user.click(play);
      expect(play).toHaveAttribute('title', 'Contoh suara gagal diputar. Klik lagi untuk mencoba.');
      await user.click(play);
      expect(made).toHaveLength(2);
      expect(play).toHaveAttribute('aria-pressed', 'true');
      expect(play).not.toHaveAttribute('title');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows VO Profile cards above my voices, without delete and outside the limit', async () => {
    api.voices.mockResolvedValue([voice({ id: 'v1', name: 'Suara Ana' })]);
    api.voiceProfiles.mockResolvedValue([profile(), profile({ id: 'p2', name: 'Gagal', status: 'failed' })]);
    renderRoutes(routes, { path: '/voices' });
    const card = await screen.findByTestId('profile-card');
    expect(screen.getAllByTestId('profile-card')).toHaveLength(1);
    expect(card).toHaveAttribute('data-status', 'ready');
    expect(within(card).getByText('Pandji')).toBeInTheDocument();
    expect(within(card).getByText('Pria, bariton hangat.')).toBeInTheDocument();
    expect(within(card).getByRole('list', { name: 'Ciri suara' })).toHaveTextContent('PriaTegas');
    expect(within(card).getByText('Cocok untuk')).toBeInTheDocument();
    expect(within(card).getByText('Narasi, podcast.')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Pakai suara ini' })).toHaveAttribute('href', '/?voice=p1');
    expect(within(card).getByRole('button', { name: 'Dengarkan contoh Pandji' })).toBeEnabled();
    expect(within(card).queryByRole('button', { name: /Hapus/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((el) => el.textContent)).toEqual(['VO Profile', 'Suara saya']);
    expect(screen.getByText('1 dari 3 suara terpakai')).toBeInTheDocument();
  });

  it('shows the profile card in English', async () => {
    api.voices.mockResolvedValue([]);
    api.voiceProfiles.mockResolvedValue([profile()]);
    renderRoutes(routes, { path: '/voices', lang: 'en', me: { ...ME, lang: 'en' } });
    const card = await screen.findByTestId('profile-card');
    expect(within(card).getByText('Male, warm baritone.')).toBeInTheDocument();
    expect(within(card).getByRole('list', { name: 'Voice traits' })).toHaveTextContent('MaleFirm');
    expect(within(card).getByText('Good for')).toBeInTheDocument();
    expect(within(card).getByText('Narration, podcasts.')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Use this voice' })).toHaveAttribute('href', '/?voice=p1');
    expect(screen.getByRole('heading', { level: 2, name: 'My voices' })).toBeInTheDocument();
  });

  it('marks a processing profile and one whose status is unknown, with preview and use disabled', async () => {
    api.voices.mockResolvedValue([]);
    api.voiceProfiles.mockResolvedValue([profile({ id: 'p1', name: 'Proses', status: 'processing' }), profile({ id: 'p2', name: 'Luring', status: null })]);
    renderRoutes(routes, { path: '/voices' });
    await screen.findAllByTestId('profile-card');
    const [busy, offline] = screen.getAllByTestId('profile-card');
    expect(within(busy).getByText('Diproses')).toBeInTheDocument();
    expect(within(busy).getByRole('button', { name: 'Dengarkan contoh Proses' })).toBeDisabled();
    expect(within(busy).getByRole('button', { name: 'Pakai suara ini' })).toBeDisabled();
    expect(offline).toHaveAttribute('data-status', 'unknown');
    expect(within(offline).getByText(/^Status suara belum terbaca/)).toBeInTheDocument();
    expect(within(offline).getByRole('button', { name: 'Dengarkan contoh Luring' })).toBeDisabled();
  });

  it('hides the section when there is no profile to show', async () => {
    api.voices.mockResolvedValue([voice({ id: 'v1', name: 'Suara Ana' })]);
    api.voiceProfiles.mockResolvedValue([profile({ status: 'failed' })]);
    renderRoutes(routes, { path: '/voices' });
    await screen.findByText('Suara Ana');
    expect(screen.queryByRole('heading', { name: 'VO Profile' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-card')).not.toBeInTheDocument();
  });

  it('offers a retry when the profiles cannot load', async () => {
    api.voices.mockResolvedValue([]);
    api.voiceProfiles.mockRejectedValueOnce(new ApiError(503, 'engine_unavailable', '')).mockResolvedValue([profile()]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    expect(await screen.findByText('Mesin suara sedang tidak dapat dihubungi. Coba lagi sebentar lagi.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByTestId('profile-card')).toBeInTheDocument();
  });
});
