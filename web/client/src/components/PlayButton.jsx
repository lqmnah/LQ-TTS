import { PauseIcon, PlayIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useI18n } from '../i18n/index.jsx';
import { useAudioToggle } from '../lib/useAudioToggle.js';

/** Round play/pause button look, shared by every place that plays a clip. */
export function playButtonClass({ playing = false, error = false } = {}) {
  const tone = playing
    ? 'border-accent bg-accent text-accent-ink'
    : error
      ? 'border-danger/60 bg-danger-soft text-danger hover:border-danger'
      : 'border-line bg-surface text-ink hover:border-accent';
  return `inline-flex size-10 shrink-0 items-center justify-center rounded-full border transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:border-line disabled:text-dim pointer-coarse:size-11 ${tone}`;
}

export default function PlayButton({ src, label, testId }) {
  const { t } = useI18n();
  const { playing, error, toggle } = useAudioToggle(src);
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={!src}
      aria-pressed={playing}
      aria-label={label}
      title={error ? t('voices.preview_failed') : undefined}
      aria-description={error ? t('voices.preview_failed') : undefined}
      data-error={error || undefined}
      data-testid={testId}
      className={playButtonClass({ playing, error })}
    >
      {playing ? <PauseIcon size={18} weight="fill" aria-hidden /> : error ? <WarningCircleIcon size={18} weight="bold" aria-hidden /> : <PlayIcon size={18} weight="fill" aria-hidden />}
    </button>
  );
}
