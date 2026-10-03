import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session.jsx';
import { renderRoutes } from '../test/render.jsx';
import RequireSession from './RequireSession.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { me: vi.fn() } };
});
const { api, ApiError } = await import('../lib/api.js');

function LoginProbe() {
  const { reason } = useSession();
  return <p>login {window.location.pathname} reason:{reason ?? 'none'}</p>;
}

const routes = [
  { path: '/voices', element: <RequireSession><p>private voices</p></RequireSession> },
  { path: '/login', element: <LoginProbe /> },
];

describe('RequireSession', () => {
  it('redirects an anonymous visitor to /login with ?next=', async () => {
    api.me.mockRejectedValue(new ApiError(401, 'unauthorized', ''));
    const { router } = renderRoutes(routes, { path: '/voices', session: { status: 'unknown', me: null, error: null } });
    await screen.findByText(/^login/);
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?next=%2Fvoices');
  });

  it('ends the session with the reason when the account is suspended', async () => {
    api.me.mockRejectedValue(new ApiError(403, 'suspended', ''));
    const { router } = renderRoutes(routes, { path: '/voices', session: { status: 'unknown', me: null, error: null } });
    expect(await screen.findByText(/reason:suspended/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('renders the page once /api/me answers', async () => {
    api.me.mockResolvedValue({ id: 'u1', name: 'Rara', email: 'r@example.com', plan: 'free', paid: false, lang: 'id', balance: 10, voiceLimit: 3, voiceCount: 0, topupUrl: 'https://demo.lq-studio.com/upgrade-plan' });
    renderRoutes(routes, { path: '/voices', session: { status: 'unknown', me: null, error: null } });
    expect(await screen.findByText('private voices')).toBeInTheDocument();
  });

  it('offers a retry when the server is unreachable', async () => {
    api.me.mockRejectedValue(new ApiError(0, 'network', 'down'));
    renderRoutes(routes, { path: '/voices', session: { status: 'unknown', me: null, error: null } });
    expect(await screen.findByRole('button', { name: 'Coba lagi' })).toBeInTheDocument();
    expect(screen.getByText('Server tidak bisa dihubungi. Periksa koneksi internet kamu lalu coba lagi.')).toBeInTheDocument();
  });
});
