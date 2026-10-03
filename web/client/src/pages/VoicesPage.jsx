import { PlusIcon, TrashIcon, UserSoundIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import PlayButton from '../components/PlayButton.jsx';
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
  return err?.code === 'voice_not_ready' ? t('voices.form.upload_busy') : errorText(t, err);
}

export default function VoicesPage() {
  const { t, lang } = useI18n();
  const session = useSession();
  const me = session.me;
  const voices = useResource(() => api.voices(), []);
  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState(false);
  const { reload } = voices;
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

  function onCreated() {
    setFormOpen(false);
    setCreated(true);
    reload();
    session.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('voices.title')}
        subtitle={loaded || voices.error ? t('voices.usage', { count: usedLabel, limit: formatNumber(limit, lang) }) : null}
        actions={formOpen ? null : (
          <Button variant="primary" icon={PlusIcon} disabled={!loaded || atLimit} onClick={() => { setFormOpen(true); setCreated(false); }}>
            {t('voices.clone')}
          </Button>
        )}
      />
      {atLimit ? (
        <Notice
          tone="warning"
          testId="voice-limit"
          action={me?.paid ? null : <a className={buttonClass('secondary', 'sm')} href={me?.topupUrl} target="_blank" rel="noreferrer">{t('voices.upgrade')}</a>}
        >
          {t('voices.limit', { limit: formatNumber(limit, lang) })}
        </Notice>
      ) : null}
      {created ? <Notice tone="success">{t('voices.form.success')}</Notice> : null}
      {formOpen ? <CloneVoiceForm onCancel={() => setFormOpen(false)} onCreated={onCreated} /> : null}
      <VoiceList voices={voices} onDeleted={() => { reload(); session.refresh(); }} />
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

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteVoice(voice.id);
      onDeleted();
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
            <span className="text-sm text-ink">{t('voices.delete_confirm', { name: voice.name })}</span>
            <Button variant="danger" size="sm" loading={busy} onClick={remove}>{t('common.delete')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" icon={TrashIcon} aria-label={t('voices.delete_named', { name: voice.name })} onClick={() => setConfirming(true)}>
            {t('voices.delete')}
          </Button>
        )}
      </div>
    </li>
  );
}

function CloneVoiceForm({ onCancel, onCreated }) {
  const { t, lang } = useI18n();
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('auto');
  const [transcript, setTranscript] = useState('');
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState({});
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

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
    setProgress(0);
    try {
      await createVoice({ file, name: name.trim(), language, transcript: transcript.trim(), consent }, { onProgress: setProgress });
      onCreated();
    } catch (err) {
      setError(err);
      setProgress(null);
    }
  }

  return (
    <form noValidate onSubmit={submit} data-testid="clone-form" className="flex flex-col gap-5 rounded-panel border border-line bg-surface p-5 md:p-6">
      <h2 className="text-lg font-semibold text-ink">{t('voices.form.title')}</h2>
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
        <Button variant="ghost" disabled={uploading} onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
      {uploading ? (
        <div role="progressbar" aria-label={t('voices.form.upload_progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-1 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-full origin-left bg-accent transition-transform duration-300 ease-out" style={{ transform: `scaleX(${progress / 100})` }} />
        </div>
      ) : null}
    </form>
  );
}
