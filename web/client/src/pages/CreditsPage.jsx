import { ArrowSquareOutIcon, CoinsIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { Button, EmptyState, Notice, PageHeader, Skeleton, StatusChip, buttonClass, touchLinkClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { errorText } from '../lib/errors.js';
import { formatDateTime } from '../lib/format.js';
import { formatNumber, formatRupiah, rupiahFor } from '../lib/pricing.js';
import { useResource } from '../lib/useResource.js';

const STATE_TONE = { held: 'progress', settled: 'neutral', refunded: 'success' };

export default function CreditsPage() {
  const { t, tn, lang } = useI18n();
  const credits = useResource(() => api.credits(), []);
  const data = credits.data;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t('credits.title')} subtitle={t('credits.shared')} />
      {data === undefined && !credits.error ? <Skeleton className="h-32" /> : null}
      {data === undefined && credits.error ? (
        <Notice tone="danger" action={<Button size="sm" onClick={credits.reload}>{t('common.retry')}</Button>}>{errorText(t, credits.error)}</Notice>
      ) : null}
      {data ? (
        <>
          <section aria-labelledby="balance-heading" className="flex flex-col gap-4 rounded-panel border border-line bg-surface p-5 md:flex-row md:items-center md:justify-between md:p-6">
            <div>
              <h2 id="balance-heading" className="text-sm font-medium text-muted">{t('credits.balance')}</h2>
              <p data-testid="credits-balance" className="mt-1 text-2xl font-semibold tabular text-ink">
                {data.balance == null ? <span aria-hidden>–</span> : tn('credits.balance_value', data.balance, { count: formatNumber(data.balance, lang) })}
              </p>
              {data.balance != null ? (
                <p className="mt-0.5 font-mono text-sm tabular text-muted">{formatRupiah(rupiahFor(data.balance), lang)}</p>
              ) : (
                <p className="mt-0.5 text-sm text-muted">{t('credits.balance_unknown')}</p>
              )}
              <p className="mt-2 text-xs text-dim">{t('credits.rate')}</p>
            </div>
            <a data-testid="topup" href={data.topupUrl} target="_blank" rel="noreferrer" className={buttonClass('primary', 'lg')}>
              {t('common.topup')}
              <ArrowSquareOutIcon size={18} aria-hidden />
            </a>
          </section>

          <section aria-labelledby="usage-heading" className="flex flex-col gap-3">
            <h2 id="usage-heading" className="text-lg font-semibold text-ink">{t('credits.usage')}</h2>
            {data.usage.length === 0 ? (
              <EmptyState
                icon={CoinsIcon}
                title={t('credits.empty_title')}
                body={t('credits.empty_body')}
                action={<Link to="/" className={buttonClass('primary')}>{t('credits.empty_cta')}</Link>}
              />
            ) : (
              <div className="overflow-hidden rounded-panel border border-line bg-surface">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line text-xs text-muted">
                    <tr>
                      <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">{t('credits.col.date')}</th>
                      <th scope="col" className="w-full px-4 py-3 font-medium">{t('credits.col.voiceover')}</th>
                      <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">{t('credits.col.kind')}</th>
                      <th scope="col" className="hidden px-4 py-3 text-right font-medium lg:table-cell">{t('credits.col.chars')}</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">{t('credits.col.credits')}</th>
                      <th scope="col" className="px-4 py-3 font-medium">{t('credits.col.state')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.usage.map((row) => <UsageRow key={row.id} row={row} />)}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

const AMOUNT = {
  held: { key: 'credits.amount_held', className: 'text-muted' },
  settled: { key: 'credits.amount_settled', className: 'text-ink' },
  refunded: { key: 'credits.amount_refunded', className: 'text-muted line-through' },
};

function UsageRow({ row }) {
  const { t, tn, lang } = useI18n();
  const kind = t(`credits.kind.${row.kind === 'regenerate' ? 'regenerate' : 'job'}`);
  // `title` is null only for holds that never got a job; deleted jobs keep their title but have no page.
  const title = row.title ?? t('credits.untitled');
  const amount = AMOUNT[row.state] ?? AMOUNT.held;
  const credits = formatNumber(row.credits, lang);
  return (
    <tr data-testid="usage-row" data-job-id={row.jobId ?? ''} className="align-top">
      <td className="hidden whitespace-nowrap px-4 py-3 text-muted lg:table-cell">{formatDateTime(row.createdAt, lang)}</td>
      <td className="px-4 py-3">
        {row.jobAvailable ? (
          <Link to={`/jobs/${row.jobId}`} className={`text-ink transition-colors duration-150 [overflow-wrap:anywhere] hover:text-accent ${touchLinkClass}`}>{title}</Link>
        ) : (
          <span className={row.title == null ? 'text-muted' : 'text-ink [overflow-wrap:anywhere]'}>{title}</span>
        )}
        <p className="mt-0.5 text-xs text-muted lg:hidden"><span className="md:hidden">{kind} · </span>{formatDateTime(row.createdAt, lang)}</p>
      </td>
      <td className="hidden whitespace-nowrap px-4 py-3 text-muted md:table-cell">{kind}</td>
      <td className="hidden px-4 py-3 text-right font-mono tabular lg:table-cell">{formatNumber(row.chars, lang)}</td>
      <td data-testid="usage-amount" className={`whitespace-nowrap px-4 py-3 text-right font-mono tabular ${amount.className}`}>
        <span aria-hidden>{credits}</span>
        <span className="sr-only">{tn(amount.key, row.credits, { count: credits })}</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <StatusChip tone={STATE_TONE[row.state] ?? 'neutral'}>{t(`credits.state.${STATE_TONE[row.state] ? row.state : 'held'}`)}</StatusChip>
      </td>
    </tr>
  );
}
