import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderRoutes } from '../test/render.jsx';
import CreditsPage from './CreditsPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { credits: vi.fn() } };
});
const { api } = await import('../lib/api.js');

const routes = [{ path: '/credits', element: <CreditsPage /> }];

describe('CreditsPage', () => {
  it('shows the shared balance, the top-up link and TTS usage', async () => {
    api.credits.mockResolvedValue({
      balance: 1234,
      topupUrl: 'https://lq-studio.com/upgrade-plan',
      usage: [
        { id: 'c1', jobId: 'j1', title: 'Halo semua', kind: 'job', chars: 150, credits: 2, state: 'settled', createdAt: '2026-10-03T08:00:00Z' },
        { id: 'c2', jobId: 'j1', title: 'Halo semua', kind: 'regenerate', chars: 40, credits: 1, state: 'refunded', createdAt: '2026-10-03T08:05:00Z' },
      ],
    });
    renderRoutes(routes, { path: '/credits' });
    expect(await screen.findByTestId('credits-balance')).toHaveTextContent('1.234 kredit');
    expect(screen.getByText('Rp123.400')).toBeInTheDocument();
    expect(screen.getByTestId('topup')).toHaveAttribute('href', 'https://lq-studio.com/upgrade-plan');
    expect(screen.getAllByTestId('usage-row')).toHaveLength(2);
    expect(screen.getAllByText('Buat ulang kalimat').length).toBeGreaterThan(0);
    expect(screen.getByText('Dikembalikan')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Halo semua' })[0]).toHaveAttribute('href', '/jobs/j1');
  });

  it('labels untitled rows and does not link jobs that are gone', async () => {
    api.credits.mockResolvedValue({
      balance: 10,
      topupUrl: 'https://lq-studio.com/upgrade-plan',
      usage: [
        { id: 'c3', jobId: 'gone', title: null, kind: 'job', chars: 10, credits: 1, state: 'settled', createdAt: '2026-10-03T08:00:00Z' },
        { id: 'c4', jobId: null, title: null, kind: 'job', chars: 10, credits: 1, state: 'held', createdAt: '2026-10-03T08:00:00Z' },
      ],
    });
    renderRoutes(routes, { path: '/credits' });
    const rows = await screen.findAllByTestId('usage-row');
    for (const row of rows) {
      expect(within(row).getByText('Voiceover tanpa judul')).toBeInTheDocument();
      expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    }
  });

  it('handles an unknown balance when LQ-Studio is down', async () => {
    api.credits.mockResolvedValue({ balance: null, topupUrl: 'https://lq-studio.com/upgrade-plan', usage: [] });
    renderRoutes(routes, { path: '/credits' });
    expect(await screen.findByTestId('credits-balance')).toHaveTextContent('–');
    expect(screen.getByText('Belum ada pemakaian')).toBeInTheDocument();
  });
});
