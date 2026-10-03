import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, renderRoutes } from '../test/render.jsx';
import VoicesPage from './VoicesPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { voices: vi.fn(), deleteVoice: vi.fn(), me: vi.fn() }, createVoice: vi.fn() };
});
const { api, createVoice, ApiError } = await import('../lib/api.js');

const voice = (over) => ({ id: 'v1', name: 'Pandji', language: 'id', status: 'ready', errorCode: null, refSeconds: 14.2, createdAt: '2026-10-03T08:00:00.000Z', previewUrl: '/api/voices/v1/preview', ...over });
const routes = [{ path: '/voices', element: <VoicesPage /> }];

beforeEach(() => {
  vi.clearAllMocks();
  api.me.mockResolvedValue(ME);
});

describe('VoicesPage', () => {
  it('requires consent before uploading', async () => {
    api.voices.mockResolvedValue([]);
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
});
