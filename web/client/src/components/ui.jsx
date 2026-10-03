import { CaretDownIcon, CheckCircleIcon, CircleNotchIcon, InfoIcon, WarningCircleIcon } from '@phosphor-icons/react';

const VARIANTS = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 disabled:bg-surface-2 disabled:text-dim disabled:hover:brightness-100',
  secondary: 'border border-line bg-surface text-ink hover:border-dim hover:bg-surface-2 disabled:text-dim disabled:hover:border-line disabled:hover:bg-surface',
  ghost: 'text-muted hover:bg-surface-2 hover:text-ink disabled:text-dim disabled:hover:bg-transparent',
  danger: 'border border-danger/40 bg-danger-soft text-danger enabled:hover:border-danger disabled:text-dim',
};
const SIZES = { sm: 'h-9 px-3 text-sm', md: 'h-10 px-4 text-sm', lg: 'h-12 px-5 text-base' };

export function buttonClass(variant = 'secondary', size = 'md', extra = '') {
  return [
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium',
    'transition-[background-color,border-color,color,filter,transform] duration-150 ease-out active:scale-[0.98]',
    'disabled:cursor-not-allowed disabled:active:scale-100 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
    SIZES[size],
    VARIANTS[variant],
    extra,
  ].join(' ');
}

/** Text links keep their desktop look; on touch screens they grow to a 44 px tall hit area (icon-only buttons get 44 px wide via buttonClass). */
export const touchLinkClass = 'pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center';

export function Button({ variant = 'secondary', size = 'md', loading = false, icon: Icon = null, className = '', children, disabled, type = 'button', ...rest }) {
  return (
    <button type={type} {...rest} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)}>
      {loading ? <CircleNotchIcon size={18} className="animate-spin" aria-hidden /> : Icon ? <Icon size={18} aria-hidden /> : null}
      {children}
    </button>
  );
}

export const inputClass = 'block w-full rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-dim transition-colors duration-150 enabled:hover:border-dim focus-visible:border-accent aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:text-dim';

export function Field({ id, label, help = null, error = null, children, className = '' }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-sm text-danger">
          <WarningCircleIcon size={16} className="mt-0.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="max-w-[65ch] text-sm leading-relaxed text-dim">{help}</p>
      ) : null}
    </div>
  );
}

export function Select({ id, value, onChange, children, className = '', ...rest }) {
  return (
    <div className={`relative ${className}`}>
      <select id={id} value={value} onChange={onChange} {...rest} className={`${inputClass} h-11 cursor-pointer appearance-none pr-10`}>
        {children}
      </select>
      <CaretDownIcon size={16} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </div>
  );
}

const TONES = {
  info: ['bg-surface-2', InfoIcon, 'text-muted'],
  success: ['bg-success-soft', CheckCircleIcon, 'text-success'],
  warning: ['bg-warning-soft', WarningCircleIcon, 'text-warning'],
  danger: ['bg-danger-soft', WarningCircleIcon, 'text-danger'],
};

export function Notice({ tone = 'info', children, action = null, testId }) {
  const [box, Icon, iconColor] = TONES[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} data-testid={testId} className={`flex flex-wrap items-start gap-3 rounded-control px-4 py-3 text-sm text-ink ${box}`}>
      <Icon size={18} aria-hidden className={`mt-0.5 shrink-0 ${iconColor}`} />
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className = '' }) {
  return <div data-skeleton aria-hidden className={`animate-skeleton rounded-control bg-surface-2 ${className}`} />;
}

export function EmptyState({ icon: Icon = null, title, body, action = null }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-panel border border-dashed border-line px-6 py-8">
      {Icon ? <Icon size={28} aria-hidden className="text-accent" /> : null}
      <div>
        <p className="text-lg font-semibold text-ink">{title}</p>
        <p className="mt-1 max-w-[56ch] text-sm leading-relaxed text-muted">{body}</p>
      </div>
      {action}
    </div>
  );
}

const CHIPS = {
  neutral: 'bg-surface-2 text-muted',
  progress: 'bg-accent-soft text-ink',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

export function StatusChip({ tone = 'neutral', icon: Icon = null, spinning = false, children, testId, status }) {
  return (
    <span data-testid={testId} data-status={status} className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium ${CHIPS[tone]}`}>
      {Icon ? <Icon size={14} aria-hidden className={spinning ? 'animate-spin' : ''} /> : null}
      {children}
    </span>
  );
}

export function PageHeader({ title, subtitle = null, actions = null }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Segmented({ options, value, onChange, labelledBy }) {
  function onKeyDown(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const step = event.key === 'ArrowRight' ? 1 : options.length - 1;
    const next = options[(index + step) % options.length];
    onChange(next.value);
    event.currentTarget.parentElement?.querySelector(`[data-value="${next.value}"]`)?.focus();
  }
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="inline-flex rounded-control border border-line bg-surface-2 p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            tabIndex={on ? 0 : -1}
            data-value={o.value}
            onKeyDown={onKeyDown}
            onClick={() => onChange(o.value)}
            className={`h-8 min-w-14 rounded-[6px] px-3 text-sm font-medium transition-colors duration-150 active:scale-[0.98] motion-reduce:active:scale-100 pointer-coarse:min-h-11 ${on ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)]' : 'text-muted hover:text-ink'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
