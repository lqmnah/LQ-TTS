import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, renderRoutes } from '../test/render.jsx';
import TtsPage from './TtsPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { voices: vi.fn(), voiceProfiles: vi.fn(), estimate: vi.fn(), createJob: vi.fn(), me: vi.fn() } };
});
const { api, ApiError } = await import('../lib/api.js');

const ready = { id: 'v1', name: 'Pandji', language: 'id', status: 'ready', errorCode: null, refSeconds: 14, createdAt: '2026-10-03T08:00:00Z', previewUrl: '/api/voices/v1/preview' };
const routes = [
  { path: '/', element: <TtsPage /> },
  { path: '/jobs/:id', element: <p>job page</p> },
  { path: '/voices', element: <p>voices page</p> },
];
const SCRIPT_150 = 'a'.repeat(150);
const profile = (over) => ({
  id: 'p1', slug: 'pandji', name: 'Pandji VO', gender: 'male', language: 'id', status: 'ready', errorCode: null,
  description: { id: 'Pria.', en: 'Male.' }, tags: [{ id: 'Pria', en: 'Male' }], bestFor: { id: 'Narasi.', en: 'Narration.' },
  previewUrl: '/api/voices/p1/preview', ...over,
});
const groups = () => [...screen.getByTestId('voice-select').querySelectorAll('optgroup')]
  .map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)]);

beforeEach(() => {
  vi.clearAllMocks();
  api.voices.mockResolvedValue([ready]);
  api.voiceProfiles.mockResolvedValue([]);
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
  it('re-reads the balance after a 402 so Generate reflects it', async () => {
    api.createJob.mockRejectedValue(new ApiError(402, 'insufficient_credits', ''));
    const user = userEvent.setup();
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    await waitFor(() => expect(api.estimate).toHaveBeenCalledTimes(1));
    api.estimate.mockResolvedValue({ chars: 11, credits: 1, rupiah: 100, balance: 0, sentences: 1 });
    await user.click(screen.getByTestId('generate'));
    expect(await screen.findByText('Kredit belum cukup untuk naskah ini.')).toBeInTheDocument();
    expect(api.me).toHaveBeenCalled();
    expect(screen.getByTestId('generate')).toBeDisabled();
  });

  it('re-enables Generate after a top-up when the tab becomes visible again', async () => {
    api.estimate.mockResolvedValue({ chars: 150, credits: 2, rupiah: 200, balance: 1, sentences: 1 });
    const user = userEvent.setup();
    renderRoutes(routes, { me: { ...ME, balance: 1 } });
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste(SCRIPT_150);
    await waitFor(() => expect(api.estimate).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('generate')).toBeDisabled();
    api.estimate.mockResolvedValue({ chars: 150, credits: 2, rupiah: 200, balance: 500, sentences: 1 });
    api.me.mockResolvedValue({ ...ME, balance: 500 });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(screen.getByTestId('generate')).toBeEnabled());
    expect(screen.getByTestId('balance')).toHaveTextContent('Saldo: 500 kredit');
  });

  it('clears a refused-job error once the script changes', async () => {
    api.createJob.mockRejectedValue(new ApiError(503, 'lqstudio_unavailable', ''));
    const user = userEvent.setup();
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    await user.click(screen.getByTestId('generate'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Naskah'), ' Lagi.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('groups ready VO Profiles and my ready voices and selects my first voice', async () => {
    api.voices.mockResolvedValue([ready, { ...ready, id: 'v2', name: 'Draf', status: 'processing' }]);
    api.voiceProfiles.mockResolvedValue([profile(), profile({ id: 'p2', name: 'Raka', status: 'processing' }), profile({ id: 'p3', name: 'Luring', status: null })]);
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji VO' });
    expect(groups()).toEqual([['VO Profile', ['Pandji VO']], ['Suara saya', ['Pandji']]]);
    expect(screen.getByTestId('voice-select')).toHaveValue('v1');
  });

  it('offers the first ready profile when I have no ready voice of my own', async () => {
    api.voices.mockResolvedValue([]);
    api.voiceProfiles.mockResolvedValue([profile()]);
    api.createJob.mockResolvedValue({ id: 'j1', credits: 1, estimatedSeconds: 5 });
    const user = userEvent.setup();
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji VO' });
    expect(screen.queryByText('Kloning suara dulu')).not.toBeInTheDocument();
    expect(groups()).toEqual([['VO Profile', ['Pandji VO']]]);
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    await user.click(screen.getByTestId('generate'));
    expect(api.createJob).toHaveBeenCalledWith('p1', 'Halo semua.', expect.any(Object));
  });

  it('selects the voice from ?voice=, keeps it in the draft and drops it from the URL', async () => {
    window.localStorage.setItem('lqtts_draft:u1', JSON.stringify({ text: '', voiceId: 'v1', settings: {} }));
    api.voiceProfiles.mockResolvedValue([profile()]);
    const { router } = renderRoutes(routes, { path: '/?voice=p1' });
    await screen.findByRole('option', { name: 'Pandji VO' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByTestId('voice-select')).toHaveValue('p1');
    expect(JSON.parse(window.localStorage.getItem('lqtts_draft:u1')).voiceId).toBe('p1');
  });

  it('ignores an unusable ?voice= and keeps the draft voice', async () => {
    api.voices.mockResolvedValue([ready, { ...ready, id: 'v2', name: 'Kedua' }]);
    window.localStorage.setItem('lqtts_draft:u1', JSON.stringify({ text: '', voiceId: 'v2', settings: {} }));
    api.voiceProfiles.mockResolvedValue([profile({ status: 'processing' })]);
    const { router } = renderRoutes(routes, { path: '/?voice=p1' });
    await screen.findByRole('option', { name: 'Kedua' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByTestId('voice-select')).toHaveValue('v2');
  });

  it('reloads voices and profiles and explains when the chosen profile was turned off (404)', async () => {
    api.voiceProfiles.mockResolvedValueOnce([profile()]).mockResolvedValue([]);
    api.createJob.mockRejectedValue(new ApiError(404, 'not_found', ''));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/?voice=p1' });
    await screen.findByRole('option', { name: 'Pandji VO' });
    await waitFor(() => expect(screen.getByTestId('voice-select')).toHaveValue('p1'));
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    await user.click(screen.getByTestId('generate'));
    expect(await screen.findByText('Suara ini sudah tidak tersedia. Pilih suara lain.')).toBeInTheDocument();
    expect(api.voiceProfiles).toHaveBeenCalledTimes(2);
    expect(api.voices).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId('voice-select')).toHaveValue('v1'));
    expect(screen.queryByRole('option', { name: 'Pandji VO' })).not.toBeInTheDocument();
  });
  it.each([['profiles first', ['profiles', 'voices']], ['own voices first', ['voices', 'profiles']]])(
    '?voice= wins when %s resolve',
    async (_, order) => {
      window.localStorage.setItem('lqtts_draft:u1', JSON.stringify({ text: '', voiceId: 'v1', settings: {} }));
      const pending = {};
      api.voices.mockImplementation(() => new Promise((resolve) => { pending.voices = () => resolve([ready]); }));
      api.voiceProfiles.mockImplementation(() => new Promise((resolve) => { pending.profiles = () => resolve([profile()]); }));
      const { router } = renderRoutes(routes, { path: '/?voice=p1' });
      await waitFor(() => expect(pending.voices && pending.profiles).toBeTruthy());
      await act(async () => pending[order[0]]());
      expect(router.state.location.search).toBe('?voice=p1');
      await act(async () => pending[order[1]]());
      await waitFor(() => expect(router.state.location.search).toBe(''));
      expect(screen.getByTestId('voice-select')).toHaveValue('p1');
      expect(JSON.parse(window.localStorage.getItem('lqtts_draft:u1')).voiceId).toBe('p1');
    },
  );
  it('keeps Generate off while the VO Profiles are still loading', async () => {
    window.localStorage.setItem('lqtts_draft:u1', JSON.stringify({ text: 'Halo semua.', voiceId: '', settings: {} }));
    let finish;
    api.voiceProfiles.mockImplementation(() => new Promise((resolve) => { finish = () => resolve([profile()]); }));
    renderRoutes(routes, { path: '/?voice=p1' });
    await waitFor(() => expect(api.voices).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('voice-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('generate')).toBeDisabled();
    await act(async () => finish());
    await waitFor(() => expect(screen.getByTestId('voice-select')).toHaveValue('p1'));
    expect(screen.getByTestId('generate')).toBeEnabled();
  });
  it('keeps Generate off while my voices failed to load', async () => {
    window.localStorage.setItem('lqtts_draft:u1', JSON.stringify({ text: 'Halo semua.', voiceId: '', settings: {} }));
    api.voices.mockRejectedValue(new ApiError(500, 'internal', ''));
    api.voiceProfiles.mockResolvedValue([profile()]);
    renderRoutes(routes);
    expect(await screen.findByRole('button', { name: 'Coba lagi' })).toBeInTheDocument();
    expect(screen.getByTestId('generate')).toBeDisabled();
  });
  it('offers a retry for the VO Profiles when they failed and I have no ready voice', async () => {
    api.voices.mockResolvedValue([]);
    api.voiceProfiles.mockRejectedValueOnce(new ApiError(500, 'internal', '')).mockResolvedValue([profile()]);
    const user = userEvent.setup();
    renderRoutes(routes);
    expect(await screen.findByText('Daftar VO Profile gagal dimuat. Coba lagi.')).toBeInTheDocument();
    expect(screen.queryByText('Kloning suara dulu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByRole('option', { name: 'Pandji VO' })).toBeInTheDocument();
    expect(api.voiceProfiles).toHaveBeenCalledTimes(2);
  });
  it('keeps my own voices usable when only the VO Profiles failed', async () => {
    api.voiceProfiles.mockRejectedValue(new ApiError(500, 'internal', ''));
    renderRoutes(routes);
    await waitFor(() => expect(screen.getByTestId('voice-select')).toHaveValue('v1'));
    expect(screen.queryByText('Daftar VO Profile gagal dimuat. Coba lagi.')).not.toBeInTheDocument();
  });
});
