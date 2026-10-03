const SLUG = /^[a-z0-9-]{1,40}$/;
const TOP_KEYS = ['slug', 'name', 'gender', 'language', 'description', 'tags', 'bestFor', 'consent', 'sort'];
const GENDERS = ['male', 'female', 'neutral'];
const LANGUAGES = ['id', 'en'];
const EM_DASH = '\u2014';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function onlyKeys(value, keys, field) {
  const unknown = Object.keys(value).filter((k) => !keys.includes(k));
  if (unknown.length) throw new Error(`unknown ${field} keys: ${unknown.join(', ')}`);
}

function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} must be at most ${max} characters`);
  if (trimmed.includes(EM_DASH)) throw new Error(`${field} must not contain an em dash`);
  return trimmed;
}

function bilingual(value, field, max) {
  if (!isObject(value)) throw new Error(`${field} must be an object {id, en}`);
  onlyKeys(value, ['id', 'en'], field);
  return { id: text(value.id, `${field}.id`, max), en: text(value.en, `${field}.en`, max) };
}

/** Checks a profile metadata file (shape of server/cli/profiles/pandji.json) and returns the ProfileMeta the store takes. */
export function validateProfileMeta(raw) {
  if (!isObject(raw)) throw new Error('metadata must be a JSON object');
  onlyKeys(raw, TOP_KEYS, 'metadata');
  if (typeof raw.slug !== 'string' || !SLUG.test(raw.slug)) throw new Error('slug must match ^[a-z0-9-]{1,40}$');
  const name = text(raw.name, 'name', 80);
  if (!GENDERS.includes(raw.gender)) throw new Error('gender must be male, female or neutral');
  if (!LANGUAGES.includes(raw.language)) throw new Error('language must be id or en');
  const description = bilingual(raw.description, 'description', 600);
  if (!Array.isArray(raw.tags) || raw.tags.length < 1 || raw.tags.length > 12) {
    throw new Error('tags must be an array of 1 to 12 {id, en} items');
  }
  const tags = raw.tags.map((tag, i) => bilingual(tag, `tags[${i}]`, 40));
  const bestFor = bilingual(raw.bestFor, 'bestFor', 300);
  if (!isObject(raw.consent)) throw new Error('consent must be an object {subject, attestedBy, scope}');
  onlyKeys(raw.consent, ['subject', 'attestedBy', 'scope'], 'consent');
  const consent = {
    subject: text(raw.consent.subject, 'consent.subject', 200),
    attestedBy: text(raw.consent.attestedBy, 'consent.attestedBy', 200),
    scope: text(raw.consent.scope, 'consent.scope', 200),
  };
  const sort = raw.sort ?? 100;
  if (!Number.isInteger(sort) || sort < 0 || sort > 10000) throw new Error('sort must be a whole number from 0 to 10000');
  return { slug: raw.slug, name, gender: raw.gender, language: raw.language, description, tags, bestFor, consent, sort };
}
