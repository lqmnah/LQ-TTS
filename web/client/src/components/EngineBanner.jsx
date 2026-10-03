import { WarningCircleIcon } from '@phosphor-icons/react';
import { useI18n } from '../i18n/index.jsx';

export default function EngineBanner({ health }) {
  const { t } = useI18n();
  if (!health) return null;
  const lines = [];
  if (health.engine === 'restarting') lines.push(['engine', t('banner.engine_restarting')]);
  if (health.lqstudio === 'down') lines.push(['lqstudio', t('banner.lqstudio_down')]);
  if (!lines.length) return null;
  return (
    <div role="status" data-testid="health-banner" className="border-b border-line bg-warning-soft px-4 py-3 md:px-8">
      {lines.map(([key, text]) => (
        <p key={key} className="mx-auto flex max-w-[1120px] items-start gap-2 text-sm text-ink">
          <WarningCircleIcon size={18} aria-hidden className="mt-0.5 shrink-0 text-warning" />
          {text}
        </p>
      ))}
    </div>
  );
}
