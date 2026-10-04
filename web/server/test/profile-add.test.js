import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLL_MS, USAGE, runProfileAdd } from '../cli/profile-add.js';
import { validateProfileMeta } from '../cli/profile-meta.js';
import { UpstreamError, UpstreamUnavailable } from '../clients/http.js';
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

  async function run(argv, opts = {}) {
    const { lines, errors, done } = start(argv, opts);
    const code = await done;
    printed.push(...lines, ...errors);
    return { code, lines, errors, id: lines[0]?.split(' ')[1] };
  }
  function start(argv, { sleep = finishAs('ready'), now, engine, signals, exit } = {}) {
    const lines = [];
    const errors = [];
    const done = runProfileAdd({
      argv,
      stdin: Readable.from([AUDIO]),
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
      ctx: { engine: engine ?? h.ctx.engine, profiles: h.ctx.profiles, jobsRepo: h.ctx.jobsRepo },
      secrets: [ENGINE_TOKEN, LQ_TOKEN, CALLBACK_SECRET, testDatabaseUrl()],
      sleep,
      ...(now ? { now } : {}),
      signals: signals ?? new EventEmitter(),
      ...(exit ? { exit } : {}),
    });
    return { lines, errors, done };
  }
  // Runs the CLI until a signal handler calls exit(); `onSleep(ms, signals)` decides when to send the signal.
  async function runUntilSignal(argv, onSleep, engine) {
    const signals = new EventEmitter();
    let exited;
    const exitCode = new Promise((resolve) => { exited = resolve; });
    const never = new Promise(() => {});
    const { lines, errors } = start(argv, {
      engine,
      signals,
      exit: exited,
      sleep: async (ms) => {
        if (await onSleep(ms, signals)) return never; // the process would be gone: the CLI never resumes
      },
    });
    const code = await exitCode;
    printed.push(...lines, ...errors);
    return { code, lines, errors, id: lines[0]?.split(' ')[1], signals };
  }

  it.each([
    [[], /^error: usage: profile-add\.js/],
    [['--meta', PANDJI], /^error: --filename is required with --meta$/],
    [['--meta', PANDJI, '--filename', 'notes.txt'], /^error: --filename must end in \.mp3, \.wav, \.m4a or \.flac$/],
    [['--list', '--deactivate', 'x'], /^error: usage: profile-add\.js/],
    [['--bogus'], /^error: Unknown option '--bogus'/],
    [['--meta', join(dir, 'missing.json'), '--filename', 'a.mp3'], /^error: cannot read metadata file .*missing\.json as JSON$/],
    [['--meta', writeMeta({ gender: 'other' }), '--filename', 'a.mp3'], /^error: gender must be male, female or neutral$/],
    [['--api-allowed', 'yes', '--slug', 'x'], /^error: --api-allowed must be true or false$/],
    [['--api-allowed', 'true'], /^error: --slug is required with --api-allowed$/],
    [['--slug', 'x', '--list'], /^error: usage: profile-add\.js/],
    [['--api-allowed', 'true', '--slug', 'x', '--filename', 'a.mp3'], /^error: usage: profile-add\.js/],
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
      sleep: async (ms) => {
        if (ms !== POLL_MS) return;
        seenWhileProcessing.push((await h.ctx.profiles.bySlug('replace-order')).voice_id, h.engine.state.voices.has(oldId));
        await finishAs('ready')();
      },
    });
    const newId = second.id;
    expect(seenWhileProcessing).toEqual([oldId, true]);
    expect(second.code).toBe(0);
    expect(second.lines).toEqual([
      `voice ${newId} processing`, `voice ${newId} ready`, `profile replace-order active voice ${newId}`,
      `previous voice ${oldId} retiring in 60 s`, `previous voice ${oldId} deleted`,
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

  it('waits the grace window after the switch, so a job created on the old voice meanwhile keeps it', async () => {
    const meta = writeMeta({ slug: 'grace' });
    const { id: oldId } = await run(['--meta', meta, '--filename', 'a.wav']);
    const graces = [];
    const linesAtGrace = [];
    const second = start(['--meta', meta, '--filename', 'b.wav'], {
      sleep: async (ms) => {
        if (ms === POLL_MS) return finishAs('ready')();
        graces.push(ms);
        // The old voice id is on screen before the wait, so an interrupted run still names it.
        linesAtGrace.push(...second.lines);
        // A job create that passed its voice check on the old voice before the switch lands now.
        expect((await h.ctx.profiles.bySlug('grace')).voice_id).not.toBe(oldId);
        await h.pool.query(
          `INSERT INTO jobs (id, user_id, voice_id, voice_name, title, chars, status) VALUES ($1, 'ana', $2, 'Pandji', 't', 1, 'queued')`,
          [crypto.randomUUID(), oldId],
        );
      },
    });
    const code = await second.done;
    printed.push(...second.lines, ...second.errors);
    expect(graces).toEqual([60_000]);
    expect(linesAtGrace.at(-1)).toBe(`previous voice ${oldId} retiring in 60 s`);
    expect(code).toBe(0);
    expect(second.lines.slice(-2)).toEqual([`previous voice ${oldId} retiring in 60 s`, `previous voice ${oldId} kept, used by jobs`]);
    expect(h.engine.state.voices.has(oldId)).toBe(true);
  });

  it('takes the grace window from --grace-seconds and refuses a bad value', async () => {
    const meta = writeMeta({ slug: 'grace-flag' });
    const { id: oldId } = await run(['--meta', meta, '--filename', 'a.wav']);
    const graces = [];
    const second = await run(['--meta', meta, '--filename', 'b.wav', '--grace-seconds', '7'], {
      sleep: async (ms) => (ms === POLL_MS ? finishAs('ready')() : graces.push(ms)),
    });
    expect(graces).toEqual([7000]);
    expect(second.lines.slice(-2)).toEqual([`previous voice ${oldId} retiring in 7 s`, `previous voice ${oldId} deleted`]);
    const before = uploads();
    for (const argv of [
      ['--meta', meta, '--filename', 'b.wav', '--grace-seconds=-1'],
      ['--meta', meta, '--filename', 'b.wav', '--grace-seconds', 'soon'],
      ['--list', '--grace-seconds', '5'],
    ]) {
      const bad = await run(argv);
      expect(bad.code).toBe(1);
      expect(bad.errors[0]).toMatch(/^error: (--grace-seconds must be a whole number of seconds|usage: profile-add\.js)/);
    }
    expect(uploads()).toBe(before);
  });

  it('says so when a discarded voice cannot be deleted', async () => {
    const stuck = {
      ...h.ctx.engine,
      deleteVoice: async () => { throw new UpstreamError('engine', 500, 'internal_error', 'boom'); },
    };
    const failed = await run(['--meta', writeMeta({ slug: 'stuck' }), '--filename', 'a.wav'], {
      engine: stuck, sleep: finishAs('failed', 'no_clean_speech'),
    });
    expect(failed.code).toBe(1);
    expect(failed.lines).toEqual([
      `voice ${failed.id} processing`, `voice ${failed.id} not deleted: internal_error`, `voice ${failed.id} failed no_clean_speech`,
    ]);
    const down = { ...h.ctx.engine, deleteVoice: async () => { throw new UpstreamUnavailable('engine', null, 503); } };
    const slow = await run(['--meta', writeMeta({ slug: 'stuck-down' }), '--filename', 'a.wav'], {
      engine: down, sleep: finishAs('failed', 'no_clean_speech'),
    });
    expect(slow.lines).toContain(`voice ${slow.id} not deleted: engine_unavailable`);
  });

  it('on SIGTERM while the new voice is processing, deletes only the new voice and exits 143', async () => {
    const meta = writeMeta({ slug: 'sig-poll' });
    const { id: oldId } = await run(['--meta', meta, '--filename', 'a.wav']);
    const res = await runUntilSignal(['--meta', meta, '--filename', 'b.wav'], (ms, signals) => {
      signals.emit('SIGTERM', 'SIGTERM');
      return true;
    });
    expect(res.code).toBe(143);
    expect(res.lines).toEqual([`voice ${res.id} processing`, `voice ${res.id} discarded (signal)`]);
    expect(h.engine.state.voices.has(res.id)).toBe(false);
    expect(h.engine.state.voices.has(oldId)).toBe(true);
    expect(await h.ctx.profiles.bySlug('sig-poll')).toMatchObject({ voice_id: oldId, active: true });
  });

  it('on SIGINT exits 130, and says so when the new voice cannot be deleted', async () => {
    const stuck = {
      ...h.ctx.engine,
      deleteVoice: async () => { throw new UpstreamError('engine', 500, 'internal_error', 'boom'); },
    };
    const res = await runUntilSignal(['--meta', writeMeta({ slug: 'sig-int' }), '--filename', 'a.wav'], (ms, signals) => {
      signals.emit('SIGINT', 'SIGINT');
      return true;
    }, stuck);
    expect(res.code).toBe(130);
    expect(res.lines).toEqual([`voice ${res.id} processing`, `voice ${res.id} not deleted: internal_error`]);
    expect(await h.ctx.profiles.bySlug('sig-int')).toBeNull();
  });

  it('on SIGTERM during the grace window, exits 143 and deletes nothing', async () => {
    const meta = writeMeta({ slug: 'sig-grace' });
    const { id: oldId } = await run(['--meta', meta, '--filename', 'a.wav']);
    const res = await runUntilSignal(['--meta', meta, '--filename', 'b.wav'], async (ms, signals) => {
      if (ms === POLL_MS) return finishAs('ready')();
      signals.emit('SIGTERM', 'SIGTERM');
      return true;
    });
    expect(res.code).toBe(143);
    expect(res.lines).toEqual([
      `voice ${res.id} processing`, `voice ${res.id} ready`, `profile sig-grace active voice ${res.id}`,
      `previous voice ${oldId} retiring in 60 s`,
    ]);
    expect(h.engine.state.voices.has(res.id)).toBe(true);
    expect(h.engine.state.voices.has(oldId)).toBe(true);
    expect((await h.ctx.profiles.bySlug('sig-grace')).voice_id).toBe(res.id);
  });

  it('removes its signal handlers when it finishes', async () => {
    const signals = new EventEmitter();
    const { done } = start(['--meta', writeMeta({ slug: 'sig-clean' }), '--filename', 'a.wav'], { signals });
    expect(await done).toBe(0);
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
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

  it('lists active profiles whose engine voice is missing or not a library voice', async () => {
    const missingId = crypto.randomUUID();
    await h.ctx.profiles.upsert(validateProfileMeta({ ...BASE, slug: 'list-missing' }), missingId);
    const own = await h.ctx.engine.uploadVoice({
      fields: { name: 'Mine', owner_ref: 'ana', language: 'id' }, filename: 'm.wav', mimeType: 'audio/wav', file: Readable.from([AUDIO]),
    });
    await h.ctx.profiles.upsert(validateProfileMeta({ ...BASE, slug: 'list-foreign' }), own.id);
    const res = await run(['--list']);
    expect(res.code).toBe(0);
    expect(res.lines).toContain(`profile list-missing voice ${missingId} missing`);
    expect(res.lines).toContain(`profile list-foreign voice ${own.id} not library`);
    expect(res.lines[0]).toBe(`profiles ${res.lines.length - 1}`);
    await run(['--deactivate', 'list-missing']);
    await run(['--deactivate', 'list-foreign']);
  });

  it('redacts secrets from error text', async () => {
    const leaky = { ...h.ctx.engine, uploadVoice: async () => { throw new Error(`connect to ${testDatabaseUrl()} with ${ENGINE_TOKEN} failed`); } };
    const res = await run(['--meta', writeMeta({ slug: 'leaky' }), '--filename', 'a.wav'], { engine: leaky });
    expect(res.code).toBe(1);
    expect(res.errors).toEqual(['error: connect to *** with *** failed']);
  });

  it('allows and disallows a profile for the API by slug, keeps the flag on replace, and lists it', async () => {
    const { id } = await run(['--meta', writeMeta({ slug: 'api-flag' }), '--filename', 'a.wav']);
    expect((await h.ctx.profiles.bySlug('api-flag')).api_allowed).toBe(false);
    const on = await run(['--api-allowed', 'true', '--slug', 'api-flag']);
    expect(on).toMatchObject({ code: 0, lines: ['profile api-flag api allowed'], errors: [] });
    expect((await run(['--list'])).lines).toContain(`profile api-flag voice ${id} ready api`);
    const replaced = await run(['--meta', writeMeta({ slug: 'api-flag' }), '--filename', 'a.wav']);
    expect(replaced.code).toBe(0);
    expect((await h.ctx.profiles.bySlug('api-flag')).api_allowed).toBe(true);
    const off = await run(['--api-allowed', 'false', '--slug', 'api-flag']);
    expect(off.lines).toEqual(['profile api-flag api not allowed']);
    expect((await h.ctx.profiles.bySlug('api-flag')).api_allowed).toBe(false);
    const unknown = await run(['--api-allowed', 'true', '--slug', 'nobody']);
    expect(unknown).toMatchObject({ code: 1, errors: ['error: profile nobody not found'] });
  });

  it('never printed a secret in any run above', () => {
    expect(printed.length).toBeGreaterThan(20);
    for (const secret of [ENGINE_TOKEN, LQ_TOKEN, CALLBACK_SECRET, testDatabaseUrl()]) {
      expect(printed.filter((line) => line.includes(secret))).toEqual([]);
    }
  });
});
