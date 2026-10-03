import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './en.js';
import id from './id.js';

export const DICTS = { id, en };
export const LANG_OPTIONS = [
  { value: 'id', label: 'ID', ariaLabel: 'Bahasa Indonesia' },
  { value: 'en', label: 'EN', ariaLabel: 'English' },
];
const STORAGE_KEY = 'lqtts_lang';

export function hasKey(key) {
  return Object.hasOwn(DICTS.id, key);
}

export function translate(lang, key, vars) {
  const dict = DICTS[lang] ?? DICTS.id;
  const template = dict[key] ?? DICTS.id[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
}

export function translateCount(lang, key, count, vars = {}) {
  const variant = count === 1 && hasKey(`${key}_one`) ? `${key}_one` : `${key}_other`;
  return translate(lang, variant, { count, ...vars });
}

function storedLang() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'id' || value === 'en' ? value : null;
  } catch {
    return null;
  }
}

const I18nContext = createContext(null);

export function I18nProvider({ children, initialLang }) {
  const [lang, setLangState] = useState(() => initialLang ?? storedLang() ?? 'id');

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next) => {
    if (next !== 'id' && next !== 'en') return;
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode: the choice still lives in memory and on the server session.
    }
  }, []);

  const value = useMemo(() => ({
    lang,
    setLang,
    t: (key, vars) => translate(lang, key, vars),
    tn: (key, count, vars) => translateCount(lang, key, count, vars),
  }), [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
