import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { ApiError, api, onUnauthorized } from './api.js';

const SessionContext = createContext(null);
/** Codes after which the server has revoked the session; LoginPage shows `login.reason.<code>`. */
const SESSION_ENDED = new Set(['unauthorized', 'suspended', 'needs_verification']);

/** @param {string|null} reason code that ended the session, null for a plain sign-out */
const anon = (reason = null) => ({ status: 'anon', me: null, error: null, reason });

export function SessionProvider({ children, initial }) {
  const { setLang } = useI18n();
  const [state, setState] = useState(() => ({ reason: null, ...(initial ?? { status: 'unknown', me: null, error: null }) }));

  const refresh = useCallback(async () => {
    setState((s) => (s.status === 'authed' ? s : { ...s, status: 'loading' }));
    try {
      const me = await api.me();
      setState({ status: 'authed', me, error: null, reason: null });
      setLang(me.lang);
      return me;
    } catch (error) {
      if (error instanceof ApiError && SESSION_ENDED.has(error.code)) setState(anon(error.code));
      else setState((s) => (s.status === 'authed' ? s : { status: 'error', me: null, error, reason: null }));
      return null;
    }
  }, [setLang]);

  useEffect(() => onUnauthorized((err) => setState(anon(err.code))), []);

  const signedIn = useCallback((me) => {
    setState({ status: 'authed', me, error: null, reason: null });
    setLang(me.lang);
  }, [setLang]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // The local session is dropped either way; the server row expires on its own.
    }
    setState(anon());
  }, []);

  const changeLang = useCallback(async (lang) => {
    setLang(lang);
    const me = await api.setLang(lang);
    setState({ status: 'authed', me, error: null, reason: null });
  }, [setLang]);

  const value = useMemo(
    () => ({ ...state, refresh, signedIn, logout, changeLang }),
    [state, refresh, signedIn, logout, changeLang],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * @returns {{status:'unknown'|'loading'|'authed'|'anon'|'error', me:any, error:any, reason:string|null,
 *   refresh():Promise<any>, signedIn(me:any):void, logout():Promise<void>, changeLang(lang:string):Promise<void>}}
 */
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
