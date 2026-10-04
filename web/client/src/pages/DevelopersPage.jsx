import { KeyIcon, WaveformIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { Segmented, buttonClass, touchLinkClass } from '../components/ui.jsx';
import { LANG_OPTIONS, useI18n } from '../i18n/index.jsx';
import { BASE_URL, ENDPOINTS, ERRORS, SAMPLES } from '../lib/api-docs.js';

/** [section id, title key]: the page index and the h2 of each section. */
const SECTIONS = [
  ['docs-auth', 'docs.auth_title'],
  ['docs-endpoints', 'docs.endpoints_title'],
  ['docs-create', 'docs.create_title'],
  ['docs-poll', 'docs.poll_title'],
  ['docs-webhooks', 'docs.webhooks_title'],
  ['docs-errors', 'docs.errors_title'],
  ['docs-limits', 'docs.limits_title'],
];

// tabIndex: a block wider than the screen scrolls sideways, so keyboard users must be able to reach it.
function Code({ children }) {
  return (
    <pre tabIndex={0} className="max-w-full overflow-x-auto rounded-control border border-line bg-surface-2 p-4 text-sm leading-relaxed">
      <code className="font-mono text-ink">{children}</code>
    </pre>
  );
}

function Section({ id, title, children }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex min-w-0 scroll-mt-20 flex-col gap-3">
      <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Text({ children }) {
  return <p className="max-w-[70ch] text-sm leading-relaxed text-muted">{children}</p>;
}

function SubTitle({ children }) {
  return <h3 className="pt-2 text-base font-semibold text-ink">{children}</h3>;
}

/** Public developer docs (spec §2.7): no session needed, language switch kept in this browser only. */
export default function DevelopersPage() {
  const { t, lang, setLang } = useI18n();
  const title = Object.fromEntries(SECTIONS.map(([id, key]) => [id, t(key)]));
  const limits = [t('docs.limit.jobs'), t('docs.limit.rate'), t('docs.limit.chars'), t('docs.limit.keys'), t('docs.limit.queue')];
  return (
    <div className="min-h-[100dvh] bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[var(--z-skip)] focus:rounded-control focus:bg-surface focus:px-4 focus:py-2 focus:text-ink">
        {t('nav.skip')}
      </a>
      <header className="sticky top-0 z-[var(--z-sticky)] flex h-14 items-center justify-between gap-4 border-b border-line bg-bg px-4 md:px-8">
        <Link to="/" className={`flex items-center gap-2 text-base font-semibold text-ink ${touchLinkClass}`}>
          <WaveformIcon size={22} weight="bold" aria-hidden className="text-accent" />
          LQ TTS
        </Link>
        <span id="docs-lang" className="sr-only">{t('account.language')}</span>
        <Segmented options={LANG_OPTIONS} value={lang} onChange={setLang} labelledBy="docs-lang" />
      </header>
      <main id="main" className="mx-auto flex w-full max-w-[1120px] flex-col gap-8 px-4 py-8 md:px-8 md:py-12">
        <div className="flex max-w-[70ch] flex-col gap-3">
          <h1 className="text-2xl font-semibold text-balance text-ink md:text-3xl">{t('docs.title')}</h1>
          <Text>{t('docs.intro')}</Text>
          <Text>{t('docs.who')}</Text>
          <Link to="/api-keys" className={`${buttonClass('primary')} self-start`}>
            <KeyIcon size={18} aria-hidden />
            {t('docs.keys_link')}
          </Link>
        </div>

        <div className="grid min-w-0 gap-8 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
          <nav aria-labelledby="docs-index" className="min-w-0 lg:sticky lg:top-20 lg:self-start">
            <p id="docs-index" className="mb-2 text-xs font-medium text-muted">{t('docs.index')}</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm lg:flex-col lg:gap-1">
              {SECTIONS.map(([id]) => (
                <li key={id}>
                  <a href={`#${id}`} className={`text-ink underline-offset-4 hover:text-accent hover:underline ${touchLinkClass}`}>
                    {title[id]}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex min-w-0 flex-col gap-12">
            <Section id="docs-auth" title={title['docs-auth']}>
              <Text>{t('docs.auth_body')}</Text>
              <Code>{SAMPLES.auth}</Code>
              <Text>{t('docs.auth_revoke')}</Text>
            </Section>

            <Section id="docs-endpoints" title={title['docs-endpoints']}>
              <Text>{t('docs.base_url', { url: BASE_URL })}</Text>
              <ul className="flex flex-col divide-y divide-line rounded-panel border border-line bg-surface">
                {ENDPOINTS.map(([method, path, key]) => (
                  <li key={`${method} ${path}`} className="flex flex-col gap-1 px-4 py-3">
                    <p className="flex flex-wrap items-center gap-2 font-mono text-sm text-ink">
                      <span className="rounded-full bg-surface-2 px-2 text-xs font-medium text-muted">{method}</span>
                      <span className="[overflow-wrap:anywhere]">{path}</span>
                    </p>
                    <p className="max-w-[70ch] text-sm text-muted">{t(`docs.endpoint.${key}`)}</p>
                  </li>
                ))}
              </ul>
            </Section>

            <Section id="docs-create" title={title['docs-create']}>
              <Text>{t('docs.create_body')}</Text>
              <Text>{t('docs.idempotency')}</Text>
              <Code>{SAMPLES.create}</Code>
              <Text>{t('docs.answer')}</Text>
              <Code>{SAMPLES.createAnswer}</Code>
            </Section>

            <Section id="docs-poll" title={title['docs-poll']}>
              <Text>{t('docs.poll_body')}</Text>
              <Code>{SAMPLES.poll}</Code>
              <Text>{t('docs.answer')}</Text>
              <Code>{SAMPLES.pollAnswer}</Code>
              <Text>{t('docs.download_body')}</Text>
              <Code>{SAMPLES.download}</Code>
            </Section>

            <Section id="docs-webhooks" title={title['docs-webhooks']}>
              <Text>{t('docs.webhooks_body')}</Text>
              <Text>{t('docs.webhooks_retry')}</Text>
              <Code>{SAMPLES.webhookBody}</Code>
              <Text>{t('docs.signature_body')}</Text>
              <Text>{t('docs.signature_example')}</Text>
              <SubTitle>{t('docs.verify_node')}</SubTitle>
              <Code>{SAMPLES.verifyNode}</Code>
              <SubTitle>{t('docs.verify_python')}</SubTitle>
              <Code>{SAMPLES.verifyPython}</Code>
            </Section>

            <Section id="docs-errors" title={title['docs-errors']}>
              <Text>{t('docs.errors_body')}</Text>
              <ul className="flex flex-col divide-y divide-line rounded-panel border border-line bg-surface">
                {ERRORS.map(([code, status]) => (
                  <li key={code} className="flex flex-col gap-1 px-4 py-3 md:flex-row md:items-baseline md:gap-4">
                    <p className="flex shrink-0 items-baseline gap-2 font-mono text-sm md:w-64">
                      <span className="text-xs text-muted tabular">{status}</span>
                      <code className="[overflow-wrap:anywhere] text-ink">{code}</code>
                    </p>
                    <p className="max-w-[70ch] text-sm text-muted">{t(`docs.error.${code}`)}</p>
                  </li>
                ))}
              </ul>
            </Section>

            <Section id="docs-limits" title={title['docs-limits']}>
              <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted">
                {limits.map((line) => <li key={line} className="max-w-[70ch]">{line}</li>)}
              </ul>
            </Section>
          </div>
        </div>
      </main>
    </div>
  );
}
