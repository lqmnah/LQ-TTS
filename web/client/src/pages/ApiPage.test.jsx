import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api.js';
import { ME, renderRoutes } from '../test/render.jsx';
import ApiPage from './ApiPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { apiKeys: vi.fn(), createApiKey: vi.fn(), revokeApiKey: vi.fn() } };
});
const { api } = await import('../lib/api.js');

const routes = [
  { path: '/api-keys', element: <ApiPage /> },
  { path: '/developers', element: <p>docs page</p> },
  { path: '/jobs/:id', element: <p>job page</p> },
];
const PRO = { ...ME, plan: 'pro', paid: true };
const KEY = { id: 'k1', name: 'Zapier', prefix: 'lqtts_abcdefghijkl_…', createdAt: '2026-10-04T08:00:00Z', lastUsedAt: null };
const FULL_KEY = `lqtts_abcdefghijkl_${'a'.repeat(52)}`;
const SECRET = `whsec_${'b'.repeat(52)}`;

beforeEach(() => vi.clearAllMocks());

describe('ApiPage', () => {
  it('shows a free account the upgrade notice and loads no keys', async () => {
    renderRoutes(routes, { path: '/api-keys' });
    expect(screen.getByRole('heading', { level: 1, name: 'API' })).toBeInTheDocument();
    expect(screen.getByTestId('api-upgrade')).toHaveTextContent('Pro, Ultra dan Sultan');
    expect(screen.getByRole('link', { name: 'Upgrade paket' })).toHaveAttribute('href', ME.topupUrl);
    expect(screen.getByRole('link', { name: 'Dokumentasi API' })).toHaveAttribute('href', '/developers');
    expect(api.apiKeys).not.toHaveBeenCalled();
  });

  it('shows a Pro account the empty state, then the error with a retry', async () => {
    api.apiKeys.mockRejectedValueOnce(new ApiError(0, 'network', 'down')).mockResolvedValueOnce({ keys: [], deliveries: [] });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    await user.click(await screen.findByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByText('Belum ada kunci API')).toBeInTheDocument();
    expect(screen.getByText('Belum ada webhook yang dikirim.')).toBeInTheDocument();
  });

  it('creates a key and shows the full key and the webhook secret once', async () => {
    api.apiKeys.mockResolvedValue({ keys: [], deliveries: [] });
    api.createApiKey.mockResolvedValue({ ...KEY, key: FULL_KEY, webhookSecret: SECRET });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    await user.click(await screen.findByRole('button', { name: 'Buat kunci' }));
    expect(screen.getByText('Beri nama kunci ini dulu.')).toBeInTheDocument();
    expect(api.createApiKey).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Nama kunci'), '  Zapier ');
    await user.click(screen.getByRole('button', { name: 'Buat kunci' }));
    expect(api.createApiKey).toHaveBeenCalledWith('Zapier');
    const panel = await screen.findByTestId('new-key-panel');
    expect(panel).toHaveFocus();
    expect(within(panel).getByTestId('new-key-value')).toHaveTextContent(FULL_KEY);
    expect(within(panel).getByTestId('new-webhook-secret')).toHaveTextContent(SECRET);
    const copyKey = within(panel).getByRole('button', { name: 'Salin Kunci API' });
    await user.click(copyKey);
    expect(await navigator.clipboard.readText()).toBe(FULL_KEY);
    expect(copyKey).toHaveTextContent('Tersalin');
    expect(screen.getAllByTestId('api-key-row')).toHaveLength(1);
    expect(screen.getByLabelText('Nama kunci')).toHaveValue('');
    await user.click(within(panel).getByRole('button', { name: 'Sudah saya simpan' }));
    expect(screen.queryByTestId('new-key-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(FULL_KEY)).not.toBeInTheDocument();
  });

  it('shows why a create failed', async () => {
    api.apiKeys.mockResolvedValue({ keys: [], deliveries: [] });
    api.createApiKey.mockRejectedValue(new ApiError(403, 'key_limit_reached', 'limit'));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    await user.type(await screen.findByLabelText('Nama kunci'), 'Zapier');
    await user.click(screen.getByRole('button', { name: 'Buat kunci' }));
    expect(await screen.findByText('Sudah ada 5 kunci API aktif. Cabut satu dulu.')).toBeInTheDocument();
  });

  it('turns creating off at five keys', async () => {
    const keys = [1, 2, 3, 4, 5].map((n) => ({ ...KEY, id: `k${n}`, name: `Kunci ${n}` }));
    api.apiKeys.mockResolvedValue({ keys, deliveries: [] });
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    expect(await screen.findByRole('button', { name: 'Buat kunci' })).toBeDisabled();
    expect(screen.getByText('Maksimal 5 kunci aktif. Cabut satu untuk membuat yang baru.')).toBeInTheDocument();
  });

  it('revokes a key only after the inline confirm, moving focus into and out of it', async () => {
    api.apiKeys.mockResolvedValue({ keys: [{ ...KEY, lastUsedAt: null }], deliveries: [] });
    api.revokeApiKey.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    const row = await screen.findByTestId('api-key-row');
    expect(within(row).getByText('lqtts_abcdefghijkl_…')).toBeInTheDocument();
    expect(within(row).getByText(/belum pernah dipakai/)).toBeInTheDocument();
    const trigger = within(row).getByRole('button', { name: 'Cabut kunci Zapier' });
    await user.click(trigger);
    const confirm = screen.getByTestId('api-key-confirm');
    expect(within(confirm).getByRole('button', { name: 'Cabut kunci' })).toHaveFocus();
    await user.click(within(confirm).getByRole('button', { name: 'Batal' }));
    expect(api.revokeApiKey).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(within(screen.getByTestId('api-key-confirm')).getByRole('button', { name: 'Cabut kunci' }));
    expect(api.revokeApiKey).toHaveBeenCalledWith('k1');
    expect(await screen.findByText('Belum ada kunci API')).toBeInTheDocument();
  });

  it('lists webhook deliveries with their state', async () => {
    api.apiKeys.mockResolvedValue({
      keys: [KEY],
      deliveries: [
        { id: '2', keyId: 'k1', keyName: 'Zapier', jobId: 'j2', event: 'job.failed', state: 'dropped', attempts: 4, lastStatus: 500, createdAt: '2026-10-04T09:00:00Z', finishedAt: '2026-10-04T09:36:00Z' },
        { id: '1', keyId: 'k1', keyName: 'Zapier', jobId: 'j1', event: 'job.done', state: 'delivered', attempts: 1, lastStatus: 200, createdAt: '2026-10-04T08:00:00Z', finishedAt: '2026-10-04T08:00:01Z' },
      ],
    });
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    const rows = await screen.findAllByTestId('delivery-row');
    expect(rows.map((r) => r.dataset.state)).toEqual(['dropped', 'delivered']);
    expect(within(rows[0]).getByText('Gagal')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Terkirim')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('link', { name: 'job.done' })).toHaveAttribute('href', '/jobs/j1');
  });

  it('lists keys from a server that does not send deliveries yet', async () => {
    api.apiKeys.mockResolvedValue({ keys: [KEY] });
    renderRoutes(routes, { path: '/api-keys', me: PRO });
    expect(await screen.findByTestId('api-key-row')).toHaveAttribute('data-key-id', 'k1');
    expect(screen.getByText('Belum ada webhook yang dikirim.')).toBeInTheDocument();
  });
});
