import { ArrowLeftIcon, ArrowsClockwiseIcon, DownloadSimpleIcon, PencilSimpleIcon, StopIcon, TrashIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import PlayButton from '../components/PlayButton.jsx';
import { JobStatus, SentenceStatus } from '../components/status.jsx';
import { Button, EmptyState, Field, Notice, Select, Skeleton, buttonClass, inputClass, touchLinkClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api, openJobEvents, urls } from '../lib/api.js';
import { errorText, jobFailureText } from '../lib/errors.js';
import { formatDateTime, formatDuration } from '../lib/format.js';
import { MAX_SENTENCE_CHARS, charCount, creditsFor, formatNumber } from '../lib/pricing.js';
import { TERMINAL, doneCount, progressReducer } from '../lib/progress.js';
import { claimAudio, releaseAudio } from '../lib/useAudioToggle.js';
import { useSession } from '../lib/session.jsx';

const FILE_ORDER = ['final.mp3', 'final.wav', 'subs.srt', 'subs.vtt'];
const FILE_LABELS = { 'final.mp3': 'MP3', 'final.wav': 'WAV', 'subs.srt': 'SRT', 'subs.vtt': 'VTT' };
const extOf = (name) => name.split('.').pop();
const revisionOf = (url) => {
  const match = /[?&]revision=(\d+)/.exec(url ?? '');
  return match ? Number(match[1]) : null;
};
const RETRY_DELAYS_MS = [2000, 5000, 10000];

export default function JobPage() {
  const { id } = useParams();
  const { t, tn, lang } = useI18n();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [job, setJob] = useState(null);
  const [sentences, setSentences] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [progress, dispatch] = useReducer(progressReducer, null);
  const [connection, setConnection] = useState('idle');
  const [revision, setRevision] = useState(null);
  const [justFinished, setJustFinished] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const estimatedSeconds = location.state?.estimatedSeconds ?? null;

  /** Loads the snapshot; resolves to `{job}` or `{error}`. */
  const load = useCallback(async () => {
    try {
      const [nextJob, nextSentences] = await Promise.all([api.job(id), api.sentences(id)]);
      setJob(nextJob);
      setSentences(nextSentences);
      setRevision(null);
      setLoadError(null);
      dispatch({ type: 'snapshot', job: nextJob, sentences: nextSentences });
      return { job: nextJob };
    } catch (err) {
      setLoadError(err);
      // Deleted meanwhile (another tab): drop the stale view so the not-found state shows.
      if (err?.code === 'not_found') setJob(null);
      return { error: err };
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const status = progress?.status ?? null;
  const live = status !== null && !TERMINAL.has(status);

  const attemptRef = useRef(0);
  const [streamKey, setStreamKey] = useState(0);

  useEffect(() => {
    if (!live) return undefined;
    let finished = false;
    let timer = null;
    setConnection('connecting');
    const close = openJobEvents(id, {
      onOpen: () => {
        attemptRef.current = 0;
        setConnection('live');
      },
      onError: (info) => {
        if (finished) return;
        setConnection('reconnecting');
        if (!info?.closed) return;
        // The browser gave up (engine restart, 401, 404): reload the snapshot after a backoff, then reopen.
        finished = true;
        close();
        const delay = RETRY_DELAYS_MS[Math.min(attemptRef.current, RETRY_DELAYS_MS.length - 1)];
        attemptRef.current += 1;
        timer = setTimeout(async () => {
          const { job: next, error } = await load();
          if (next && TERMINAL.has(next.status)) {
            setConnection('idle');
            setCanceling(false);
            if (next.status === 'done') setJustFinished(true);
            refresh();
            return;
          }
          // Gone for good: stay on the not-found state. Any other failure keeps backing off via a fresh stream.
          if (error?.code === 'not_found') return;
          setStreamKey((k) => k + 1);
        }, delay);
      },
      onEvent: (event) => {
        dispatch(event);
        if (event.type === 'job_done' || event.type === 'job_failed') {
          finished = true;
          close();
          setConnection('idle');
          setCanceling(false);
          if (event.type === 'job_done') setJustFinished(true);
          load();
          refresh();
        }
      },
    });
    return () => {
      finished = true;
      clearTimeout(timer);
      close();
    };
  }, [id, live, load, refresh, streamKey]);

  function onRegenerated(idx, result) {
    dispatch({ type: 'regenerate_started', idx, revision: result.revision });
    setJustFinished(false);
    setActionError(null);
    refresh();
  }

  async function cancel() {
    setCanceling(true);
    setActionError(null);
    try {
      await api.cancelJob(id);
    } catch (err) {
      setActionError({ source: 'cancel', err });
      setCanceling(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setActionError(null);
    try {
      await api.deleteJob(id);
      refresh();
      navigate('/history', { replace: true });
    } catch (err) {
      setActionError({ source: 'delete', err });
      setDeleting(false);
    }
  }

  if (loadError && !job) {
    if (loadError.code === 'not_found') {
      return (
        <EmptyState
          icon={WarningCircleIcon}
          title={t('job.not_found_title')}
          body={t('job.not_found_body')}
          action={<Link to="/history" className={buttonClass('secondary')}>{t('nav.history')}</Link>}
        />
      );
    }
    return <Notice tone="danger" action={<Button size="sm" onClick={load}>{t('common.retry')}</Button>}>{errorText(t, loadError)}</Notice>;
  }
  if (!job || !sentences || !progress) return <JobSkeleton />;

  const total = progress.total;
  const done = doneCount(progress);
  const files = FILE_ORDER.filter((name) => job.files?.[name]);
  const audioName = files.find((name) => name === 'final.mp3' || name === 'final.wav') ?? null;
  // Files point at the newest revision on disk, which lags job.revision while a regenerate runs.
  const fileRevision = revisionOf(job.files?.[files[0]]) ?? job.revision;
  const revisions = job.revisions.filter((r) => r <= fileRevision);
  const shownRevision = revision ?? fileRevision;
  const fileUrl = (name) => (shownRevision === fileRevision ? job.files[name] : urls.file(id, name, shownRevision));
  const needsReview = TERMINAL.has(status) ? Object.values(progress.sentences).filter((s) => s.status === 'needs_review').length : 0;
  const downloadName = (name) => `lq-tts-${job.id.slice(0, 8)}-r${shownRevision}.${extOf(name)}`;

  return (
    <div className="flex flex-col gap-6">
      <Link to="/" className={`inline-flex w-fit items-center gap-2 text-sm text-muted transition-colors duration-150 hover:text-ink ${touchLinkClass}`}>
        <ArrowLeftIcon size={16} aria-hidden />
        {t('job.back')}
      </Link>

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-ink [overflow-wrap:anywhere]">{job.title}</h1>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
          <span>{job.voiceName ?? t('history.voice_deleted')}</span>
          <span>{formatDateTime(job.createdAt, lang)}</span>
          <span className="font-mono tabular">{tn('job.chars', job.chars, { count: formatNumber(job.chars, lang) })}</span>
          <span className="font-mono tabular">{tn('job.credits', job.credits, { count: formatNumber(job.credits, lang) })}</span>
          {job.audioSeconds ? <span className="font-mono tabular">{formatDuration(job.audioSeconds)}</span> : null}
        </p>
      </header>

      <section aria-labelledby="progress-heading" className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-4 md:p-5">
        <h2 id="progress-heading" className="sr-only">{t('job.progress_heading')}</h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <JobStatus status={status} testId="job-status" />
          <p className="font-mono text-sm tabular text-muted" aria-live="polite">
            {t('job.progress', { done: formatNumber(done, lang), total: formatNumber(total, lang) })}
          </p>
        </div>
        <div
          data-testid="progress"
          data-done={done}
          data-total={total}
          role="progressbar"
          aria-label={t('job.progress_heading')}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="h-2 overflow-hidden rounded-full bg-surface-2"
        >
          <div className="h-full w-full origin-left rounded-full bg-accent transition-transform duration-300 ease-out" style={{ transform: `scaleX(${total ? done / total : 0})` }} />
        </div>
        {live ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
            <span>
              {connection === 'reconnecting'
                ? t('job.reconnecting')
                : estimatedSeconds && progress.revision === 1
                  ? t('job.estimate', { time: formatDuration(estimatedSeconds) })
                  : t('job.live')}
            </span>
            <Button size="sm" icon={StopIcon} loading={canceling} onClick={cancel}>{t('job.cancel')}</Button>
          </div>
        ) : null}
        {justFinished && status === 'done' ? <Notice tone="success" testId="job-finished">{t('job.done_notice')}</Notice> : null}
        {status === 'failed' || status === 'canceled' ? (
          <Notice tone={status === 'canceled' ? 'info' : 'danger'}>{jobFailureText(t, status, progress.errorCode, progress.revision)}</Notice>
        ) : null}
        {needsReview > 0 ? <Notice tone="warning">{tn('job.needs_review', needsReview, { count: formatNumber(needsReview, lang) })}</Notice> : null}
        {actionError ? (
          <Notice tone="danger">
            {actionError.source === 'cancel' && actionError.err?.code === 'not_regeneratable' ? t('job.cancel_busy') : errorText(t, actionError.err)}
          </Notice>
        ) : null}
        {loadError && job ? (
          <Notice tone="danger" action={<Button size="sm" onClick={load}>{t('common.retry')}</Button>}>{errorText(t, loadError)}</Notice>
        ) : null}
      </section>

      {files.length ? (
        <section aria-labelledby="output-heading" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="output-heading" className="text-lg font-semibold text-ink">{t('job.output')}</h2>
            {revisions.length > 1 ? (
              <div className="w-44">
                <label htmlFor="revision" className="sr-only">{t('job.revision')}</label>
                <Select id="revision" data-testid="revision-select" value={String(shownRevision)} onChange={(e) => setRevision(Number(e.target.value))}>
                  {[...revisions].reverse().map((r) => <option key={r} value={String(r)}>{t('job.revision_n', { n: r })}</option>)}
                </Select>
              </div>
            ) : null}
          </div>
          {audioName ? (
            <audio
              key={`${audioName}-${shownRevision}`}
              data-testid="final-audio"
              controls
              preload="metadata"
              src={fileUrl(audioName)}
              onPlay={(e) => claimAudio(e.currentTarget)}
              onPause={(e) => releaseAudio(e.currentTarget)}
              className="w-full"
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {files.map((name) => (
              <a key={name} href={fileUrl(name)} download={downloadName(name)} data-testid={`download-${extOf(name)}`} className={buttonClass('secondary')}>
                <DownloadSimpleIcon size={18} aria-hidden />
                {FILE_LABELS[name]}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="sentences-heading" className="flex flex-col gap-3">
        <h2 id="sentences-heading" className="text-lg font-semibold text-ink">{t('job.sentences')}</h2>
        <ol className="flex flex-col divide-y divide-line rounded-panel border border-line bg-surface">
          {sentences.map((s) => (
            <SentenceRow
              key={s.idx}
              jobId={id}
              sentence={s}
              live={progress.sentences[s.idx]}
              arrived={progress.lastArrived === s.idx}
              audioVersion={progress.revision}
              editable={status === 'done'}
              onRegenerated={onRegenerated}
            />
          ))}
        </ol>
      </section>

      <DeleteJob deleting={deleting} confirming={confirmDelete} onConfirm={remove} onToggle={setConfirmDelete} />
    </div>
  );
}

function SentenceRow({ jobId, sentence, live, arrived, audioVersion, editable, onRegenerated }) {
  const { t, tn, lang } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(sentence.text);
  const [style, setStyle] = useState(sentence.style ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const editRef = useRef(null);
  const textRef = useRef(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (!editing) {
      setText(sentence.text);
      setStyle(sentence.style ?? '');
    }
  }, [editing, sentence.text, sentence.style]);

  useEffect(() => {
    if (editing) textRef.current?.focus();
    else if (wasEditing.current) editRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const status = live?.status ?? sentence.status;
  const score = live ? live.score : sentence.score;
  const finished = status === 'done' || status === 'needs_review';
  const n = sentence.idx + 1;
  const nextText = text.trim();
  const tooLong = charCount(nextText) > MAX_SENTENCE_CHARS;
  const credits = creditsFor(charCount(nextText));
  const base = `s${sentence.idx}`;

  async function regenerate(event) {
    event.preventDefault();
    if (!nextText || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      const changes = {};
      if (nextText !== sentence.text) changes.text = nextText;
      const nextStyle = style.trim();
      if (nextStyle !== (sentence.style ?? '')) changes.style = nextStyle;
      const result = await api.regenerate(jobId, sentence.idx, changes);
      setEditing(false);
      onRegenerated(sentence.idx, result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li data-testid={`sentence-${sentence.idx}`} data-status={status} className={`flex gap-3 px-3 py-3 md:px-4 ${arrived ? 'animate-arrive' : ''}`}>
      <span className="w-7 shrink-0 pt-2 text-right font-mono text-sm tabular text-dim">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-4">
          <div className="min-w-0 pt-1.5">
            {sentence.style ? <p className="mb-1 text-xs text-dim">{t('job.sentence.style_label', { style: sentence.style })}</p> : null}
            <p className="max-w-[70ch] text-base leading-relaxed text-ink">{sentence.text}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <SentenceStatus status={status} />
              {finished && score != null ? <span className="font-mono tabular">{t('job.sentence.score', { score: Math.round(score * 100) })}</span> : null}
              {finished && sentence.durationS ? <span className="font-mono tabular">{formatDuration(sentence.durationS)}</span> : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <PlayButton src={finished ? urls.sentenceAudio(jobId, sentence.idx, audioVersion) : null} label={t('job.sentence.play', { n })} />
            {/* aria-disabled, not disabled: focus returns here after a regenerate, while the job is busy again. */}
            <Button
              ref={editRef}
              variant="ghost"
              size="sm"
              icon={PencilSimpleIcon}
              aria-disabled={!editable || undefined}
              aria-expanded={editing}
              aria-controls={`${base}-editor`}
              onClick={() => {
                if (editable || editing) setEditing((v) => !v);
              }}
              className="aria-disabled:cursor-not-allowed aria-disabled:text-dim aria-disabled:hover:bg-transparent aria-disabled:active:scale-100"
            >
              {t('job.sentence.edit')}
            </Button>
          </div>
        </div>
        {editing ? (
          <form id={`${base}-editor`} onSubmit={regenerate} className="mt-3 flex flex-col gap-4 rounded-control bg-surface-2 p-4">
            <Field id={`${base}-text`} label={t('job.sentence.text')} help={t('job.sentence.one_sentence')}>
              <textarea ref={textRef} id={`${base}-text`} rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${base}-text-help`} className={`${inputClass} py-2 leading-relaxed`} />
            </Field>
            <Field id={`${base}-style`} label={t('job.sentence.style')}>
              <input id={`${base}-style`} value={style} maxLength={200} placeholder={t('job.sentence.style_placeholder')} onChange={(e) => setStyle(e.target.value)} className={`${inputClass} h-11`} />
            </Field>
            {tooLong ? <Notice tone="danger">{t('job.sentence.one_sentence')}</Notice> : null}
            {error && !tooLong ? <Notice tone="danger">{error.code === 'invalid_request' ? t('job.sentence.one_sentence') : errorText(t, error)}</Notice> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" icon={ArrowsClockwiseIcon} loading={busy} disabled={!nextText || tooLong || !editable}>{t('job.sentence.regenerate')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
              <span className="text-sm text-muted">{tn('job.sentence.regenerate_price', credits, { count: formatNumber(credits, lang) })}</span>
            </div>
          </form>
        ) : null}
      </div>
    </li>
  );
}

function DeleteJob({ deleting, confirming, onConfirm, onToggle }) {
  const { t } = useI18n();
  const triggerRef = useRef(null);
  const confirmRef = useRef(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  return (
    <section className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
      {confirming ? (
        <>
          <p id="job-delete-prompt" role="alert" className="text-sm text-ink">{t('job.delete_confirm')}</p>
          <Button ref={confirmRef} variant="danger" loading={deleting} aria-describedby="job-delete-prompt" onClick={onConfirm}>{t('job.delete')}</Button>
          <Button variant="ghost" disabled={deleting} onClick={() => onToggle(false)}>{t('common.cancel')}</Button>
        </>
      ) : (
        <Button ref={triggerRef} variant="ghost" icon={TrashIcon} onClick={() => onToggle(true)}>{t('job.delete')}</Button>
      )}
    </section>
  );
}

function JobSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-9 w-3/4" />
      <Skeleton className="h-28" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}
      </div>
    </div>
  );
}
