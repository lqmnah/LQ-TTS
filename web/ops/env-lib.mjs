import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const KEY = /^[A-Z][A-Z0-9_]*$/;

export function parseEnvText(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(path) {
  return existsSync(path) ? parseEnvText(readFileSync(path, 'utf8')) : {};
}

/**
 * Values are written single-quoted, so compose's env_file reader takes them literally
 * (no `$` interpolation, no ` #` comments). A single quote can't be escaped there, so it is refused.
 * Errors name the key only, never the value.
 */
export function serializeEnv(obj) {
  return `${Object.entries(obj).map(([key, value]) => {
    if (!KEY.test(key)) throw new Error(`bad key ${key}`);
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new Error(`value for ${key} contains a newline`);
    if (text.includes("'")) throw new Error(`value for ${key} contains a single quote (not supported in env files)`);
    return `${key}='${text}'`;
  }).join('\n')}\n`;
}

/** Atomic write, mode 600 (never world-readable, even for a moment). */
export function writeEnvFile(path, obj) {
  const body = serializeEnv(obj);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function setEnvKey(path, key, value) {
  const current = readEnvFile(path);
  current[key] = value;
  writeEnvFile(path, current);
}

/** `name:value,name:value` exactly like engine/lq_tts_engine/config.py `_pairs` (first colon splits). */
export function parsePairs(raw) {
  const out = {};
  for (const item of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const colon = item.indexOf(':');
    if (colon < 1 || colon === item.length - 1) throw new Error('expected name:value pairs');
    out[item.slice(0, colon)] = item.slice(colon + 1);
  }
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `new URL()` errors carry the input (password included), so replace them with a value-free one. */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    throw new Error('not a valid URL (value hidden)');
  }
}

/** Containers reach the host's Postgres through OrbStack's host.internal. */
export function toContainerDatabaseUrl(url) {
  const u = parseUrl(url);
  if (LOOPBACK.has(u.hostname)) u.hostname = 'host.internal';
  return u.toString();
}

/** host.internal does not resolve on the macOS host itself. */
export function toHostDatabaseUrl(url) {
  const u = parseUrl(url);
  if (u.hostname === 'host.internal') u.hostname = '127.0.0.1';
  return u.toString();
}
