import { WarningCircleIcon } from '@phosphor-icons/react';
import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useI18n } from '../i18n/index.jsx';
import { errorText } from '../lib/errors.js';
import { useSession } from '../lib/session.jsx';
import { Button, Skeleton } from './ui.jsx';

function ShellSkeleton() {
  return (
    <div className="min-h-[100dvh] md:grid md:grid-cols-[72px_minmax(0,1fr)] lg:grid-cols-[232px_minmax(0,1fr)]" aria-busy="true">
      <div className="hidden border-r border-line bg-surface md:block" />
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-4 px-4 py-20 md:px-8">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}

export default function RequireSession({ children }) {
  const session = useSession();
  const location = useLocation();
  const { t } = useI18n();
  const { status, refresh } = session;

  useEffect(() => {
    if (status === 'unknown') refresh();
  }, [status, refresh]);

  if (status === 'authed') return children;
  if (status === 'anon') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (status === 'error') {
    return (
      <main id="main" className="mx-auto flex min-h-[100dvh] max-w-[480px] flex-col justify-center gap-4 px-4">
        <WarningCircleIcon size={28} aria-hidden className="text-danger" />
        <h1 className="text-2xl font-semibold text-ink">{t('shell.error_title')}</h1>
        <p className="text-sm leading-relaxed text-muted">{errorText(t, session.error)}</p>
        <Button variant="primary" className="self-start" onClick={refresh}>{t('common.retry')}</Button>
      </main>
    );
  }
  return <ShellSkeleton />;
}
