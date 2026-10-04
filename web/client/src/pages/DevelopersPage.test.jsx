import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../router.jsx';
import { renderRoutes } from '../test/render.jsx';

describe('DevelopersPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is public and covers auth, endpoints, webhooks, errors and limits', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
    vi.stubGlobal('fetch', fetchSpy);
    renderRoutes(routes, { path: '/developers', session: { status: 'unknown', me: null, error: null } });
    expect(screen.getByRole('heading', { level: 1, name: 'Dokumentasi API LQ TTS' })).toBeInTheDocument();
    for (const name of ['Autentikasi', 'Endpoint', 'Membuat voiceover', 'Cek status dan unduh', 'Webhook', 'Error', 'Batas']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByText('/v1/tts/{jobId}/files/{name}')).toBeInTheDocument();
    expect(screen.getByText(/verifyLqttsWebhook/)).toBeInTheDocument();
    expect(screen.getByText(/def verify_lqtts_webhook/)).toBeInTheDocument();
    expect(screen.getByText('too_many_jobs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buka halaman API' })).toHaveAttribute('href', '/api-keys');
    // A visitor with no session is never sent to the login page and the page asks nothing of the server.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('links every section from the page index', () => {
    renderRoutes(routes, { path: '/developers', me: null });
    const index = screen.getByRole('navigation', { name: 'Di halaman ini' });
    for (const heading of screen.getAllByRole('heading', { level: 2 })) {
      const link = [...index.querySelectorAll('a')].find((a) => a.textContent === heading.textContent);
      expect(link, heading.textContent).toHaveAttribute('href', `#${heading.closest('section').id}`);
    }
  });

  it('switches to English without a session', async () => {
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/developers', me: null });
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(screen.getByRole('heading', { level: 1, name: 'LQ TTS API docs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Limits' })).toBeInTheDocument();
  });
});
