import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SECRET = 'hunter2-not-a-real-secret';
const run = (script, args, input = '') =>
  spawnSync(process.execPath, [join(import.meta.dirname, script), ...args], { input, encoding: 'utf8' });
const assertHidden = (result) => {
  assert.ok(!result.stdout.includes(SECRET), 'value leaked to stdout');
  assert.ok(!result.stderr.includes(SECRET), 'value leaked to stderr');
};

test('env-container fails on an unparsable DATABASE_URL without printing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcli-'));
  const from = join(dir, 'native.env');
  writeFileSync(from, `DATABASE_URL=postgresql://u:${SECRET}@[bad host/db\nENGINE_TOKEN=${SECRET}\nENGINE_CALLBACK_SECRET=${SECRET}\n`);
  const result = run('env-container.mjs', ['--from', from, '--to', join(dir, 'out.env')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL is not a valid URL \(value hidden\)/);
  assertHidden(result);
});

test('env-container fails on malformed engine pairs without printing them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcli-'));
  const from = join(dir, 'native.env');
  const engine = join(dir, 'engine.env');
  writeFileSync(from, 'DATABASE_URL=postgresql://u:p@127.0.0.1:5432/db\n');
  writeFileSync(engine, `LQTTS_TOKENS=${SECRET}\nLQTTS_CALLBACK_SECRETS=${SECRET}\n`);
  const result = run('env-container.mjs', ['--from', from, '--to', join(dir, 'out.env'), '--engine-env', engine, '--engine-caller', 'x']);
  assert.equal(result.status, 1);
  assertHidden(result);
});

test('env-set refuses a single quote without printing the value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcli-'));
  const result = run('env-set.mjs', [join(dir, 'x.env'), 'K'], `${SECRET}'x\n`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /single quote/);
  assertHidden(result);
});
