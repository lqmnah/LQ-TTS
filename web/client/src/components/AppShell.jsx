import { ClockCounterClockwiseIcon, CodeIcon, CoinsIcon, TextAaIcon, UserSoundIcon, WaveformIcon } from '@phosphor-icons/react';
import { Link, NavLink, Outlet, useMatch } from 'react-router';
import { useI18n } from '../i18n/index.jsx';
import { useHealth } from '../lib/useHealth.js';
import AccountMenu from './AccountMenu.jsx';
import EngineBanner from './EngineBanner.jsx';

const NAV = [
  { to: '/', key: 'nav.tts', icon: TextAaIcon, end: true },
  { to: '/voices', key: 'nav.voices', icon: UserSoundIcon },
  { to: '/history', key: 'nav.history', icon: ClockCounterClockwiseIcon },
  { to: '/credits', key: 'nav.credits', icon: CoinsIcon },
  { to: '/api-keys', key: 'nav.api', icon: CodeIcon },
];

function Brand({ rail = false }) {
  return (
    <Link to="/" className={`flex h-14 items-center gap-2 px-5 text-base font-semibold text-ink ${rail ? 'md:justify-center md:px-0 lg:justify-start lg:px-5' : ''}`}>
      <WaveformIcon size={22} weight="bold" aria-hidden className="text-accent" />
      <span className={rail ? 'md:sr-only lg:not-sr-only' : ''}>LQ TTS</span>
    </Link>
  );
}

export default function AppShell() {
  const { t } = useI18n();
  const health = useHealth();
  const onJob = useMatch('/jobs/:id');
  const active = (item, isActive) => isActive || (item.to === '/' && Boolean(onJob));

  return (
    <div className="min-h-[100dvh] md:grid md:grid-cols-[72px_minmax(0,1fr)] lg:grid-cols-[232px_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[var(--z-skip)] focus:rounded-control focus:bg-surface focus:px-4 focus:py-2 focus:text-ink">
        {t('nav.skip')}
      </a>
      <aside data-testid="sidebar" className="sticky top-0 hidden h-[100dvh] flex-col border-r border-line bg-surface md:flex">
        <Brand rail />
        <nav aria-label={t('nav.label')} className="flex flex-col gap-1 px-3 py-4">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={t(item.key)}
              className={({ isActive }) => `flex h-11 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors duration-150 active:scale-[0.98] motion-reduce:active:scale-100 md:justify-center lg:justify-start ${active(item, isActive) ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-surface-2 hover:text-ink'}`}
            >
              {({ isActive }) => (
                <>
                  <item.icon size={20} weight={active(item, isActive) ? 'fill' : 'regular'} aria-hidden className={active(item, isActive) ? 'shrink-0 text-accent' : 'shrink-0'} />
                  <span className="md:sr-only lg:not-sr-only">{t(item.key)}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col pb-[calc(64px+env(safe-area-inset-bottom))] md:pb-0">
        <header className="sticky top-0 z-[var(--z-sticky)] flex h-14 items-center justify-between gap-4 border-b border-line bg-bg px-4 md:justify-end md:px-8">
          <div className="-ml-5 md:hidden"><Brand /></div>
          <AccountMenu />
        </header>
        <EngineBanner health={health} />
        <main id="main" className="mx-auto w-full max-w-[1120px] flex-1 px-4 py-6 md:px-8 md:py-8">
          <Outlet context={{ health }} />
        </main>
      </div>

      {/* 63 px tabs + 1 px top border = the 64 px the content reserves for this bar. */}
      <nav aria-label={t('nav.label')} data-testid="bottom-nav" className="fixed inset-x-0 bottom-0 z-[var(--z-sticky)] grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `flex h-[63px] min-w-0 flex-col items-center justify-start gap-1 px-1 pt-2 text-xs font-medium transition-colors duration-150 active:scale-[0.98] motion-reduce:active:scale-100 ${active(item, isActive) ? 'text-ink' : 'text-muted'}`}
          >
            {({ isActive }) => (
              <>
                <item.icon size={22} weight={active(item, isActive) ? 'fill' : 'regular'} aria-hidden className={active(item, isActive) ? 'text-accent' : ''} />
                {/* Top-aligned so every icon shares one line when a label wraps; 8 + 22 + 4 + 2 x 14 px fits the 63 px tab. */}
                <span className="text-center leading-[14px]">{t(item.key)}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
