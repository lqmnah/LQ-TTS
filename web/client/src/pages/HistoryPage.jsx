import { ClockCounterClockwiseIcon, DownloadSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { JobStatus } from '../components/status.jsx';
import { Button, EmptyState, Notice, PageHeader, Skeleton, buttonClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { triggerDownload } from '../lib/download.js';
import { errorText } from '../lib/errors.js';
import { formatDateTime, formatDuration } from '../lib/format.js';
import { formatNumber } from '../lib/pricing.js';

const PAGE_SIZE = 20;
const AUDIO_FILES = ['final.mp3', 'final.wav'];

/** The server's file URLs point at the newest revision on disk via `?revision=N`. */
const revisionOf = (url) => {
  const match = /[?&]revision=(\d+)/.exec(url ?? '');
  return match ? Number(match[1]) : null;
};

export default function HistoryPage() {
  const { t } = useI18n();
  const [items, setItems] = useState(null);
  // Opaque server cursor: passed back unchanged, never built or parsed here.
  const [nextBefore, setNextBefore] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (before = null) => {
    const page = await api.jobs({ limit: PAGE_SIZE, before });
    setItems((prev) => (before && prev ? [...prev, ...page.items] : page.items));
    setNextBefore(page.nextBefore ?? null);
  }, []);

  const firstLoad = useCallback(() => {
    setError(null);
    load().catch(setError);
  }, [load]);

  useEffect(() => {
    firstLoad();
  }, [firstLoad]);

  async function more() {
    setLoadingMore(true);
    setError(null);
    try {
      await load(nextBefore);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  const remove = (id) => setItems((prev) => prev.filter((j) => j.id !== id));

  let body;
  if (items === null && !error) {
    body = <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>;
  } else if (items === null) {
    body = <Notice tone="danger" action={<Button size="sm" onClick={firstLoad}>{t('common.retry')}</Button>}>{errorText(t, error)}</Notice>;
  } else if (!items.length) {
    body = (
      <EmptyState
        icon={ClockCounterClockwiseIcon}
        title={t('history.empty_title')}
        body={t('history.empty_body')}
        action={<Link to="/" className={buttonClass('primary')}>{t('history.empty_cta')}</Link>}
      />
    );
  } else {
    body = (
      <>
        <div className="overflow-hidden rounded-panel border border-line bg-surface">
          <table className="w-full table-fixed text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">{t('history.col.voiceover')}</th>
                <th scope="col" className="hidden w-36 px-4 py-3 font-medium md:table-cell">{t('history.col.status')}</th>
                <th scope="col" className="hidden w-28 px-4 py-3 text-right font-medium lg:table-cell">{t('history.col.chars')}</th>
                <th scope="col" className="hidden w-24 px-4 py-3 text-right font-medium lg:table-cell">{t('history.col.credits')}</th>
                <th scope="col" className="hidden w-24 px-4 py-3 text-right font-medium md:table-cell">{t('history.col.duration')}</th>
                <th scope="col" className="w-28 px-4 py-3 text-right font-medium lg:w-40"><span className="sr-only">{t('history.col.actions')}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((j) => <HistoryRow key={j.id} job={j} onDeleted={() => remove(j.id)} />)}
            </tbody>
          </table>
        </div>
        {error ? <Notice tone="danger">{errorText(t, error)}</Notice> : null}
        {nextBefore ? (
          <Button className="self-center" loading={loadingMore} onClick={more}>{t('common.load_more')}</Button>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('history.title')} />
      {body}
    </div>
  );
}

function HistoryRow({ job, onDeleted }) {
  const { t, lang } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const triggerRef = useRef(null);
  const confirmRef = useRef(null);
  const wasConfirming = useRef(false);
  const promptId = `job-delete-${job.id}`;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteJob(job.id);
      onDeleted();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const detail = await api.job(job.id);
      const name = AUDIO_FILES.find((n) => detail.files?.[n]);
      if (!name) throw { code: 'not_found' };
      const url = detail.files[name];
      const revision = revisionOf(url) ?? detail.revision;
      triggerDownload(url, `lq-tts-${job.id.slice(0, 8)}-r${revision}.${name.split('.').pop()}`);
    } catch (err) {
      setError(err);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <tr data-testid="history-row" data-job-id={job.id} className="align-top">
      <td className="px-4 py-3">
        <Link to={`/jobs/${job.id}`} className="font-medium text-ink transition-colors duration-150 [overflow-wrap:anywhere] hover:text-accent">{job.title}</Link>
        <p className="mt-0.5 text-xs text-muted">{job.voiceName ?? t('history.voice_deleted')} · {formatDateTime(job.createdAt, lang)}</p>
        <div className="mt-1 md:hidden"><JobStatus status={job.status} /></div>
        {confirming ? <p id={promptId} role="alert" className="mt-2 text-sm text-ink">{t('job.delete_confirm')}</p> : null}
        {error ? <p className="mt-1 text-xs text-danger" role="alert">{errorText(t, error)}</p> : null}
      </td>
      <td className="hidden px-4 py-3 md:table-cell"><JobStatus status={job.status} /></td>
      <td className="hidden px-4 py-3 text-right font-mono tabular lg:table-cell">{formatNumber(job.chars, lang)}</td>
      <td className="hidden px-4 py-3 text-right font-mono tabular lg:table-cell">{formatNumber(job.credits, lang)}</td>
      <td className="hidden px-4 py-3 text-right font-mono tabular md:table-cell">{formatDuration(job.audioSeconds)}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap justify-end gap-1">
          {confirming ? (
            <>
              <Button ref={confirmRef} variant="danger" size="sm" loading={busy} aria-describedby={promptId} onClick={remove}>{t('job.delete')}</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" icon={DownloadSimpleIcon} disabled={job.status !== 'done'} loading={downloading} onClick={download} aria-label={t('history.download_named', { title: job.title })}>
                <span className="hidden lg:inline">{t('common.download')}</span>
              </Button>
              <Button ref={triggerRef} variant="ghost" size="sm" icon={TrashIcon} onClick={() => setConfirming(true)} aria-label={t('history.delete_named', { title: job.title })} />
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
