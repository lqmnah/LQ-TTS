import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnvText, parsePairs, readEnvFile, setEnvKey, toContainerDatabaseUrl, toHostDatabaseUrl, writeEnvFile } from './env-lib.mjs';

test('parses comments, blanks, quotes and = inside values', () => {
  const env = parseEnvText('# c\n\nA=1\nB="two words"\nC=\'x=y\'\nD=a=b\n bad line\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x=y', D: 'a=b' });
});

test('writes mode 600 atomically and round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envlib-'));
  const file = join(dir, 'x.env');
  writeEnvFile(file, { A: '1' });
  setEnvKey(file, 'B', 'secret-value');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readEnvFile(file), { A: '1', B: 'secret-value' });
  assert.equal(readFileSync(file, 'utf8'), "A='1'\nB='secret-value'\n");
});

test('single-quotes values so $, backticks, " and " #" survive, and refuses a single quote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envlib-'));
  const file = join(dir, 'q.env');
  const value = 'a$b${C}`d`"e" #f';
  writeEnvFile(file, { V: value });
  assert.equal(readEnvFile(file).V, value);
  assert.throws(() => writeEnvFile(file, { V: "it's" }), (error) => /single quote/.test(error.message) && !error.message.includes("it's"));
});

test('refuses newlines and bad keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envlib-'));
  assert.throws(() => writeEnvFile(join(dir, 'y.env'), { A: 'x\ny' }), /newline/);
  assert.throws(() => writeEnvFile(join(dir, 'y.env'), { 'a-b': 'x' }), /bad key/);
});

test('parses engine caller pairs like the engine does (first colon splits)', () => {
  assert.deepEqual(parsePairs('lq-tts:abc, lq-studio:d:e ,'), { 'lq-tts': 'abc', 'lq-studio': 'd:e' });
  assert.throws(() => parsePairs('broken'), /name:value/);
});

test('rewrites the database host for containers and back, keeping credentials', () => {
  const url = 'postgresql://lq_tts_web:p%40ss%2Fw0rd@127.0.0.1:5432/lq_tts';
  const inContainer = toContainerDatabaseUrl(url);
  assert.equal(inContainer, 'postgresql://lq_tts_web:p%40ss%2Fw0rd@host.internal:5432/lq_tts');
  assert.equal(toHostDatabaseUrl(inContainer), url);
  assert.equal(toContainerDatabaseUrl('postgresql://u:p@localhost:5432/lq_tts'), 'postgresql://u:p@host.internal:5432/lq_tts');
});

test('URL conversion errors never carry the URL', () => {
  const bad = 'postgresql://u:hunter2-secret@[bad host/db';
  for (const convert of [toContainerDatabaseUrl, toHostDatabaseUrl]) {
    assert.throws(() => convert(bad), (error) => error.message === 'not a valid URL (value hidden)' && !JSON.stringify(error).includes('hunter2') && !String(error.stack).includes('hunter2'));
  }
});
