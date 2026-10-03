import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api.js';
import { renderRoutes, ME } from '../test/render.jsx';
import AppShell from './AppShell.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { health: vi.fn(), setLang: vi.fn(), logout: vi.fn(), me: vi.fn() } };
});
const { api } = await import('../lib/api.js');

const routes = [
  { path: '/', element: <AppShell />, children: [{ index: true, element: <p>home</p> }] },
  { path: '/login', element: <p>login screen</p> },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.health.mockResolvedValue({ engine: 'ok', lqstudio: 'ok' });
});

describe('AppShell', () => {
  it('switches the UI to English and saves it on the server', async () => {
    api.setLang.mockResolvedValue({ ...ME, lang: 'en' });
    const user = userEvent.setup();
    renderRoutes(routes);
    expect(screen.getAllByRole('link', { name: 'Suara' }).length).toBeGreaterThan(0);
    await user.click(screen.getByTestId('account-button'));
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(api.setLang).toHaveBeenCalledWith('en');
    expect((await screen.findAllByRole('link', { name: 'Voices' })).length).toBeGreaterThan(0);
    expect(document.documentElement.lang).toBe('en');
  });

  it('shows the engine-restarting banner from /api/health', async () => {
    api.health.mockResolvedValue({ engine: 'restarting', lqstudio: 'ok' });
    renderRoutes(routes);
    expect(await screen.findByText('Mesin suara sedang dimulai ulang, mohon tunggu. Pekerjaan baru tetap masuk antrean.')).toBeInTheDocument();
  });

  it('logs out and returns to the login screen', async () => {
    api.logout.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes);
    await user.click(screen.getByTestId('account-button'));
    await user.click(screen.getByTestId('logout'));
    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(api.logout).toHaveBeenCalled();
  });

  it('closes the account menu with Escape and returns focus to its button', async () => {
    const user = userEvent.setup();
    renderRoutes(routes);
    await user.click(screen.getByTestId('account-button'));
    expect(screen.getByText('rara@example.com')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('rara@example.com')).not.toBeInTheDocument());
    expect(screen.getByTestId('account-button')).toHaveFocus();
  });

  it('reverts the language when saving it fails, and the same option retries', async () => {
    api.setLang.mockRejectedValueOnce(new ApiError(0, 'network', 'down'));
    api.setLang.mockResolvedValueOnce({ ...ME, lang: 'en' });
    const user = userEvent.setup();
    renderRoutes(routes);
    await user.click(screen.getByTestId('account-button'));
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(await screen.findByText('Bahasa belum tersimpan di server. Coba lagi.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Suara' }).length).toBeGreaterThan(0);
    expect(document.documentElement.lang).toBe('id');
    expect(screen.getByRole('radio', { name: 'Bahasa Indonesia' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(api.setLang).toHaveBeenCalledTimes(2);
    expect((await screen.findAllByRole('link', { name: 'Voices' })).length).toBeGreaterThan(0);
  });

  it('keeps the session and says so when logout fails', async () => {
    api.logout.mockRejectedValue(new ApiError(0, 'network', 'down'));
    const user = userEvent.setup();
    renderRoutes(routes);
    await user.click(screen.getByTestId('account-button'));
    await user.click(screen.getByTestId('logout'));
    expect(await screen.findByText('Belum berhasil keluar karena server tidak menjawab. Kamu masih masuk, coba lagi.')).toBeInTheDocument();
    expect(screen.queryByText('login screen')).not.toBeInTheDocument();
    expect(screen.getByText('home')).toBeInTheDocument();
  });

  it('names the account button with the visible user name', () => {
    renderRoutes(routes);
    expect(screen.getByRole('button', { name: 'Rara Wibisono, Menu akun' })).toBeInTheDocument();
  });
});
