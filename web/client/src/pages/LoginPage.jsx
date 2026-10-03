import { ArrowLeftIcon, ArrowSquareOutIcon, WaveformIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Notice, Segmented, buttonClass, inputClass } from '../components/ui.jsx';
import { LANG_OPTIONS, hasKey, useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { errorText } from '../lib/errors.js';
import { lqstudioOrigin, safeNext } from '../lib/links.js';
import { useSession } from '../lib/session.jsx';

const CODE_PATTERN = /^(\d{6}|[A-Za-z0-9-]{8,16})$/;

export default function LoginPage() {
  const { t, lang, setLang } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [step, setStep] = useState({ kind: 'credentials' });
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [signupUrl, setSignupUrl] = useState(() => `${lqstudioOrigin()}/signup`);

  useEffect(() => {
    let live = true;
    api.health().then(
      (health) => {
        if (live && typeof health?.signupUrl === 'string' && health.signupUrl) setSignupUrl(health.signupUrl);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  if (session.status === 'authed') return <Navigate to={next} replace />;

  const reasonKey =
    session.reason === 'suspended' || session.reason === 'needs_verification' ? `login.reason.${session.reason}` : null;
  const showReason = Boolean(reasonKey) && hasKey(reasonKey) && step.kind === 'credentials';

  const cleanCode = code.replace(/\s+/g, '');
  const identifierMissing = Boolean(touched.identifier) && !identifier.trim();
  const passwordMissing = Boolean(touched.password) && !password;
  const codeInvalid = Boolean(touched.code) && !CODE_PATTERN.test(cleanCode);

  function finish(user) {
    session.signedIn(user);
    navigate(next, { replace: true });
  }

  /** `/auth/login` and `/auth/2fa` share the answer shape; only login can ask for a code. */
  function onResult(result) {
    if (result?.status === 'ok') finish(result.user);
    else if (result?.status === 'need_2fa' && step.kind === 'credentials') {
      setStep({ kind: '2fa', challenge: result.challenge });
      setPassword('');
      setTouched({});
    } else if (result?.status === 'needs_verification') setStep({ kind: 'verify', verifyUrl: result.verifyUrl });
    else setError({ code: 'generic' });
  }

  async function onCredentials(event) {
    event.preventDefault();
    setTouched({ identifier: true, password: true });
    if (!identifier.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      onResult(await api.login(identifier.trim(), password));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function onCode(event) {
    event.preventDefault();
    setTouched({ code: true });
    if (!CODE_PATTERN.test(cleanCode)) return;
    setBusy(true);
    setError(null);
    try {
      onResult(await api.verify2fa(step.challenge, cleanCode));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function back() {
    setStep({ kind: 'credentials' });
    setCode('');
    setError(null);
    setTouched({});
  }

  const heading = (title, body) => (
    <div>
      <h1 className="text-2xl font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );

  return (
    <div className="min-h-[100dvh] bg-bg">
      <header className="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-4 md:px-8">
        <span className="flex items-center gap-2 text-base font-semibold text-ink">
          <WaveformIcon size={22} weight="bold" aria-hidden className="text-accent" />
          LQ TTS
        </span>
        <div>
          <span id="login-lang" className="sr-only">{t('account.language')}</span>
          <Segmented labelledBy="login-lang" value={lang} onChange={setLang} options={LANG_OPTIONS} />
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[420px] px-4 pb-16 pt-[10vh]">
        {showReason ? (
          <div className="mb-6">
            <Notice tone="warning" testId="login-reason">{t(reasonKey)}</Notice>
          </div>
        ) : null}
        {step.kind === 'credentials' ? (
          <form noValidate onSubmit={onCredentials} className="flex flex-col gap-5">
            {heading(t('login.title'), t('login.subtitle'))}
            {error ? <Notice tone="danger" testId="login-error">{errorText(t, error)}</Notice> : null}
            <Field id="identifier" label={t('login.identifier')} error={identifierMissing ? t('login.required') : null}>
              <input
                id="identifier"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                onBlur={() => setTouched((s) => ({ ...s, identifier: true }))}
                aria-invalid={identifierMissing || undefined}
                aria-describedby={identifierMissing ? 'identifier-error' : undefined}
                className={`${inputClass} h-11`}
              />
            </Field>
            <Field id="password" label={t('login.password')} error={passwordMissing ? t('login.required') : null}>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched((s) => ({ ...s, password: true }))}
                aria-invalid={passwordMissing || undefined}
                aria-describedby={passwordMissing ? 'password-error' : undefined}
                className={`${inputClass} h-11`}
              />
            </Field>
            <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
              {busy ? t('login.submitting') : t('login.submit')}
            </Button>
            <p className="text-sm text-muted">
              {t('login.no_account')}{' '}
              <a className="font-medium text-accent underline-offset-4 hover:underline" href={signupUrl} target="_blank" rel="noreferrer">
                {t('login.signup')}
              </a>
            </p>
          </form>
        ) : null}

        {step.kind === '2fa' ? (
          <form noValidate onSubmit={onCode} className="flex flex-col gap-5">
            {heading(t('login.twofa_title'), t('login.twofa_help'))}
            {error ? <Notice tone="danger" testId="login-error">{errorText(t, error)}</Notice> : null}
            <Field id="code" label={t('login.code')} error={codeInvalid ? t('login.code_format') : null}>
              <input
                id="code"
                name="one-time-code"
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={20}
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onBlur={() => setTouched({ code: true })}
                aria-invalid={codeInvalid || undefined}
                aria-describedby={codeInvalid ? 'code-error' : undefined}
                className={`${inputClass} h-12 font-mono text-lg tracking-[0.2em]`}
              />
            </Field>
            <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">{t('login.verify')}</Button>
            <Button variant="ghost" icon={ArrowLeftIcon} onClick={back} className="self-start">{t('login.back')}</Button>
          </form>
        ) : null}

        {step.kind === 'verify' ? (
          <div className="flex flex-col gap-5">
            {heading(t('login.verify_title'), t('login.verify_help'))}
            <a href={step.verifyUrl} target="_blank" rel="noreferrer" className={buttonClass('primary', 'lg', 'w-full')}>
              {t('login.verify_cta')}
              <ArrowSquareOutIcon size={18} aria-hidden />
            </a>
            <Button variant="ghost" icon={ArrowLeftIcon} onClick={back} className="self-start">{t('login.back')}</Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
