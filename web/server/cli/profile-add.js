// Admin CLI for VO Profiles (library voices). Runs inside the web container, which carries every env setting.
//   add or replace: docker exec -i <container> node server/cli/profile-add.js --meta server/cli/profiles/pandji.json --filename VO-Sample-Pandji.mp3 < VO-Sample-Pandji.mp3
//   deactivate:     docker exec <container> node server/cli/profile-add.js --deactivate pandji
//   list:           docker exec <container> node server/cli/profile-add.js --list
// The audio arrives on stdin (docker exec -i forwards stdin only, so the metadata is a file inside the image).
// Output is ids and statuses only; error text passes through redact() before it is printed.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createEngine } from '../clients/engine.js';
import { UpstreamError, UpstreamUnavailable } from '../clients/http.js';
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db/pool.js';
import { isEngineNotFound } from '../lib/upstream-errors.js';
import { createJobsRepo } from '../services/jobs-repo.js';
import { LIBRARY_OWNER, createProfiles, profilesWithVoices } from '../services/profiles.js';
import { validateProfileMeta } from './profile-meta.js';

export const POLL_MS = 5000;
export const TIMEOUT_MS = 15 * 60 * 1000;
export const USAGE = 'usage: profile-add.js --meta <file.json> --filename <name.mp3|.wav|.m4a|.flac> < audio | --deactivate <slug> | --list';
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };

export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join('***');
  return out;
}

function describeError(err) {
  if (err instanceof UpstreamError) return `the engine refused the request: ${err.code}`;
  if (err instanceof UpstreamUnavailable) return 'the voice engine is unavailable';
  return err?.message ?? String(err);
}

function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { meta: { type: 'string' }, filename: { type: 'string' }, deactivate: { type: 'string' }, list: { type: 'boolean' } },
    allowPositionals: true,
  });
  const modes = [values.meta !== undefined, values.deactivate !== undefined, values.list === true].filter(Boolean).length;
  if (positionals.length || modes !== 1) throw new Error(USAGE);
  if (values.meta === undefined) {
    if (values.filename !== undefined) throw new Error(USAGE);
    return values;
  }
  if (!values.filename) throw new Error('--filename is required with --meta');
  if (!AUDIO_TYPES[path.extname(values.filename).toLowerCase()]) throw new Error('--filename must end in .mp3, .wav, .m4a or .flac');
  return values;
}

// 'ready' | 'failed <code>' | 'timeout'. An engine restart (unreachable) is waited out like processing.
async function waitReady(engine, id, { pollMs, timeoutMs, sleep, now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let voice = null;
    try {
      voice = await engine.getVoice(id);
    } catch (err) {
      if (!(err instanceof UpstreamUnavailable)) throw err;
    }
    if (voice?.status === 'ready') return 'ready';
    if (voice?.status === 'failed') return `failed ${voice.error_code ?? 'unknown'}`;
    if (now() >= deadline) return 'timeout';
    await sleep(pollMs);
  }
}

async function retire(voiceId, { engine, jobsRepo }) {
  if (await jobsRepo.usesVoice(voiceId)) return `previous voice ${voiceId} kept, used by jobs`;
  try {
    await engine.deleteVoice(voiceId);
    return `previous voice ${voiceId} deleted`;
  } catch (err) {
    if (isEngineNotFound(err)) return `previous voice ${voiceId} already gone`;
    return `previous voice ${voiceId} not deleted: ${err instanceof UpstreamError ? err.code : 'engine_unavailable'}`;
  }
}

async function addProfile(ctx, args, { stdin, out, pollMs, timeoutMs, sleep, now }) {
  const { engine, profiles } = ctx;
  let raw;
  try {
    raw = JSON.parse(await readFile(args.meta, 'utf8'));
  } catch {
    throw new Error(`cannot read metadata file ${args.meta} as JSON`);
  }
  const meta = validateProfileMeta(raw);
  if (stdin.isTTY) throw new Error('pipe the audio file on stdin');
  const created = await engine.uploadVoice({
    fields: { name: meta.name, owner_ref: LIBRARY_OWNER, language: meta.language },
    filename: args.filename,
    mimeType: AUDIO_TYPES[path.extname(args.filename).toLowerCase()],
    file: stdin,
  });
  out(`voice ${created.id} ${created.status}`);
  // Until the row is written nothing points at the new voice; on any failure it is removed again.
  const discard = () => engine.deleteVoice(created.id).catch(() => {});
  let outcome;
  try {
    outcome = await waitReady(engine, created.id, { pollMs, timeoutMs, sleep, now });
  } catch (err) {
    await discard();
    throw err;
  }
  if (outcome !== 'ready') {
    await discard();
    out(`voice ${created.id} ${outcome}`);
    return 1;
  }
  out(`voice ${created.id} ready`);
  let previous;
  try {
    previous = await profiles.upsert(meta, created.id);
  } catch (err) {
    await discard();
    throw err;
  }
  out(`profile ${meta.slug} active voice ${created.id}`);
  if (previous && previous !== created.id) out(await retire(previous, ctx));
  return 0;
}

async function deactivate({ profiles }, slug, out) {
  if (!(await profiles.deactivate(slug))) throw new Error(`profile ${slug} not found`);
  out(`profile ${slug} deactivated`);
  return 0;
}

async function listProfiles(ctx, out) {
  const list = await profilesWithVoices(ctx);
  out(`profiles ${list.length}`);
  for (const { row, voice } of list) out(`profile ${row.slug} voice ${row.voice_id} ${voice ? voice.status : 'unreachable'}`);
  return 0;
}

export async function runProfileAdd({
  argv, stdin, out, err, ctx, secrets = [], pollMs = POLL_MS, timeoutMs = TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now,
}) {
  try {
    const args = parseCliArgs(argv);
    if (args.list) return await listProfiles(ctx, out);
    if (args.deactivate !== undefined) return await deactivate(ctx, args.deactivate, out);
    return await addProfile(ctx, args, { stdin, out, pollMs, timeoutMs, sleep, now });
  } catch (error) {
    err(`error: ${redact(describeError(error), secrets)}`);
    return 1;
  }
}

if (import.meta.main) {
  const config = loadConfig();
  const secrets = [config.engineToken, config.lqstudioToken, config.engineCallbackSecret, config.databaseUrl];
  const pool = createPool(config.databaseUrl, config.dbSchema, { max: 2 });
  try {
    await migrate(pool, config.dbSchema); // a no-op once the server has started; needed when the CLI runs first (e2e)
    process.exitCode = await runProfileAdd({
      argv: process.argv.slice(2),
      stdin: process.stdin,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
      ctx: {
        engine: createEngine({ baseUrl: config.engineUrl, token: config.engineToken }),
        profiles: createProfiles(pool),
        jobsRepo: createJobsRepo(pool),
      },
      secrets,
    });
  } catch (error) {
    process.stderr.write(`error: ${redact(describeError(error), secrets)}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
