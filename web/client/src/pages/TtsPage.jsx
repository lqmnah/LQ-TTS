import { UserSoundIcon, WaveformIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { Button, EmptyState, Field, Notice, PageHeader, Select, Skeleton, buttonClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { DEFAULT_SETTINGS, FORMATS, MAX_SCRIPT_CHARS, loadDraft, normalizeSettings, saveDraft } from '../lib/draft.js';
import { errorText } from '../lib/errors.js';
import { charCount, creditsFor, formatNumber, rupiahFor } from '../lib/pricing.js';
import { useSession } from '../lib/session.jsx';
import { useResource } from '../lib/useResource.js';
import { pickVoice } from '../lib/voices.js';

const answered = (resource) => resource.data !== undefined || resource.error !== null;

export default function TtsPage() {
  const { t, tn, lang } = useI18n();
  const session = useSession();
  const me = session.me;
  const navigate = useNavigate();
  const { health } = useOutletContext() ?? {};
  const voices = useResource(() => api.voices(), []);
  const profiles = useResource(() => api.voiceProfiles(), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('voice');
  const [draft, setDraft] = useState(() => loadDraft(me.id));
  const [estimate, setEstimate] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [balanceTick, setBalanceTick] = useState(0);

  useEffect(() => {
    saveDraft(me.id, draft);
  }, [me.id, draft]);

  const trimmed = draft.text.trim();
  const chars = charCount(trimmed);
  const tooLong = chars > MAX_SCRIPT_CHARS;

  useEffect(() => {
    if (!trimmed || tooLong) {
      setEstimate(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await api.estimate(trimmed, controller.signal);
        setEstimate({ ...result, forText: trimmed });
      } catch (err) {
        if (err?.name !== 'AbortError') setEstimate(null);
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, tooLong, balanceTick]);

  const { refresh } = session;
  const recheckBalance = useCallback(() => {
    refresh();
    setBalanceTick((n) => n + 1);
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheckBalance();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [recheckBalance]);

  const mine = (voices.data ?? []).filter((v) => v.status === 'ready');
  const library = (profiles.data ?? []).filter((p) => p.status === 'ready');
  const settled = answered(voices) && answered(profiles);
  const requestedUsable = requested !== null && (mine.some((v) => v.id === requested) || library.some((p) => p.id === requested));

  // A profile card links here with ?voice=<id>. Once both lists are known it becomes the draft's voice (when usable)
  // and leaves the URL, so a later pick in the select is never overridden by the link. The URL is cleared only after
  // the draft holding it has committed (and been saved by the effect above), whatever order the lists resolved in.
  useEffect(() => {
    if (requested !== null && settled && requestedUsable && draft.voiceId !== requested) {
      setDraft((d) => ({ ...d, voiceId: requested }));
    }
  }, [requested, requestedUsable, settled, draft.voiceId]);
  useEffect(() => {
    if (requested === null || !settled || (requestedUsable && draft.voiceId !== requested)) return;
    setSearchParams((params) => {
      params.delete('voice');
      return params;
    }, { replace: true });
  }, [requested, requestedUsable, settled, draft.voiceId, setSearchParams]);
  // Nothing is picked (so Generate stays off) until the picker can show the choice: both lists answered and my own
  // voices loaded. A failed profiles fetch alone still leaves my own voices usable.
  const voiceId = settled && voices.data !== undefined
    ? pickVoice({ requested, saved: draft.voiceId, mine, profiles: library })
    : '';
  const fresh = estimate !== null && estimate.forText === trimmed;
  const credits = fresh ? estimate.credits : creditsFor(chars);
  const balance = fresh && estimate.balance != null ? estimate.balance : (me.balance ?? null);
  const short = chars > 0 && balance !== null && credits > balance;
  const lqsDown = health?.lqstudio === 'down';
  const noFormats = draft.settings.formats.length === 0;
  const canGenerate = chars > 0 && !tooLong && voiceId !== '' && !noFormats && !short && !lqsDown && !submitting;
  const update = (patch) => {
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setSetting = (key, value) => update({ settings: { ...draft.settings, [key]: value } });

  async function generate() {
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createJob(voiceId, trimmed, normalizeSettings(draft.settings));
      session.refresh();
      navigate(`/jobs/${job.id}`, { state: { estimatedSeconds: job.estimatedSeconds } });
    } catch (err) {
      setError(err);
      setSubmitting(false);
      if (err?.code === 'voice_not_ready') voices.reload();
      // A profile turned off since this page loaded (or a voice deleted elsewhere): re-read both lists.
      if (err?.code === 'not_found') {
        voices.reload();
        profiles.reload();
      }
      if (err?.code === 'insufficient_credits') recheckBalance();
    }
  }

  const topUp = <a className={buttonClass('primary', 'sm')} href={me.topupUrl} target="_blank" rel="noreferrer">{t('common.topup')}</a>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('tts.title')} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-8">
        <section className="flex flex-col gap-2">
          <label htmlFor="script" className="text-sm font-medium text-ink">{t('tts.script')}</label>
          <textarea
            id="script"
            data-testid="script"
            value={draft.text}
            onChange={(e) => update({ text: e.target.value })}
            placeholder={t('tts.script_placeholder')}
            spellCheck
            aria-invalid={tooLong || undefined}
            aria-describedby="script-help script-count"
            className="min-h-[22rem] w-full resize-y rounded-panel border border-line bg-surface p-4 text-base leading-relaxed text-ink placeholder:text-dim transition-colors duration-150 hover:border-dim focus-visible:border-accent aria-[invalid=true]:border-danger"
          />
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
            <p id="script-help" className="max-w-[65ch] leading-relaxed text-dim">{t('tts.script_help')}</p>
            <p id="script-count" className={`font-mono tabular ${tooLong ? 'text-danger' : 'text-muted'}`}>
              {t('tts.chars', { count: formatNumber(chars, lang), max: formatNumber(MAX_SCRIPT_CHARS, lang) })}
              {fresh && estimate.sentences > 0 ? ` · ${tn('tts.sentences', estimate.sentences, { count: formatNumber(estimate.sentences, lang) })}` : ''}
            </p>
          </div>
          {tooLong ? <p className="text-sm text-danger" role="alert">{t('tts.text_too_long')}</p> : null}
        </section>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-20">
          <VoicePicker voices={voices} profiles={profiles} settled={settled} mine={mine} library={library} value={voiceId} onChange={(id) => update({ voiceId: id })} />
          <SettingsPanel settings={draft.settings} onSet={setSetting} onReset={() => update({ settings: normalizeSettings(DEFAULT_SETTINGS) })} noFormats={noFormats} />
          <section className="flex flex-col gap-3">
            <div className="text-sm" aria-live="polite" aria-atomic="true">
              <p data-testid="price" className="font-medium text-ink">
                {chars > 0
                  ? tn('tts.price', credits, { credits: formatNumber(credits, lang), rupiah: formatNumber(rupiahFor(credits), lang) })
                  : t('tts.price_empty')}
              </p>
              <p data-testid="balance" className="mt-0.5 text-muted">
                {balance === null
                  ? <>{tn('tts.balance', 2, { balance: '–' })}<span className="mt-0.5 block text-dim">{t('tts.balance_unknown')}</span></>
                  : tn('tts.balance', balance, { balance: formatNumber(balance, lang) })}
              </p>
            </div>
            {short ? <Notice tone="warning" action={topUp}>{t('tts.topup_needed')}</Notice> : null}
            {error && !short ? (
              error.code === 'insufficient_credits'
                ? <Notice tone="warning" action={topUp}>{errorText(t, error)}</Notice>
                : <Notice tone="danger">{error.code === 'not_found' ? t('tts.voice_gone') : errorText(t, error)}</Notice>
            ) : null}
            {lqsDown ? <Notice tone="warning">{t('tts.lqstudio_down')}</Notice> : null}
            <Button variant="primary" size="lg" icon={WaveformIcon} loading={submitting} disabled={!canGenerate} onClick={generate} data-testid="generate" className="w-full">
              {submitting ? t('tts.generating') : t('tts.generate')}
            </Button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function VoicePicker({ voices, profiles, settled, mine, library, value, onChange }) {
  const { t } = useI18n();
  if (!settled) return <Skeleton className="h-[72px]" />;
  if (voices.data === undefined) {
    return <Notice tone="danger" action={<Button size="sm" onClick={voices.reload}>{t('common.retry')}</Button>}>{errorText(t, voices.error)}</Notice>;
  }
  if (!mine.length && profiles.data === undefined) {
    return <Notice tone="danger" action={<Button size="sm" onClick={profiles.reload}>{t('common.retry')}</Button>}>{t('tts.profiles_error')}</Notice>;
  }
  if (!mine.length && !library.length) {
    return (
      <EmptyState
        icon={UserSoundIcon}
        title={t('tts.empty_voices_title')}
        body={t('tts.empty_voices_body')}
        action={<Link to="/voices" className={buttonClass('primary')}>{t('tts.voice_create')}</Link>}
      />
    );
  }
  return (
    <Field id="voice" label={t('tts.voice')}>
      <Select id="voice" data-testid="voice-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {library.length ? (
          <optgroup label={t('profiles.title')}>
            {library.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </optgroup>
        ) : null}
        {mine.length ? (
          <optgroup label={t('voices.mine')}>
            {mine.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </optgroup>
        ) : null}
      </Select>
    </Field>
  );
}
function RangeField({ id, label, value, min, max, step, display, onChange }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
        <output htmlFor={id} className="font-mono text-sm tabular text-muted">{display}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} aria-valuetext={display} onChange={(e) => onChange(Number(e.target.value))} className="h-11 w-full cursor-pointer accent-accent" />
    </div>
  );
}

function SettingsPanel({ settings, onSet, onReset, noFormats }) {
  const { t } = useI18n();
  const toggleFormat = (f) => {
    const on = settings.formats.includes(f);
    onSet('formats', on ? settings.formats.filter((x) => x !== f) : FORMATS.filter((x) => x === f || settings.formats.includes(x)));
  };
  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{t('tts.settings')}</h2>
        <Button variant="ghost" size="sm" onClick={onReset}>{t('tts.reset')}</Button>
      </div>
      <RangeField id="speed" label={t('tts.speed')} value={settings.speed} min={0.7} max={1.3} step={0.05} display={t('tts.speed_value', { value: settings.speed.toFixed(2) })} onChange={(v) => onSet('speed', v)} />
      <RangeField id="pause-sentence" label={t('tts.pause_sentence')} value={settings.pause_sentence_s} min={0} max={3} step={0.05} display={t('tts.seconds', { value: settings.pause_sentence_s.toFixed(2) })} onChange={(v) => onSet('pause_sentence_s', v)} />
      <RangeField id="pause-paragraph" label={t('tts.pause_paragraph')} value={settings.pause_paragraph_s} min={0} max={3} step={0.05} display={t('tts.seconds', { value: settings.pause_paragraph_s.toFixed(2) })} onChange={(v) => onSet('pause_paragraph_s', v)} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-ink">{t('tts.formats')}</legend>
        <div className="grid grid-cols-4 gap-2">
          {FORMATS.map((f) => {
            const on = settings.formats.includes(f);
            return (
              <button
                key={f}
                type="button"
                aria-pressed={on}
                onClick={() => toggleFormat(f)}
                className={`h-10 rounded-control border text-sm font-medium transition-colors duration-150 pointer-coarse:min-h-11 ${on ? 'border-accent bg-accent-soft text-ink' : 'border-line text-muted hover:border-dim hover:text-ink'}`}
              >
                {f.toUpperCase()}
              </button>
            );
          })}
        </div>
        {noFormats ? <p className="text-sm text-danger" role="alert">{t('tts.formats_required')}</p> : null}
      </fieldset>
    </section>
  );
}
