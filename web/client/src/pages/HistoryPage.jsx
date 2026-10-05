import { CircleNotchIcon, ClockCounterClockwiseIcon, DownloadSimpleIcon, PauseIcon, PlayIcon, TrashIcon, XIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { playButtonClass } from '../components/PlayButton.jsx';
import { JobStatus } from '../components/status.jsx';
import { Button, EmptyState, Notice, PageHeader, Skeleton, StatusChip, buttonClass, touchLinkClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { triggerDownload } from '../lib/download.js';
import { errorText } from '../lib/errors.js';
import { formatDateTime, formatDuration } from '../lib/format.js';
import { formatNumber } from '../lib/pricing.js';
import { claimAudio, releaseAudio } from '../lib/useAudioToggle.js';

const PAGE_SIZE = 20;
const AUDIO_FILES = ['final.mp3', 'final.wav'];

/** Done jobs, and failed/canceled regenerates whose earlier revision is still on disk, have audio. */
const hasAudio = (job) => job.status === 'done' || ((job.status === 'failed' || job.status === 'canceled') && job.revision > 1);
/** The server's file URLs point at the newest revision on disk via `?revision=N`. */
const revisionOf = (url) => {
  const match = /[?&]revision=(\d+)/.exec(url ?? '');
  return match ? Number(match[1]) : null;
};
/** A browser that refuses to start playback (autoplay policy, aborted by a pause) still leaves the controls to press. */
const startPlayback = (audio) => {
  claimAudio(audio);
  Promise.resolve(audio.play()).catch(() => {});
};

export default function HistoryPage() {
  const { t } = useI18n();
  const [items, setItems] = useState(null);
  // Opaque server cursor: passed back unchanged, never built or parsed here.
  const [nextBefore, setNextBefore] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // One player at a time: opening a row closes the one before. Only the newest play request may open one,
  // so a slower earlier click never takes the player from the row clicked last.
  const [playerId, setPlayerId] = useState(null);
  const playerRequest = useRef(0);

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
  const requestPlayer = () => ++playerRequest.current;
  const openPlayer = (id, request) => {
    if (request === playerRequest.current) setPlayerId(id);
  };
  const closePlayer = (id) => setPlayerId((cur) => (cur === id ? null : cur));

  let body;
  if (items === null && !error) {
    body = <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>;
  } else if (items === null) {
    body = <Notice tone="danger" action={<Button size="sm" onClick={firstLoad}>{t('common.retry')}</Button>}>{errorText(t, error)}</Notice>;
  } else if (!items.length && !nextBefore) {
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
        {items.length ? (
          <div className="overflow-hidden rounded-panel border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th scope="col" className="w-full px-4 py-3 font-medium">{t('history.col.voiceover')}</th>
                  <th scope="col" className="hidden whitespace-nowrap px-4 py-3 font-medium md:table-cell">{t('history.col.status')}</th>
                  <th scope="col" className="hidden whitespace-nowrap px-4 py-3 text-right font-medium lg:table-cell">{t('history.col.chars')}</th>
                  <th scope="col" className="hidden whitespace-nowrap px-4 py-3 text-right font-medium lg:table-cell">{t('history.col.credits')}</th>
                  <th scope="col" className="hidden whitespace-nowrap px-4 py-3 text-right font-medium md:table-cell">{t('history.col.duration')}</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium"><span className="sr-only">{t('history.col.actions')}</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((j) => (
                  <HistoryRow
                    key={j.id}
                    job={j}
                    onDeleted={() => remove(j.id)}
                    playerOpen={playerId === j.id}
                    requestPlayer={requestPlayer}
                    onOpenPlayer={(request) => openPlayer(j.id, request)}
                    onClosePlayer={() => closePlayer(j.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
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

function HistoryRow({ job, onDeleted, playerOpen, requestPlayer, onOpenPlayer, onClosePlayer }) {
  const { t, lang } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [audioSrc, setAudioSrc] = useState(null);
  const [opening, setOpening] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [audioFailed, setAudioFailed] = useState(false);
  const triggerRef = useRef(null);
  const confirmRef = useRef(null);
  const wasConfirming = useRef(false);
  const audioRef = useRef(null);
  const playRef = useRef(null);
  const promptId = `job-delete-${job.id}`;
  const playerDomId = `job-player-${job.id}`;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  // Opening the player starts it; closing it (or another row opening) leaves this row idle.
  useEffect(() => {
    if (!playerOpen) {
      setPlaying(false);
      return;
    }
    if (audioRef.current) startPlayback(audioRef.current);
  }, [playerOpen, audioSrc]);

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

  /** The newest revision's audio, MP3 first: the server lists only files that exist on disk. */
  async function audioFile() {
    const detail = await api.job(job.id);
    const name = AUDIO_FILES.find((n) => detail.files?.[n]);
    if (!name) throw { code: 'not_found' };
    return { name, url: detail.files[name], revision: revisionOf(detail.files[name]) ?? detail.revision };
  }

  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const { name, url, revision } = await audioFile();
      triggerDownload(url, `lq-tts-${job.id.slice(0, 8)}-r${revision}.${name.split('.').pop()}`);
    } catch (err) {
      setError(err);
    } finally {
      setDownloading(false);
    }
  }

  async function togglePlay() {
    setError(null);
    setAudioFailed(false);
    const audio = audioRef.current;
    if (playerOpen && audio) {
      if (playing) {
        audio.pause();
        return;
      }
      // An element that failed to load never refetches on play(); load() starts it afresh.
      if (audioFailed) audio.load();
      startPlayback(audio);
      return;
    }
    const request = requestPlayer();
    setOpening(true);
    try {
      const { url } = await audioFile();
      setAudioSrc(url);
      onOpenPlayer(request);
    } catch (err) {
      setError(err);
    } finally {
      setOpening(false);
    }
  }

  function closePlayer() {
    onClosePlayer();
    playRef.current?.focus();
  }

  const confirmId = `job-delete-confirm-${job.id}`;
  return (
    <tr data-testid="history-row" data-job-id={job.id} className="align-top">
      <td className="px-4 py-3">
        <div className="flex items-start gap-3">
          <button
            ref={playRef}
            type="button"
            onClick={togglePlay}
            disabled={!hasAudio(job) || opening}
            aria-busy={opening || undefined}
            aria-pressed={playing}
            aria-controls={playerOpen && audioSrc ? playerDomId : undefined}
            aria-label={t('history.play_named', { title: job.title })}
            data-testid="history-play"
            className={playButtonClass({ playing, error: audioFailed })}
          >
            {opening ? (
              <CircleNotchIcon size={18} className="animate-spin" aria-hidden />
            ) : playing ? (
              <PauseIcon size={18} weight="fill" aria-hidden />
            ) : (
              <PlayIcon size={18} weight="fill" aria-hidden />
            )}
          </button>
          <div className="min-w-0 flex-1">
            <Link to={`/jobs/${job.id}`} className={`font-medium text-ink transition-colors duration-150 [overflow-wrap:anywhere] hover:text-accent ${touchLinkClass}`}>{job.title}</Link>
            {job.source === 'api' ? <span className="ml-2 inline-flex align-middle"><StatusChip testId="api-chip">{t('history.api_chip')}</StatusChip></span> : null}
            <p className="mt-0.5 text-xs text-muted">{job.voiceName ?? t('history.voice_deleted')} · {formatDateTime(job.createdAt, lang)}</p>
            <div className="mt-1 md:hidden"><JobStatus status={job.status} /></div>
            {error ? <p className="mt-1 text-xs text-danger" role="alert">{errorText(t, error)}</p> : null}
            {audioFailed ? <p className="mt-1 text-xs text-danger" role="alert">{t('history.play_failed')}</p> : null}
            {playerOpen && audioSrc ? (
              <div id={playerDomId} data-testid="history-player" className="mt-3 flex items-center gap-2 rounded-control border border-line bg-surface-2 p-2">
                <audio
                  ref={audioRef}
                  controls
                  preload="metadata"
                  src={audioSrc}
                  aria-label={t('history.player_named', { title: job.title })}
                  onPlay={(e) => {
                    claimAudio(e.currentTarget);
                    setPlaying(true);
                  }}
                  onPause={(e) => {
                    releaseAudio(e.currentTarget);
                    setPlaying(false);
                  }}
                  onEnded={() => setPlaying(false)}
                  onError={() => {
                    setPlaying(false);
                    setAudioFailed(true);
                  }}
                  className="h-10 min-w-0 flex-1"
                />
                <Button variant="ghost" size="sm" icon={XIcon} onClick={closePlayer} aria-label={t('history.player_close')} />
              </div>
            ) : null}
            {/* The confirm lives in the widest cell, never the narrow actions cell, so it wraps instead of overlapping. */}
            {confirming ? (
              <div id={confirmId} data-testid="history-confirm" className="mt-3 flex flex-col gap-3 rounded-control bg-danger-soft p-3 lg:flex-row lg:items-center lg:justify-between">
                <p id={promptId} role="alert" className="text-sm text-ink">{t('job.delete_confirm')}</p>
                <div className="flex flex-wrap gap-2 lg:shrink-0">
                  <Button ref={confirmRef} variant="danger" size="sm" loading={busy} aria-describedby={promptId} onClick={remove}>{t('job.delete')}</Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </td>
      <td className="hidden whitespace-nowrap px-4 py-3 md:table-cell"><JobStatus status={job.status} /></td>
      <td className="hidden whitespace-nowrap px-4 py-3 text-right font-mono tabular lg:table-cell">{formatNumber(job.chars, lang)}</td>
      <td className="hidden whitespace-nowrap px-4 py-3 text-right font-mono tabular lg:table-cell">{formatNumber(job.credits, lang)}</td>
      <td className="hidden whitespace-nowrap px-4 py-3 text-right font-mono tabular md:table-cell">{formatDuration(job.audioSeconds)}</td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" icon={DownloadSimpleIcon} disabled={!hasAudio(job) || confirming} loading={downloading} onClick={download} aria-label={t('history.download_named', { title: job.title })}>
            <span className="hidden lg:inline">{t('common.download')}</span>
          </Button>
          <Button ref={triggerRef} variant="ghost" size="sm" icon={TrashIcon} aria-expanded={confirming} aria-controls={confirming ? confirmId : undefined} onClick={() => setConfirming(true)} aria-label={t('history.delete_named', { title: job.title })} />
        </div>
      </td>
    </tr>
  );
}
