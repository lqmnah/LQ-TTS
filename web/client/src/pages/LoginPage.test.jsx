import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, renderRoutes } from '../test/render.jsx';
import LoginPage from './LoginPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { login: vi.fn(), verify2fa: vi.fn(), health: vi.fn(), me: vi.fn() } };
});
const { api, ApiError } = await import('../lib/api.js');

const routes = [
  { path: '/login', element: <LoginPage /> },
  { path: '/voices', element: <p>voices page</p> },
  { path: '/', element: <p>home page</p> },
];
const anon = { me: null };

async function submitCredentials(user) {
  await user.type(screen.getByLabelText('Email atau username'), 'rara');
  await user.type(screen.getByLabelText('Kata sandi'), 'rahasia-123');
  await user.click(screen.getByRole('button', { name: 'Masuk' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.health.mockRejectedValue(new ApiError(503, 'engine_unavailable', ''));
});

describe('LoginPage', () => {
  it('asks for the 2FA code, then signs in and follows ?next=', async () => {
    api.login.mockResolvedValue({ status: 'need_2fa', challenge: 'ch-1' });
    api.verify2fa.mockResolvedValue({ status: 'ok', user: ME });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login?next=%2Fvoices', ...anon });
    await submitCredentials(user);
    expect(api.login).toHaveBeenCalledWith('rara', 'rahasia-123');
    expect(await screen.findByRole('heading', { name: 'Verifikasi dua langkah' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Kode'), '482 913');
    await user.click(screen.getByRole('button', { name: 'Verifikasi' }));
    expect(api.verify2fa).toHaveBeenCalledWith('ch-1', '482913');
    expect(await screen.findByText('voices page')).toBeInTheDocument();
  });

  it('validates on submit without calling the server', async () => {
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    await user.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(screen.getAllByText('Isi kolom ini.')).toHaveLength(2);
    expect(api.login).not.toHaveBeenCalled();
  });

  it('sends unverified accounts to LQ-Studio', async () => {
    api.login.mockResolvedValue({ status: 'needs_verification', verifyUrl: 'https://demo.lq-studio.com/settings' });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    await submitCredentials(user);
    expect(await screen.findByRole('heading', { name: 'Selesaikan verifikasi akun' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buka LQ-Studio' })).toHaveAttribute('href', 'https://demo.lq-studio.com/settings');
  });

  it('shows readable errors for wrong credentials, rate limits and LQ-Studio outages', async () => {
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    api.login.mockRejectedValueOnce(new ApiError(401, 'invalid_credentials', ''));
    await submitCredentials(user);
    expect(await screen.findByText('Email/username atau kata sandi salah.')).toBeInTheDocument();
    api.login.mockRejectedValueOnce(new ApiError(429, 'rate_limited', '', { retryAfter: 60 }));
    await user.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(await screen.findByText('Terlalu banyak percobaan. Coba lagi dalam 60 detik.')).toBeInTheDocument();
    api.login.mockRejectedValueOnce(new ApiError(503, 'lqstudio_unavailable', ''));
    await user.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(await screen.findByText('LQ-Studio sedang tidak dapat dihubungi. Coba lagi sebentar lagi.')).toBeInTheDocument();
  });

  it('falls back to the hostname sign-up link when health is unavailable, and switches language', async () => {
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    expect(screen.getByRole('link', { name: 'Daftar di LQ-Studio' })).toHaveAttribute('href', 'https://demo.lq-studio.com/signup');
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(screen.getByRole('heading', { name: 'Log in to LQ TTS' })).toBeInTheDocument();
  });

  it('takes the sign-up link from the health answer', async () => {
    api.health.mockResolvedValue({ engine: 'ok', lqstudio: 'ok', signupUrl: 'https://lq-studio.com/daftar' });
    renderRoutes(routes, { path: '/login', ...anon });
    await vi.waitFor(() =>
      expect(screen.getByRole('link', { name: 'Daftar di LQ-Studio' })).toHaveAttribute('href', 'https://lq-studio.com/daftar'),
    );
  });

  it('sends a 2FA answer of needs_verification to the verify step instead of signing in', async () => {
    api.login.mockResolvedValue({ status: 'need_2fa', challenge: 'ch-1' });
    api.verify2fa.mockResolvedValue({ status: 'needs_verification', verifyUrl: 'https://demo.lq-studio.com/settings' });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    await submitCredentials(user);
    await user.type(await screen.findByLabelText('Kode'), '482913');
    await user.click(screen.getByRole('button', { name: 'Verifikasi' }));
    expect(await screen.findByRole('heading', { name: 'Selesaikan verifikasi akun' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buka LQ-Studio' })).toHaveAttribute('href', 'https://demo.lq-studio.com/settings');
    expect(screen.queryByText('home page')).not.toBeInTheDocument();
  });

  it('shows a generic error for an unknown 2FA answer and a readable one for a wrong code', async () => {
    api.login.mockResolvedValue({ status: 'need_2fa', challenge: 'ch-1' });
    api.verify2fa.mockResolvedValueOnce({ status: 'weird' });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    await submitCredentials(user);
    await user.type(await screen.findByLabelText('Kode'), '482913');
    await user.click(screen.getByRole('button', { name: 'Verifikasi' }));
    expect(await screen.findByText('Ada yang tidak beres di server. Coba lagi.')).toBeInTheDocument();
    api.verify2fa.mockRejectedValueOnce(new ApiError(401, 'invalid_code', ''));
    await user.click(screen.getByRole('button', { name: 'Verifikasi' }));
    expect(await screen.findByText('Kode salah atau sudah kedaluwarsa. Coba kode terbaru.')).toBeInTheDocument();
  });

  it('explains why the session ended for suspended and unverified accounts only', () => {
    const anonWith = (reason) => ({ status: 'anon', me: null, error: null, reason });
    const first = renderRoutes(routes, { path: '/login', session: anonWith('suspended') });
    expect(screen.getByTestId('login-reason')).toHaveTextContent('akun ini dinonaktifkan');
    first.unmount();
    const second = renderRoutes(routes, { path: '/login', session: anonWith('needs_verification') });
    expect(screen.getByTestId('login-reason')).toHaveTextContent('akun perlu diverifikasi');
    second.unmount();
    renderRoutes(routes, { path: '/login', session: anonWith('unauthorized') });
    expect(screen.queryByTestId('login-reason')).not.toBeInTheDocument();
  });

  it('moves focus to the new step heading after needs_verification and back to the form after Back', async () => {
    api.login.mockResolvedValue({ status: 'needs_verification', verifyUrl: 'https://demo.lq-studio.com/settings' });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    await submitCredentials(user);
    expect(await screen.findByRole('heading', { name: 'Selesaikan verifikasi akun' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Kembali' }));
    expect(screen.getByRole('heading', { name: 'Masuk ke LQ TTS' })).toHaveFocus();
  });

  it('accepts dashed TOTP codes as digits and keeps backup codes in their own format', async () => {
    api.login.mockResolvedValue({ status: 'need_2fa', challenge: 'ch-1' });
    api.verify2fa.mockRejectedValueOnce(new ApiError(401, 'invalid_code', '')).mockResolvedValueOnce({ status: 'ok', user: ME });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    await submitCredentials(user);
    const field = await screen.findByLabelText('Kode');
    await user.type(field, '482-913');
    await user.click(screen.getByRole('button', { name: 'Verifikasi' }));
    expect(api.verify2fa).toHaveBeenLastCalledWith('ch-1', '482913');
    await screen.findByText('Kode salah atau sudah kedaluwarsa. Coba kode terbaru.');
    await user.clear(field);
    await user.type(field, 'ab12-cd34');
    await user.click(screen.getByRole('button', { name: 'Verifikasi' }));
    expect(api.verify2fa).toHaveBeenLastCalledWith('ch-1', 'ab12-cd34');
    expect(await screen.findByText('home page')).toBeInTheDocument();
  });

  it('checks an unknown session first and sends a signed-in user to ?next=', async () => {
    let answer;
    api.me.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderRoutes(routes, { path: '/login?next=%2Fvoices', session: { status: 'unknown', me: null, error: null } });
    expect(await screen.findByTestId('login-checking')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Masuk' })).not.toBeInTheDocument();
    answer(ME);
    expect(await screen.findByText('voices page')).toBeInTheDocument();
    expect(api.me).toHaveBeenCalledTimes(1);
  });

  it('shows the form when the unknown session turns out signed out', async () => {
    api.me.mockRejectedValue(new ApiError(401, 'unauthorized', ''));
    renderRoutes(routes, { path: '/login', session: { status: 'unknown', me: null, error: null } });
    expect(await screen.findByRole('button', { name: 'Masuk' })).toBeInTheDocument();
    expect(screen.queryByTestId('login-reason')).not.toBeInTheDocument();
  });
});
