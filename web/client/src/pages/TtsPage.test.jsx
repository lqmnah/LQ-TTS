import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, renderRoutes } from '../test/render.jsx';
import TtsPage from './TtsPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { voices: vi.fn(), estimate: vi.fn(), createJob: vi.fn(), me: vi.fn() } };
});
const { api, ApiError } = await import('../lib/api.js');

const ready = { id: 'v1', name: 'Pandji', language: 'id', status: 'ready', errorCode: null, refSeconds: 14, createdAt: '2026-10-03T08:00:00Z', previewUrl: '/api/voices/v1/preview' };
const routes = [
  { path: '/', element: <TtsPage /> },
  { path: '/jobs/:id', element: <p>job page</p> },
  { path: '/voices', element: <p>voices page</p> },
];
const SCRIPT_150 = 'a'.repeat(150);

beforeEach(() => {
  vi.clearAllMocks();
  api.voices.mockResolvedValue([ready]);
  api.me.mockResolvedValue(ME);
  api.estimate.mockImplementation(async (text) => ({ chars: [...text].length, credits: Math.max(1, Math.ceil([...text].length / 100)), rupiah: 0, balance: 240, sentences: 1 }));
});

describe('TtsPage', () => {
  it('shows the live price and balance as the script is typed', async () => {
    const user = userEvent.setup();
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    expect(screen.getByTestId('price')).toHaveTextContent('Tulis naskah untuk melihat harganya.');
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste(SCRIPT_150);
    expect(screen.getByTestId('price')).toHaveTextContent('Sekitar 2 kredit (Rp200)');
    expect(screen.getByTestId('balance')).toHaveTextContent('Saldo: 240 kredit');
  });

  it('blocks Generate and offers top-up when the balance is too low', async () => {
    const user = userEvent.setup();
    renderRoutes(routes, { me: { ...ME, balance: 1 } });
    api.estimate.mockResolvedValue({ chars: 150, credits: 2, rupiah: 200, balance: 1, sentences: 1 });
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste(SCRIPT_150);
    expect(screen.getByText('Kredit belum cukup untuk naskah ini.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Top up kredit' })).toHaveAttribute('href', ME.topupUrl);
    expect(screen.getByTestId('generate')).toBeDisabled();
  });

  it('sends the script with engine-native settings and opens the job', async () => {
    api.createJob.mockResolvedValue({ id: 'j1', credits: 2, estimatedSeconds: 12 });
    const user = userEvent.setup();
    const { router } = renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('  Halo semua. Ini kalimat kedua.  ');
    await user.click(screen.getByRole('button', { name: 'WAV' }));
    await user.click(screen.getByTestId('generate'));
    expect(api.createJob).toHaveBeenCalledWith('v1', 'Halo semua. Ini kalimat kedua.', {
      speed: 0.9, pause_sentence_s: 0.45, pause_paragraph_s: 0.8, formats: ['mp3', 'srt', 'vtt'],
    });
    expect(await screen.findByText('job page')).toBeInTheDocument();
    expect(router.state.location.state).toEqual({ estimatedSeconds: 12 });
  });

  it('shows an inline top-up prompt when the hold is refused with 402', async () => {
    api.createJob.mockRejectedValue(new ApiError(402, 'insufficient_credits', ''));
    const user = userEvent.setup();
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    await user.click(screen.getByTestId('generate'));
    expect(await screen.findByText('Kredit kamu tidak cukup. Top up dulu di LQ-Studio.')).toBeInTheDocument();
  });

  it('teaches cloning when no voice is ready', async () => {
    api.voices.mockResolvedValue([{ ...ready, status: 'processing' }]);
    renderRoutes(routes);
    expect(await screen.findByText('Kloning suara dulu')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kloning suara' })).toHaveAttribute('href', '/voices');
  });

  it('rejects scripts over 20,000 characters', async () => {
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    const box = screen.getByLabelText('Naskah');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, 'a'.repeat(20001));
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(screen.getByText('Naskah maksimal 20.000 karakter. Pendekkan atau bagi menjadi beberapa voiceover.')).toBeInTheDocument();
    expect(screen.getByTestId('generate')).toBeDisabled();
  });
  it('does not block Generate when the balance is unknown', async () => {
    api.estimate.mockImplementation(async (text) => ({ chars: [...text].length, credits: 1, rupiah: 100, balance: null, sentences: 1 }));
    const user = userEvent.setup();
    renderRoutes(routes, { me: { ...ME, balance: null } });
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    expect(screen.getByTestId('balance')).toHaveTextContent('Saldo: – kredit');
    expect(screen.getByTestId('generate')).toBeEnabled();
  });

  it('reloads the voice list when the chosen voice is not ready any more (409)', async () => {
    api.createJob.mockRejectedValue(new ApiError(409, 'voice_not_ready', ''));
    const user = userEvent.setup();
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    await user.click(screen.getByTestId('generate'));
    expect(await screen.findByText('Suara ini belum siap. Tunggu sampai statusnya Siap.')).toBeInTheDocument();
    expect(api.voices).toHaveBeenCalledTimes(2);
  });

  it.each([
    [413, 'too_large'],
    [503, 'lqstudio_unavailable'],
  ])('shows the server reason for a refused job (%i)', async (status, code) => {
    api.createJob.mockRejectedValue(new ApiError(status, code, ''));
    const user = userEvent.setup();
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    await user.click(screen.getByTestId('generate'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('generate')).toBeEnabled();
  });
});
