import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from './en.js';
import id from './id.js';
import { translate, translateCount } from './index.jsx';

const SRC = join(import.meta.dirname, '..');
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'i18n' || name === 'test' ? [] : sourceFiles(path);
    return /\.(js|jsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const C2_ERROR_CODES = ['unauthorized', 'invalid_request', 'invalid_credentials', 'invalid_code', 'rate_limited', 'suspended',
  'needs_verification', 'lqstudio_unavailable', 'engine_unavailable', 'insufficient_credits', 'voice_limit_reached',
  'consent_required', 'not_found', 'too_large', 'unsupported_audio', 'not_regeneratable', 'voice_not_ready', 'internal_error',
  'plan_required', 'key_limit_reached'];

const DYNAMIC_FAMILIES = {
  plan: ['free', 'pro', 'ultra', 'sultan'],
  error: [...C2_ERROR_CODES, 'network', 'generic', 'rate_limited_later'],
  'job.status': ['queued', 'running', 'done', 'failed', 'canceled'],
  'job.failed': ['synthesis_failed', 'worker_crashed', 'internal_error', 'canceled', 'unknown', 'change_failed', 'change_canceled'],
  'job.sentence.status': ['pending', 'running', 'done', 'needs_review'],
  'voices.status': ['processing', 'ready', 'failed'],
  'voices.language': ['auto', 'id', 'en'],
  'voices.error': ['no_clean_speech', 'unsupported_audio', 'internal_error', 'unknown'],
  'credits.kind': ['job', 'regenerate'],
  'credits.state': ['held', 'settled', 'refunded'],
  'api.delivery': ['delivered', 'pending', 'dropped'],
  'docs.endpoint': ['voices', 'estimate', 'create', 'get', 'file', 'delete'],
  'docs.error': ['invalid_request', 'invalid_webhook_url', 'unauthorized', 'insufficient_credits', 'plan_required', 'suspended',
    'needs_verification', 'not_found', 'voice_not_ready', 'idempotency_conflict', 'busy', 'too_large', 'too_many_jobs', 'rate_limited',
    'internal_error', 'lqstudio_unavailable', 'engine_unavailable'],
};

describe('dictionaries', () => {
  it('ID and EN define exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(id).sort());
  });

  it('have no empty strings, no em dash and no emoji', () => {
    for (const [lang, dict] of Object.entries({ id, en })) {
      for (const [key, value] of Object.entries(dict)) {
        expect(typeof value, `${lang}.${key}`).toBe('string');
        expect(value.trim(), `${lang}.${key} empty`).not.toBe('');
        expect(value.includes('—'), `${lang}.${key} has an em dash`).toBe(false);
        expect(/\p{Extended_Pictographic}/u.test(value), `${lang}.${key} has an emoji`).toBe(false);
      }
    }
  });

  it('use the same placeholders in both languages', () => {
    for (const key of Object.keys(id)) {
      expect(placeholders(en[key]), key).toEqual(placeholders(id[key]));
    }
  });

  it('pair every _one key with an _other key', () => {
    for (const key of Object.keys(id).filter((k) => k.endsWith('_one'))) {
      expect(Object.hasOwn(id, key.replace(/_one$/, '_other')), key).toBe(true);
    }
  });

  it('cover every runtime-built key family', () => {
    for (const [prefix, names] of Object.entries(DYNAMIC_FAMILIES)) {
      for (const name of names) expect(Object.hasOwn(id, `${prefix}.${name}`), `${prefix}.${name}`).toBe(true);
    }
  });

  it('define every literal key the source code uses', () => {
    const missing = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'([a-z0-9_.]+)'/g)) if (!Object.hasOwn(id, m[1])) missing.push(`${file}: ${m[1]}`);
      for (const m of text.matchAll(/\btn\(\s*'([a-z0-9_.]+)'/g)) if (!Object.hasOwn(id, `${m[1]}_other`)) missing.push(`${file}: ${m[1]}_other`);
    }
    expect(missing).toEqual([]);
  });
});

describe('translate', () => {
  it('interpolates variables and leaves unknown ones visible', () => {
    expect(translate('en', 'voices.usage', { count: 2, limit: 3 })).toBe('2 of 3 voices used');
    expect(translate('en', 'voices.usage', { count: 2 })).toBe('2 of {limit} voices used');
  });
  it('does not treat {{style: ...}} markup as a placeholder', () => {
    expect(translate('en', 'tts.script_help')).toContain('{{style: cheerful, slightly faster}}');
  });
  it('falls back to Indonesian, then to the key', () => {
    expect(translate('xx', 'nav.voices')).toBe('Suara');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });
  it('chooses singular and plural forms', () => {
    expect(translateCount('en', 'tts.price', 1, { credits: '1', rupiah: '100' })).toBe('About 1 credit (Rp100)');
    expect(translateCount('en', 'tts.price', 2, { credits: '2', rupiah: '200' })).toBe('About 2 credits (Rp200)');
    expect(translateCount('id', 'tts.price', 2, { credits: '2', rupiah: '200' })).toBe('Sekitar 2 kredit (Rp200)');
  });
});
