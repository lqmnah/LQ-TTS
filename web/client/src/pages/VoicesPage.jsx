import { PlusIcon, TrashIcon, UserSoundIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import PlayButton from '../components/PlayButton.jsx';
import { ProfileSection } from '../components/VoiceProfiles.jsx';
import { VoiceStatus } from '../components/status.jsx';
import { Button, EmptyState, Field, Notice, PageHeader, Segmented, Skeleton, buttonClass, inputClass } from '../components/ui.jsx';
import { hasKey, useI18n } from '../i18n/index.jsx';
import { api, createVoice } from '../lib/api.js';
import { errorText, voiceErrorText } from '../lib/errors.js';
import { formatBytes, formatDateTime } from '../lib/format.js';
import { formatNumber } from '../lib/pricing.js';
import { useSession } from '../lib/session.jsx';
import { useResource } from '../lib/useResource.js';
import { audioFileProblem, countsTowardLimit } from '../lib/voices.js';

function languageLabel(t, code) {
  if (!code) return '–';
  return hasKey(`voices.language.${code}`) ? t(`voices.language.${code}`) : String(code).toUpperCase();
}

/** A 409 `voice_not_ready` from the upload means another upload of this user still holds the lease. */
function cloneErrorText(t, err) {
  if (err?.code === 'voice_not_ready') return t('voices.form.upload_busy');
  if (err?.code === 'too_large') return t('voices.form.audio_size');
  return errorText(t, err);
}

export default function VoicesPage() {
  const { t, lang } = useI18n();
  const session = useSession();
  const me = session.me;
  const voices = useResource(() => api.voices(), []);
  const profiles = useResource(() => api.voiceProfiles(), []);
  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const cloneButtonRef = useRef(null);
  const limitRef = useRef(null);
  const returnFocus = useRef(false);
  const followClone = useRef(false);
  const { reload, setData } = voices;
  const list = voices.data ?? [];
  const processing = list.some((v) => v.status === 'processing');

  useEffect(() => {
    if (!processing) return undefined;
    const timer = setInterval(() => {
      reload();
    }, 4000);
    return () => clearInterval(timer);
  }, [processing, reload]);

  const loaded = voices.data !== undefined;
  // The list is the source of truth once loaded; before that (or if it fails) fall back to the session count, which may be null.
  const used = loaded ? list.filter(countsTowardLimit).length : me?.voiceCount ?? null;
  const limit = me?.voiceLimit ?? 0;
  const atLimit = loaded && used >= limit;
  const usedLabel = used === null ? '–' : formatNumber(used, lang);


  function closeForm() {
    returnFocus.current = true;
    setFormOpen(false);
  }

  function onCreated() {
    closeForm();
    setCreated(true);
    reload();
    session.refresh();
  }

  // A 403 voice_limit_reached means our count was stale: refreshAll re-reads both; once the list shows the limit, its notice replaces the form.
  // Also used after a cancel, since a late abort can still leave a created voice behind.
  function refreshAll() {
    reload();
    session.refresh();
  }


  useEffect(() => {
    if (!atLimit || !formOpen) return;
    returnFocus.current = true;
    setFormOpen(false);
  }, [atLimit, formOpen]);

  // Focus after the form closes: back to the clone button, or to the limit notice when that button is disabled.
  // `followClone` covers the limit arriving after we refocused the button (its reload lands later), which would
  // otherwise leave focus on a disabled button or drop it to <body>.
  useEffect(() => {
    if (formOpen) return;
    if (atLimit) {
      const active = document.activeElement;
      const lost = followClone.current && (active === cloneButtonRef.current || active === document.body || !active);
      if (returnFocus.current || lost) limitRef.current?.focus();
      returnFocus.current = false;
      followClone.current = false;
      return;
    }
    if (!returnFocus.current) return;
    returnFocus.current = false;
    followClone.current = true;
    cloneButtonRef.current?.focus();
  }, [formOpen, atLimit]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t('voices.title')}
        subtitle={loaded || voices.error ? t('voices.usage', { count: usedLabel, limit: formatNumber(limit, lang) }) : null}
        actions={formOpen ? null : (
          <Button ref={cloneButtonRef} variant="primary" icon={PlusIcon} disabled={!loaded || atLimit} onClick={() => { followClone.current = false; setFormOpen(true); setCreated(false); }}>
            {t('voices.clone')}
          </Button>
        )}
      />
      <ProfileSection profiles={profiles} />
      <section aria-labelledby="my-voices-heading" className="flex flex-col gap-4">
        <h2 id="my-voices-heading" className="text-lg font-semibold text-ink">{t('voices.mine')}</h2>
        {atLimit ? (
          <div ref={limitRef} tabIndex={-1} className="rounded-control outline-none">
            <Notice
              tone="warning"
              testId="voice-limit"
              action={me?.paid ? null : <a className={buttonClass('secondary', 'sm')} href={me?.topupUrl} target="_blank" rel="noreferrer">{t('voices.upgrade')}</a>}
            >
              {t('voices.limit', { limit: formatNumber(limit, lang) })}
            </Notice>
          </div>
        ) : null}
        {created && processing ? <Notice tone="success">{t('voices.form.success')}</Notice> : null}
        {formOpen ? <CloneVoiceForm onCancel={closeForm} onCreated={onCreated} onLimitReached={refreshAll} onAborted={refreshAll} onAnnounce={setAnnouncement} /> : null}
        <p className="sr-only" aria-live="polite" data-testid="upload-live">{announcement}</p>
        <VoiceList
          voices={voices}
          onDeleted={(id) => {
            setData((items) => items?.filter((v) => v.id !== id));
            reload();
            session.refresh();
          }}
        />
      </section>
    </div>
  );
}

function VoiceList({ voices, onDeleted }) {
  const { t } = useI18n();
  if (voices.data === undefined && !voices.error) {
    return <div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[72px]" />)}</div>;
  }
  if (voices.data === undefined) {
    return <Notice tone="danger" action={<Button size="sm" onClick={voices.reload}>{t('common.retry')}</Button>}>{errorText(t, voices.error)}</Notice>;
  }
  if (!voices.data.length) return <EmptyState icon={UserSoundIcon} title={t('voices.empty_title')} body={t('voices.empty_body')} />;
  return (
    <ul className="flex flex-col divide-y divide-line rounded-panel border border-line bg-surface">
      {voices.data.map((v) => <VoiceRow key={v.id} voice={v} onDeleted={onDeleted} />)}
    </ul>
  );
}

function VoiceRow({ voice, onDeleted }) {
  const { t, lang } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const triggerRef = useRef(null);
  const confirmRef = useRef(null);
  const wasConfirming = useRef(false);
  const promptId = `voice-delete-${voice.id}`;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteVoice(voice.id);
      onDeleted(voice.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <li data-testid="voice-row" data-status={voice.status} className="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <PlayButton src={voice.status === 'ready' ? voice.previewUrl : null} label={t('voices.preview', { name: voice.name })} />
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{voice.name}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <VoiceStatus status={voice.status} />
            <span>{languageLabel(t, voice.language)}</span>
            {voice.refSeconds ? <span className="font-mono tabular">{t('voices.ref_seconds', { seconds: voice.refSeconds.toFixed(1) })}</span> : null}
            <span>{formatDateTime(voice.createdAt, lang)}</span>
          </p>
          {voice.status === 'failed' ? <p className="mt-1 text-sm text-danger">{voiceErrorText(t, voice.errorCode)}</p> : null}
          {error ? <p className="mt-1 text-sm text-danger" role="alert">{errorText(t, error)}</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:justify-end">
        {confirming ? (
          <>
            <span id={promptId} role="alert" className="text-sm text-ink">{t('voices.delete_confirm', { name: voice.name })}</span>
            <Button ref={confirmRef} variant="danger" size="sm" loading={busy} aria-describedby={promptId} onClick={remove}>{t('common.delete')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
          </>
        ) : (
          <Button ref={triggerRef} variant="ghost" size="sm" icon={TrashIcon} aria-label={t('voices.delete_named', { name: voice.name })} onClick={() => setConfirming(true)}>
            {t('voices.delete')}
          </Button>
        )}
      </div>
    </li>
  );
}

function CloneVoiceForm({ onCancel, onCreated, onLimitReached, onAborted, onAnnounce }) {
  const { t, lang } = useI18n();
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('auto');
  const [transcript, setTranscript] = useState('');
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState({});
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const headingRef = useRef(null);
  const announcedStep = useRef(-1);

  useEffect(() => {
    headingRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []);

  // Announce start, every 25 % and completion, not every progress tick.
  function onProgress(percent) {
    setProgress(percent);
    const step = Math.floor(percent / 25);
    if (step > announcedStep.current) {
      announcedStep.current = step;
      onAnnounce(t('voices.form.uploading', { percent: step * 25 }));
    }
  }

  function cancel() {
    if (abortRef.current) {
      abortRef.current.abort();
      return;
    }
    onCancel();
  }

  const fileProblem = audioFileProblem(file);
  const nameProblem = name.trim() ? null : 'voices.form.name_required';
  const fileError = touched.file && fileProblem ? t(fileProblem) : null;
  const nameError = touched.name && nameProblem ? t(nameProblem) : null;
  const consentError = touched.consent && !consent;
  const uploading = progress !== null;
  const languages = [
    { value: 'auto', label: t('voices.language.auto') },
    { value: 'id', label: t('voices.language.id') },
    { value: 'en', label: t('voices.language.en') },
  ];

  async function submit(event) {
    event.preventDefault();
    setTouched({ file: true, name: true, consent: true });
    if (fileProblem || nameProblem || !consent) return;
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    announcedStep.current = -1;
    onProgress(0);
    try {
      await createVoice(
        { file, name: name.trim(), language, transcript: transcript.trim(), consent },
        { onProgress, signal: controller.signal },
      );
      abortRef.current = null;
      onCreated();
    } catch (err) {
      abortRef.current = null;
      setProgress(null);
      if (err?.name === 'AbortError') {
        // The body may already have reached the server, which then creates the voice anyway: re-read to show it.
        onAnnounce('');
        onAborted();
        return;
      }
      onAnnounce('');
      setError(err);
      if (err?.code === 'voice_limit_reached') onLimitReached();
    }
  }

  return (
    <form noValidate onSubmit={submit} data-testid="clone-form" className="flex flex-col gap-5 rounded-panel border border-line bg-surface p-5 md:p-6">
      <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-ink outline-none">{t('voices.form.title')}</h2>
      {error ? <Notice tone="danger">{cloneErrorText(t, error)}</Notice> : null}
      <Field id="voice-audio" label={t('voices.form.audio')} help={t('voices.form.audio_help')} error={fileError}>
        <input
          id="voice-audio"
          type="file"
          accept=".mp3,.wav,.m4a,.flac,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/flac"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setTouched((s) => ({ ...s, file: true })); }}
          aria-invalid={fileError ? true : undefined}
          aria-describedby={fileError ? 'voice-audio-error' : 'voice-audio-help'}
          disabled={uploading}
          className="block w-full text-sm text-muted file:mr-3 file:h-11 file:cursor-pointer file:rounded-control file:border file:border-line file:bg-surface-2 file:px-4 file:text-sm file:font-medium file:text-ink hover:file:border-dim"
        />
      </Field>
      {file && !fileProblem ? <p className="-mt-3 font-mono text-sm text-muted">{file.name} · {formatBytes(file.size, lang)}</p> : null}
      <Field id="voice-name" label={t('voices.form.name')} error={nameError}>
        <input
          id="voice-name"
          maxLength={80}
          value={name}
          disabled={uploading}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, name: true }))}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? 'voice-name-error' : undefined}
          className={`${inputClass} h-11`}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span id="voice-language" className="text-sm font-medium text-ink">{t('voices.form.language')}</span>
        <Segmented labelledBy="voice-language" value={language} onChange={setLanguage} options={languages} />
      </div>
      <Field id="voice-transcript" label={t('voices.form.transcript')} help={t('voices.form.transcript_help')}>
        <textarea
          id="voice-transcript"
          rows={3}
          maxLength={5000}
          value={transcript}
          disabled={uploading}
          onChange={(e) => setTranscript(e.target.value)}
          aria-describedby="voice-transcript-help"
          className={`${inputClass} py-2 leading-relaxed`}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-ink">
          <input
            type="checkbox"
            checked={consent}
            disabled={uploading}
            onChange={(e) => setConsent(e.target.checked)}
            aria-invalid={consentError || undefined}
            aria-describedby={consentError ? 'consent-error' : undefined}
            className="mt-0.5 size-5 shrink-0 cursor-pointer accent-accent"
          />
          <span>{t('voices.form.consent')}</span>
        </label>
        {consentError ? <p id="consent-error" className="text-sm text-danger">{t('error.consent_required')}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" loading={uploading}>
          {uploading ? t('voices.form.uploading', { percent: progress }) : t('voices.form.submit')}
        </Button>
        <Button variant="ghost" onClick={cancel}>{t('common.cancel')}</Button>
      </div>
      {uploading ? (
        <div role="progressbar" aria-label={t('voices.form.upload_progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-1 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-full origin-left bg-accent transition-transform duration-300 ease-out" style={{ transform: `scaleX(${progress / 100})` }} />
        </div>
      ) : null}
    </form>
  );
}
