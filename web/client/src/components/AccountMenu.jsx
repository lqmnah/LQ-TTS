import { CaretDownIcon, SignOutIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { LANG_OPTIONS, hasKey, useI18n } from '../i18n/index.jsx';
import { useSession } from '../lib/session.jsx';
import { Button, Segmented } from './ui.jsx';

export default function AccountMenu() {
  const { t, lang } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [langError, setLangError] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    panelRef.current?.querySelector('[role="radio"][aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const me = session.me;
  if (!me) return null;
  const planName = hasKey(`plan.${me.plan}`) ? t(`plan.${me.plan}`) : me.plan;

  async function pickLang(next) {
    if (next === lang) return;
    setLangError(false);
    try {
      await session.changeLang(next);
    } catch {
      setLangError(true);
    }
  }

  async function logout() {
    await session.logout();
    navigate('/login', { replace: true });
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="account-button"
        aria-label={t('account.menu')}
        aria-expanded={open}
        aria-controls="account-panel"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 max-w-[14rem] items-center gap-2 rounded-control px-3 text-sm font-medium text-ink transition-colors duration-150 hover:bg-surface-2 pointer-coarse:min-h-11"
      >
        <span className="truncate">{me.name}</span>
        <CaretDownIcon size={16} aria-hidden className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div id="account-panel" ref={panelRef} className="animate-pop absolute right-0 top-12 z-[var(--z-popover)] w-72 rounded-panel border border-line bg-surface p-4 shadow-[var(--shadow-pop)]">
          <p className="truncate text-sm font-semibold text-ink">{me.name}</p>
          <p className="truncate text-sm text-muted">{me.email}</p>
          <p className="mt-1 text-xs text-dim">{t('account.plan', { plan: planName })}</p>
          <div className="mt-4">
            <p id="account-lang" className="mb-2 text-xs font-medium text-muted">{t('account.language')}</p>
            <Segmented labelledBy="account-lang" value={lang} onChange={pickLang} options={LANG_OPTIONS} />
            {langError ? <p className="mt-2 text-xs text-danger" role="alert">{t('account.lang_error')}</p> : null}
          </div>
          <Button className="mt-4 w-full" icon={SignOutIcon} onClick={logout} data-testid="logout">{t('account.logout')}</Button>
        </div>
      ) : null}
    </div>
  );
}
