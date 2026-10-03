import { Link } from 'react-router';
import { useI18n } from '../i18n/index.jsx';
import { errorText } from '../lib/errors.js';
import PlayButton from './PlayButton.jsx';
import { VoiceStatus } from './status.jsx';
import { Button, Notice, Skeleton, StatusChip, buttonClass } from './ui.jsx';

const localized = (pair, lang) => pair?.[lang] ?? pair?.id ?? '';

function Heading() {
  const { t } = useI18n();
  return (
    <div>
      <h2 id="profiles-heading" className="text-lg font-semibold text-ink">{t('profiles.title')}</h2>
      <p className="mt-1 max-w-[65ch] text-sm leading-relaxed text-muted">{t('profiles.subtitle')}</p>
    </div>
  );
}

/** Voices page section (spec §3): one card per profile; failed profiles are hidden, no delete control. */
export function ProfileSection({ profiles }) {
  const { t } = useI18n();
  if (profiles.data === undefined && !profiles.error) return <Skeleton className="h-[220px]" />;
  if (profiles.data === undefined) {
    return (
      <section aria-labelledby="profiles-heading" className="flex flex-col gap-4">
        <Heading />
        <Notice tone="danger" action={<Button size="sm" onClick={profiles.reload}>{t('common.retry')}</Button>}>{errorText(t, profiles.error)}</Notice>
      </section>
    );
  }
  const shown = profiles.data.filter((p) => p.status !== 'failed');
  if (!shown.length) return null;
  return (
    <section aria-labelledby="profiles-heading" className="flex flex-col gap-4">
      <Heading />
      <ul className="grid gap-3 lg:grid-cols-2">
        {shown.map((p) => <ProfileCard key={p.id} profile={p} />)}
      </ul>
    </section>
  );
}

function ProfileCard({ profile }) {
  const { t, lang } = useI18n();
  const ready = profile.status === 'ready';
  const nameId = `profile-name-${profile.id}`;
  return (
    <li data-testid="profile-card" data-status={profile.status ?? 'unknown'} className="flex flex-col gap-4 rounded-panel border border-line bg-surface p-4 md:p-5">
      <div className="flex items-start gap-3">
        <PlayButton src={ready ? profile.previewUrl : null} label={t('voices.preview', { name: profile.name })} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span id={nameId} className="text-base font-semibold text-ink">{profile.name}</span>
            {profile.status === 'processing' ? <VoiceStatus status="processing" /> : null}
          </p>
          <p className="mt-1 max-w-[65ch] text-sm leading-relaxed text-muted">{localized(profile.description, lang)}</p>
          {profile.status === null ? <p className="mt-1 text-sm text-dim">{t('profiles.status_unknown')}</p> : null}
        </div>
      </div>
      <ul aria-label={t('profiles.tags')} className="flex flex-wrap gap-1.5">
        {profile.tags.map((tag) => <li key={`${tag.id}|${tag.en}`}><StatusChip>{localized(tag, lang)}</StatusChip></li>)}
      </ul>
      <div className="text-sm leading-relaxed">
        <p className="font-medium text-ink">{t('profiles.best_for')}</p>
        <p className="text-muted">{localized(profile.bestFor, lang)}</p>
      </div>
      <div>
        {ready
          ? <Link to={`/?voice=${encodeURIComponent(profile.id)}`} aria-label={t('profiles.use_named', { name: profile.name })} className={buttonClass('secondary', 'sm')}>{t('profiles.use')}</Link>
          : <Button size="sm" disabled aria-label={t('profiles.use_named', { name: profile.name })}>{t('profiles.use')}</Button>}
      </div>
    </li>
  );
}
