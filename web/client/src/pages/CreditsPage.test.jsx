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
        { id: 'c1', jobId: 'j1', title: 'Halo semua', jobAvailable: true, kind: 'job', chars: 150, credits: 2, state: 'settled', createdAt: '2026-10-03T08:00:00Z' },
        { id: 'c2', jobId: 'j1', title: 'Halo semua', jobAvailable: true, kind: 'regenerate', chars: 40, credits: 1, state: 'refunded', createdAt: '2026-10-03T08:05:00Z' },
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

  it('links only live jobs: deleted jobs keep their title as text, job-less holds are untitled', async () => {
    api.credits.mockResolvedValue({
      balance: 10,
      topupUrl: 'https://lq-studio.com/upgrade-plan',
      usage: [
        { id: 'c3', jobId: 'j-deleted', title: 'Naskah lama', jobAvailable: false, kind: 'job', chars: 10, credits: 1, state: 'settled', createdAt: '2026-10-03T08:00:00Z' },
        { id: 'c4', jobId: null, title: null, jobAvailable: false, kind: 'job', chars: 10, credits: 1, state: 'held', createdAt: '2026-10-03T08:00:00Z' },
      ],
    });
    renderRoutes(routes, { path: '/credits' });
    const [deleted, orphan] = await screen.findAllByTestId('usage-row');
    expect(within(deleted).getByText('Naskah lama')).toBeInTheDocument();
    expect(within(deleted).queryByRole('link')).not.toBeInTheDocument();
    expect(within(orphan).getByText('Voiceover tanpa judul')).toBeInTheDocument();
    expect(within(orphan).queryByRole('link')).not.toBeInTheDocument();
  });

  it('styles each amount by its state and names the state for screen readers', async () => {
    api.credits.mockResolvedValue({
      balance: 10,
      topupUrl: 'https://lq-studio.com/upgrade-plan',
      usage: [
        { id: 'h', jobId: 'j1', title: 'A', jobAvailable: true, kind: 'job', chars: 10, credits: 3, state: 'held', createdAt: '2026-10-03T08:00:00Z' },
        { id: 's', jobId: 'j1', title: 'A', jobAvailable: true, kind: 'job', chars: 10, credits: 4, state: 'settled', createdAt: '2026-10-03T08:00:00Z' },
        { id: 'r', jobId: 'j1', title: 'A', jobAvailable: true, kind: 'job', chars: 10, credits: 5, state: 'refunded', createdAt: '2026-10-03T08:00:00Z' },
      ],
    });
    renderRoutes(routes, { path: '/credits' });
    await screen.findAllByTestId('usage-row');
    const [held, settled, refunded] = screen.getAllByTestId('usage-amount');
    expect(held).toHaveTextContent('3 kredit ditahan');
    expect(held).toHaveClass('text-muted');
    expect(held).not.toHaveClass('line-through');
    expect(settled).toHaveTextContent('4 kredit terpotong');
    expect(settled).not.toHaveClass('text-muted');
    expect(refunded).toHaveTextContent('5 kredit dikembalikan');
    expect(refunded).toHaveClass('text-muted', 'line-through');
  });

  it('shows an en dash and the reason once when LQ-Studio is down, and teaches the first action', async () => {
    api.credits.mockResolvedValue({ balance: null, topupUrl: 'https://lq-studio.com/upgrade-plan', usage: [] });
    renderRoutes(routes, { path: '/credits' });
    const balance = await screen.findByTestId('credits-balance');
    expect(balance).toHaveTextContent('–');
    expect(balance).not.toHaveTextContent('Saldo');
    expect(screen.getAllByText(/Saldo belum terbaca/)).toHaveLength(1);
    expect(screen.getByText('Belum ada pemakaian')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buat voiceover pertama' })).toHaveAttribute('href', '/');
  });

  it('pluralizes the spoken amount (1 credit vs 2 credits)', async () => {
    api.credits.mockResolvedValue({
      balance: 10,
      topupUrl: 'https://lq-studio.com/upgrade-plan',
      usage: [
        { id: 'one', jobId: 'j1', title: 'A', jobAvailable: true, kind: 'job', chars: 10, credits: 1, state: 'settled', createdAt: '2026-10-03T08:00:00Z' },
        { id: 'two', jobId: 'j1', title: 'A', jobAvailable: true, kind: 'job', chars: 10, credits: 2, state: 'refunded', createdAt: '2026-10-03T08:00:00Z' },
      ],
    });
    renderRoutes(routes, { path: '/credits', lang: 'en' });
    await screen.findAllByTestId('usage-row');
    const [one, two] = screen.getAllByTestId('usage-amount');
    expect(one).toHaveTextContent('1 credit charged');
    expect(one).not.toHaveTextContent('credits');
    expect(two).toHaveTextContent('2 credits refunded');
  });
});
