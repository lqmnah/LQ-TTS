import { ArrowSquareOutIcon, BookOpenTextIcon, CheckIcon, CopyIcon, KeyIcon, TrashIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button, EmptyState, Field, Notice, PageHeader, Skeleton, StatusChip, buttonClass, inputClass, touchLinkClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { errorText } from '../lib/errors.js';
import { formatDateTime } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { useResource } from '../lib/useResource.js';

const MAX_NAME = 60;
const MAX_KEYS = 5;
const COPIED_MS = 2000;
const DELIVERY_TONE = { delivered: 'success', pending: 'progress', dropped: 'danger' };
/** The listed shape of a key: the full key and the webhook secret never enter the list. */
const listed = ({ id, name, prefix, createdAt, lastUsedAt }) => ({ id, name, prefix, createdAt, lastUsedAt });

export default function ApiPage() {
  const { t } = useI18n();
  const { me } = useSession();
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t('api.title')}
        subtitle={t('api.subtitle')}
        actions={(
          <Link to="/developers" className={buttonClass('secondary')}>
            <BookOpenTextIcon size={18} aria-hidden />
            {t('api.docs_link')}
          </Link>
        )}
      />
      {me?.paid ? <ApiKeys /> : (
        <Notice
          testId="api-upgrade"
          action={(
            <a href={me?.topupUrl} target="_blank" rel="noreferrer" className={buttonClass('primary', 'sm')}>
              {t('api.upgrade_cta')}
              <ArrowSquareOutIcon size={16} aria-hidden />
            </a>
          )}
        >
          {t('api.upgrade_body')}
        </Notice>
      )}
    </div>
  );
}

function ApiKeys() {
  const { t } = useI18n();
  const data = useResource(() => api.apiKeys(), []);
  const [created, setCreated] = useState(null);
  const keysHeadingRef = useRef(null);

  if (data.data === undefined && !data.error) return <Skeleton className="h-40" />;
  if (data.data === undefined) {
    return <Notice tone="danger" action={<Button size="sm" loading={data.loading} onClick={data.reload}>{t('common.retry')}</Button>}>{errorText(t, data.error)}</Notice>;
  }
  const { keys, deliveries } = data.data;
  const removeKey = (id) => {
    data.setData((d) => ({ ...d, keys: d.keys.filter((k) => k.id !== id), deliveries: d.deliveries.filter((x) => x.keyId !== id) }));
    // The revoked row and its confirm leave the page; focus lands on the list heading, not on <body>.
    keysHeadingRef.current?.focus();
  };
  const addKey = (made) => {
    setCreated(made);
    data.setData((d) => ({ ...d, keys: [listed(made), ...d.keys] }));
  };
  const closePanel = () => {
    setCreated(null);
    keysHeadingRef.current?.focus();
  };

  return (
    <>
      {created ? <NewKeyPanel created={created} onDone={closePanel} /> : null}
      <section aria-labelledby="keys-heading" className="flex flex-col gap-3">
        <h2 ref={keysHeadingRef} id="keys-heading" tabIndex={-1} className="text-lg font-semibold text-ink outline-none">{t('api.keys_title')}</h2>
        {keys.length === 0 ? (
          <EmptyState icon={KeyIcon} title={t('api.empty_title')} body={t('api.empty_body')} />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-surface">
            {keys.map((key) => <KeyRow key={key.id} apiKey={key} onRevoked={() => removeKey(key.id)} />)}
          </ul>
        )}
        <CreateKey full={keys.length >= MAX_KEYS} onCreated={addKey} />
      </section>
      <Deliveries deliveries={deliveries} />
    </>
  );
}

function CreateKey({ full, onCreated }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError({ code: 'name_required' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createApiKey(trimmed));
      setName('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const message = error ? (error.code === 'name_required' ? t('api.name_required') : errorText(t, error)) : null;
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-5 md:flex-row md:items-start">
      <Field id="api-key-name" label={t('api.name_label')} help={full ? t('api.limit_reached') : t('api.name_help')} error={message} className="min-w-0 flex-1">
        <input
          id="api-key-name"
          value={name}
          maxLength={MAX_NAME}
          autoComplete="off"
          disabled={full || busy}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={message ? 'true' : undefined}
          aria-describedby={message ? 'api-key-name-error' : 'api-key-name-help'}
          className={`${inputClass} h-11`}
        />
      </Field>
      <Button type="submit" variant="primary" icon={KeyIcon} loading={busy} disabled={full} className="md:mt-7">{t('api.create')}</Button>
    </form>
  );
}

function NewKeyPanel({ created, onDone }) {
  const { t } = useI18n();
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <section ref={ref} tabIndex={-1} aria-labelledby="new-key-heading" aria-describedby="new-key-body" data-testid="new-key-panel" className="flex flex-col gap-4 rounded-panel border border-accent bg-accent-soft p-5 outline-none">
      <div>
        <h2 id="new-key-heading" className="text-lg font-semibold text-ink [overflow-wrap:anywhere]">{t('api.new_title', { name: created.name })}</h2>
        <p id="new-key-body" className="mt-1 max-w-[65ch] text-sm leading-relaxed text-ink">{t('api.new_body')}</p>
      </div>
      <SecretRow label={t('api.new_key')} value={created.key} testId="new-key-value" />
      <SecretRow label={t('api.new_webhook_secret')} value={created.webhookSecret} testId="new-webhook-secret" />
      <Button variant="primary" className="self-start" onClick={onDone}>{t('api.new_done')}</Button>
    </section>
  );
}

function SecretRow({ label, value, testId }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-ink">{label}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code data-testid={testId} className="min-w-0 flex-1 select-all rounded-control border border-line bg-surface px-3 py-2 font-mono text-sm text-ink [overflow-wrap:anywhere]">{value}</code>
        <Button size="sm" icon={copied ? CheckIcon : CopyIcon} onClick={copy} aria-label={t('api.copy_named', { label })} className="self-start sm:self-auto">
          {copied ? t('api.copied') : t('api.copy')}
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">{copied ? t('api.copied') : ''}</span>
      {failed ? <p role="alert" className="text-sm text-danger">{t('api.copy_failed')}</p> : null}
    </div>
  );
}

function KeyRow({ apiKey, onRevoked }) {
  const { t, lang } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const triggerRef = useRef(null);
  const confirmRef = useRef(null);
  const wasConfirming = useRef(false);
  const promptId = `key-revoke-${apiKey.id}`;
  const confirmId = `key-revoke-confirm-${apiKey.id}`;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await api.revokeApiKey(apiKey.id);
      onRevoked();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const used = apiKey.lastUsedAt ? t('api.last_used', { date: formatDateTime(apiKey.lastUsedAt, lang) }) : t('api.never_used');
  return (
    <li data-testid="api-key-row" data-key-id={apiKey.id} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink [overflow-wrap:anywhere]">{apiKey.name}</p>
          <p className="mt-0.5 font-mono text-xs text-muted [overflow-wrap:anywhere]">{apiKey.prefix}</p>
          <p className="mt-1 text-xs text-muted">{t('api.created_at', { date: formatDateTime(apiKey.createdAt, lang) })} · {used}</p>
        </div>
        <Button ref={triggerRef} variant="ghost" size="sm" icon={TrashIcon} aria-expanded={confirming} aria-controls={confirming ? confirmId : undefined} onClick={() => setConfirming(true)} aria-label={t('api.revoke_named', { name: apiKey.name })}>
          <span className="hidden md:inline">{t('api.revoke')}</span>
        </Button>
      </div>
      {error ? <p role="alert" className="text-xs text-danger">{errorText(t, error)}</p> : null}
      {confirming ? (
        <div id={confirmId} data-testid="api-key-confirm" className="flex flex-col gap-3 rounded-control bg-danger-soft p-3 lg:flex-row lg:items-center lg:justify-between">
          <p id={promptId} role="alert" className="text-sm text-ink">{t('api.revoke_confirm')}</p>
          <div className="flex flex-wrap gap-2 lg:shrink-0">
            <Button ref={confirmRef} variant="danger" size="sm" loading={busy} aria-describedby={promptId} onClick={revoke}>{t('api.revoke')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Deliveries({ deliveries }) {
  const { t, lang } = useI18n();
  return (
    <section aria-labelledby="deliveries-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="deliveries-heading" className="text-lg font-semibold text-ink">{t('api.deliveries_title')}</h2>
        <p className="mt-1 text-sm text-muted">{t('api.deliveries_help')}</p>
      </div>
      {deliveries.length === 0 ? (
        <p className="text-sm text-muted">{t('api.deliveries_empty')}</p>
      ) : (
        <div className="overflow-hidden rounded-panel border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th scope="col" className="hidden whitespace-nowrap px-4 py-3 font-medium md:table-cell">{t('api.col.time')}</th>
                {/* Event names are short; the key name gets the spare width once it has its own column. */}
                <th scope="col" className="w-full px-4 py-3 font-medium lg:w-auto">{t('api.col.event')}</th>
                <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell lg:w-full">{t('api.col.key')}</th>
                <th scope="col" className="hidden whitespace-nowrap px-4 py-3 text-right font-medium md:table-cell">{t('api.col.attempts')}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t('api.col.state')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {deliveries.map((d) => {
                const state = DELIVERY_TONE[d.state] ? d.state : 'pending';
                return (
                  <tr key={d.id} data-testid="delivery-row" data-state={d.state} className="align-top">
                    <td className="hidden whitespace-nowrap px-4 py-3 text-muted md:table-cell">{formatDateTime(d.createdAt, lang)}</td>
                    <td className="px-4 py-3">
                      <Link to={`/jobs/${d.jobId}`} className={`whitespace-nowrap font-mono text-ink transition-colors duration-150 hover:text-accent ${touchLinkClass}`}>{d.event}</Link>
                      <p className="mt-0.5 text-xs text-muted md:hidden">{formatDateTime(d.createdAt, lang)}</p>
                      <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere] lg:hidden">{d.keyName}</p>
                    </td>
                    <td className="hidden px-4 py-3 text-muted [overflow-wrap:anywhere] lg:table-cell">{d.keyName}</td>
                    <td className="hidden whitespace-nowrap px-4 py-3 text-right font-mono tabular md:table-cell">{d.attempts}{d.lastStatus ? ` · HTTP ${d.lastStatus}` : ''}</td>
                    <td className="whitespace-nowrap px-4 py-3"><StatusChip tone={DELIVERY_TONE[state]} status={state}>{t(`api.delivery.${state}`)}</StatusChip></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
