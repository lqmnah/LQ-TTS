import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USAGE, runProfileAdd } from '../cli/profile-add.js';
import { validateProfileMeta } from '../cli/profile-meta.js';
import { testDatabaseUrl } from './db-url.js';
import { CALLBACK_SECRET, ENGINE_TOKEN, LQ_TOKEN, startHarness } from './helpers.js';

const PANDJI = fileURLToPath(new URL('../cli/profiles/pandji.json', import.meta.url));
const BASE = JSON.parse(readFileSync(PANDJI, 'utf8'));
const AUDIO = Buffer.alloc(8192, 3);
const dir = mkdtempSync(join(tmpdir(), 'lq-tts-profile-'));

function writeMeta(over) {
  const file = join(dir, `${crypto.randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ ...BASE, ...over }));
  return file;
}

describe('validateProfileMeta', () => {
  it('accepts the shipped Pandji metadata', () => {
    const meta = validateProfileMeta(BASE);
    expect(meta).toMatchObject({
      slug: 'pandji', name: 'Pandji', gender: 'male', language: 'id', sort: 10,
      consent: { subject: 'Pandji', attestedBy: 'lqmnah', scope: 'Public library voice for all LQ-TTS users on tts.lq-studio.com' },
    });
    expect(meta.tags).toHaveLength(8);
    expect(meta.tags[1]).toEqual({ id: 'Bariton hangat', en: 'Warm baritone' });
  });

  it('defaults the sort to 100', () => {
    const { sort, ...rest } = BASE;
    expect(validateProfileMeta(rest).sort).toBe(100);
  });

  it.each([
    [{ slug: 'Pandji!' }, /^slug must match/],
    [{ name: 'x'.repeat(81) }, /^name must be at most 80 characters/],
    [{ gender: 'other' }, /^gender must be/],
    [{ language: 'fr' }, /^language must be id or en/],
    [{ tags: [] }, /^tags must be an array of 1 to 12/],
    [{ tags: Array.from({ length: 13 }, () => ({ id: 'a', en: 'a' })) }, /^tags must be an array of 1 to 12/],
    [{ tags: [{ id: 'Pria' }] }, /^tags\[0\]\.en must be a non-empty string/],
    [{ description: { id: 'Pria \u2014 bariton', en: 'Male' } }, /^description\.id must not contain an em dash/],
    [{ bestFor: 'Narasi' }, /^bestFor must be an object/],
    [{ consent: { subject: 'Pandji', attestedBy: 'lqmnah' } }, /^consent\.scope must be a non-empty string/],
    [{ consentGrantedAt: '2026-01-01' }, /^unknown metadata keys: consentGrantedAt/],
    [{ sort: 1.5 }, /^sort must be a whole number/],
  ])('rejects %j', (over, message) => {
    expect(() => validateProfileMeta({ ...BASE, ...over })).toThrow(message);
  });
});

describe('profile-add CLI', () => {
  let h;
  const printed = [];
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const uploads = () => h.engine.state.callsTo('POST', '/v1/voices').length;
  // Plays the engine finishing: every library voice still processing gets `status` when the CLI first waits.
  const finishAs = (status, errorCode = null) => async () => {
    for (const v of h.engine.state.voices.values()) {
      if (v.owner_ref === 'library' && v.status === 'processing') Object.assign(v, { status, error_code: errorCode });
    }
  };

  async function run(argv, { sleep = finishAs('ready'), now, engine } = {}) {
    const lines = [];
    const errors = [];
    const code = await runProfileAdd({
      argv,
      stdin: Readable.from([AUDIO]),
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
      ctx: { engine: engine ?? h.ctx.engine, profiles: h.ctx.profiles, jobsRepo: h.ctx.jobsRepo },
      secrets: [ENGINE_TOKEN, LQ_TOKEN, CALLBACK_SECRET, testDatabaseUrl()],
      sleep,
      ...(now ? { now } : {}),
    });
    printed.push(...lines, ...errors);
    return { code, lines, errors, id: lines[0]?.split(' ')[1] };
  }

  it.each([
    [[], /^error: usage: profile-add\.js/],
    [['--meta', PANDJI], /^error: --filename is required with --meta$/],
    [['--meta', PANDJI, '--filename', 'notes.txt'], /^error: --filename must end in \.mp3, \.wav, \.m4a or \.flac$/],
    [['--list', '--deactivate', 'x'], /^error: usage: profile-add\.js/],
    [['--bogus'], /^error: Unknown option '--bogus'/],
    [['--meta', join(dir, 'missing.json'), '--filename', 'a.mp3'], /^error: cannot read metadata file .*missing\.json as JSON$/],
    [['--meta', writeMeta({ gender: 'other' }), '--filename', 'a.mp3'], /^error: gender must be male, female or neutral$/],
  ])('refuses %j before any upload', async (argv, message) => {
    const before = uploads();
    const { code, lines, errors } = await run(argv);
    expect(code).toBe(1);
    expect(lines).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(message);
    expect(uploads()).toBe(before);
    expect(USAGE).toMatch(/^usage: profile-add\.js/);
  });

  it('uploads the audio as a library voice, waits for ready, then records the profile with its consent', async () => {
    const { code, lines, errors, id } = await run(['--meta', PANDJI, '--filename', 'VO-Sample-Pandji.mp3']);
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(lines).toEqual([`voice ${id} processing`, `voice ${id} ready`, `profile pandji active voice ${id}`]);
    expect(h.engine.state.voices.get(id)).toMatchObject({ owner_ref: 'library', name: 'Pandji', language: 'id', status: 'ready', bytes: AUDIO.length });
    expect(h.engine.state.callsTo('POST', '/v1/voices').at(-1).body.file).toMatchObject({ filename: 'VO-Sample-Pandji.mp3', mimeType: 'audio/mpeg' });
    const row = await h.ctx.profiles.bySlug('pandji');
    expect(row).toMatchObject({
      voice_id: id, active: true, sort: 10, name: 'Pandji',
      consent_subject: 'Pandji', consent_attested_by: 'lqmnah',
      consent_scope: 'Public library voice for all LQ-TTS users on tts.lq-studio.com',
    });
    expect(Date.now() - row.consent_granted_at.getTime()).toBeLessThan(60_000);
  });

  it('replaces a profile only after the new voice is ready, then deletes the old voice', async () => {
    const meta = writeMeta({ slug: 'replace-order' });
    const { id: oldId } = await run(['--meta', meta, '--filename', 'a.wav']);
    const seenWhileProcessing = [];
    const second = await run(['--meta', meta, '--filename', 'b.wav'], {
      sleep: async () => {
        seenWhileProcessing.push((await h.ctx.profiles.bySlug('replace-order')).voice_id, h.engine.state.voices.has(oldId));
        await finishAs('ready')();
      },
    });
    const newId = second.id;
    expect(seenWhileProcessing).toEqual([oldId, true]);
    expect(second.code).toBe(0);
    expect(second.lines).toEqual([
      `voice ${newId} processing`, `voice ${newId} ready`, `profile replace-order active voice ${newId}`, `previous voice ${oldId} deleted`,
    ]);
    expect((await h.ctx.profiles.bySlug('replace-order')).voice_id).toBe(newId);
    expect(h.engine.state.voices.has(oldId)).toBe(false);
    const calls = h.engine.state.calls.map((c) => `${c.method} ${c.path}`);
    const readyCheck = calls.lastIndexOf(`GET /v1/voices/${newId}`);
    expect(readyCheck).toBeGreaterThan(-1);
    expect(calls.indexOf(`DELETE /v1/voices/${oldId}`)).toBeGreaterThan(readyCheck);
  });

  it('keeps the previous voice when voiceovers still use it', async () => {
    const meta = writeMeta({ slug: 'still-used' });
    const { id: oldId } = await run(['--meta', meta, '--filename', 'a.wav']);
    await h.pool.query(
      `INSERT INTO jobs (id, user_id, voice_id, voice_name, title, chars, status) VALUES ($1, 'ana', $2, 'Pandji', 'Halo', 5, 'done')`,
      [crypto.randomUUID(), oldId],
    );
    const second = await run(['--meta', meta, '--filename', 'b.wav']);
    expect(second.code).toBe(0);
    expect(second.lines.at(-1)).toBe(`previous voice ${oldId} kept, used by jobs`);
    expect(h.engine.state.voices.has(oldId)).toBe(true);
    expect((await h.ctx.profiles.bySlug('still-used')).voice_id).toBe(second.id);
  });

  it('exits 1 on a failed voice, deletes it, and leaves an existing profile on its old voice', async () => {
    const meta = writeMeta({ slug: 'fail-keep' });
    const { id: oldId } = await run(['--meta', meta, '--filename', 'a.wav']);
    const failed = await run(['--meta', meta, '--filename', 'b.wav'], { sleep: finishAs('failed', 'no_clean_speech') });
    expect(failed.code).toBe(1);
    expect(failed.lines).toEqual([`voice ${failed.id} processing`, `voice ${failed.id} failed no_clean_speech`]);
    expect(h.engine.state.voices.has(failed.id)).toBe(false);
    expect(await h.ctx.profiles.bySlug('fail-keep')).toMatchObject({ voice_id: oldId, active: true });
    expect(h.engine.state.voices.has(oldId)).toBe(true);
  });

  it('polls every 5 s for 15 min, then gives up, deletes the voice and records nothing', async () => {
    let t = 0;
    const res = await run(['--meta', writeMeta({ slug: 'too-slow' }), '--filename', 'a.wav'], {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(res.code).toBe(1);
    expect(res.lines).toEqual([`voice ${res.id} processing`, `voice ${res.id} timeout`]);
    expect(h.engine.state.calls.filter((c) => c.method === 'GET' && c.path === `/v1/voices/${res.id}`)).toHaveLength(181);
    expect(h.engine.state.voices.has(res.id)).toBe(false);
    expect(await h.ctx.profiles.bySlug('too-slow')).toBeNull();
  });

  it('exits 1 without a profile when the engine is down', async () => {
    h.engine.state.failNext.set('POST /v1/voices', { status: 503, code: 'model_loading' });
    const res = await run(['--meta', writeMeta({ slug: 'engine-down' }), '--filename', 'a.wav']);
    expect(res.code).toBe(1);
    expect(res.errors).toEqual(['error: the voice engine is unavailable']);
    expect(await h.ctx.profiles.bySlug('engine-down')).toBeNull();
  });

  it('deactivates by slug without touching the engine voice', async () => {
    const { id } = await run(['--meta', writeMeta({ slug: 'gone' }), '--filename', 'a.wav']);
    const off = await run(['--deactivate', 'gone']);
    expect(off.code).toBe(0);
    expect(off.lines).toEqual(['profile gone deactivated']);
    expect(await h.ctx.profiles.get(id)).toBeNull();
    expect(h.engine.state.voices.has(id)).toBe(true);
    const unknown = await run(['--deactivate', 'nobody']);
    expect(unknown.code).toBe(1);
    expect(unknown.errors).toEqual(['error: profile nobody not found']);
  });

  it('lists active profiles with their engine status', async () => {
    const { id } = await run(['--meta', writeMeta({ slug: 'listed' }), '--filename', 'a.wav']);
    const res = await run(['--list']);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toMatch(/^profiles \d+$/);
    expect(res.lines).toContain(`profile listed voice ${id} ready`);
  });

  it('redacts secrets from error text', async () => {
    const leaky = { ...h.ctx.engine, uploadVoice: async () => { throw new Error(`connect to ${testDatabaseUrl()} with ${ENGINE_TOKEN} failed`); } };
    const res = await run(['--meta', writeMeta({ slug: 'leaky' }), '--filename', 'a.wav'], { engine: leaky });
    expect(res.code).toBe(1);
    expect(res.errors).toEqual(['error: connect to *** with *** failed']);
  });

  it('never printed a secret in any run above', () => {
    expect(printed.length).toBeGreaterThan(20);
    for (const secret of [ENGINE_TOKEN, LQ_TOKEN, CALLBACK_SECRET, testDatabaseUrl()]) {
      expect(printed.filter((line) => line.includes(secret))).toEqual([]);
    }
  });
});
