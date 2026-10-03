import { PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { useAudioToggle } from '../lib/useAudioToggle.js';

export default function PlayButton({ src, label, testId }) {
  const { playing, toggle } = useAudioToggle(src);
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={!src}
      aria-pressed={playing}
      aria-label={label}
      data-testid={testId}
      className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full border transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:border-line disabled:text-dim pointer-coarse:size-11 ${playing ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface text-ink hover:border-accent'}`}
    >
      {playing ? <PauseIcon size={18} weight="fill" aria-hidden /> : <PlayIcon size={18} weight="fill" aria-hidden />}
    </button>
  );
}
