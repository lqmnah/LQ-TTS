import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import busboy from 'busboy';

export const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, 7)]);
const FILE_TYPES = { 'final.mp3': 'audio/mpeg', 'final.wav': 'audio/wav', 'subs.srt': 'application/x-subrip', 'subs.vtt': 'text/vtt' };
const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, code, message = code) => json(res, status, { error: { code, message } });

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

// In-memory stand-in for the voice engine API (same paths and JSON shapes as engine/lq_tts_engine/api/app.py).
export async function startFakeEngine({ port = 0, token } = {}) {
  const state = {
    voices: new Map(),
    jobs: new Map(),
    calls: [],
    failNext: new Map(),
    healthStatus: 200,
    events: new Map(),
    fileBytes: Buffer.from('0123456789abcdefghij'),
    // Voice uploads whose request socket is still open, and an optional barrier every finished upload waits on.
    openUploads: 0,
    heldUploads: 0,
    voiceGate: null,
    listDelayMs: 0,
    callsTo(method, route) {
      return this.calls.filter((c) => c.method === method && c.route === route);
    },
  };

  const voiceOut = (v) => ({
    id: v.id, name: v.name, owner_ref: v.owner_ref, language: v.language, status: v.status, error_code: v.error_code,
    ref_transcript: null, ref_seconds: v.ref_seconds, clip_start_s: null, clip_end_s: null, created_at: v.created_at,
    preview_url: v.status === 'ready' ? `/v1/voices/${v.id}/preview.wav` : null,
  });
  const jobView = (j) => ({
    id: j.id, status: j.status, error_code: j.error_code, revision: j.revision,
    progress: { done: j.sentences.filter((s) => s.status === 'done' || s.status === 'needs_review').length, total: j.sentences.length },
    needs_review: j.sentences.filter((s) => s.status === 'needs_review').length,
    queue_position: 0, chars: j.chars, audio_seconds: j.audio_seconds, settings: j.settings,
    files: j.doneRevision
      ? Object.fromEntries(Object.keys(FILE_TYPES).map((n) => [n, `/v1/jobs/${j.id}/files/${n}?revision=${j.doneRevision}`]))
      : {},
    created_at: j.created_at, finished_at: j.finished_at,
  });
  const sentenceOut = (j, s) => ({
    idx: s.idx, paragraph_idx: s.paragraph_idx, text: s.text, style: s.style, status: s.status, takes: s.takes,
    score: s.score, asr_text: null, duration_s: s.duration_s, start_s: s.start_s, end_s: s.end_s,
    audio_url: s.audio ? `/v1/jobs/${j.id}/sentences/${s.idx}/audio.wav` : null,
  });

  function addVoice({ owner_ref, name = 'Voice', status = 'ready', language = 'id', error_code = null }) {
    const v = {
      id: crypto.randomUUID(), owner_ref, name, status, language, error_code,
      ref_seconds: status === 'ready' ? 12.5 : null, created_at: now(), bytes: 0, sha256: null, fields: {},
    };
    state.voices.set(v.id, v);
    return v;
  }

  function setJob(id, patch) {
    const j = state.jobs.get(id);
    Object.assign(j, patch);
    if (patch.status === 'done') {
      j.doneRevision = j.revision;
      j.finished_at = now();
      for (const s of j.sentences) {
        s.status = 'done';
        s.audio = true;
      }
    } else if (patch.status === 'failed' || patch.status === 'canceled') {
      j.finished_at = now();
    }
    return j;
  }

  function receiveVoice(req, res, call) {
    state.openUploads += 1;
    req.on('close', () => {
      state.openUploads -= 1;
    });
    return new Promise((resolve) => {
      const bb = busboy({ headers: req.headers });
      const fields = {};
      let file = null;
      bb.on('field', (name, value) => {
        fields[name] = value;
      });
      bb.on('file', (name, stream, info) => {
        const hash = crypto.createHash('sha256');
        file = { filename: info.filename, mimeType: info.mimeType, bytes: 0, sha256: null };
        stream.on('data', (chunk) => {
          file.bytes += chunk.length;
          hash.update(chunk);
        });
        stream.on('end', () => {
          file.sha256 = hash.digest('hex');
        });
      });
      bb.on('error', () => {
        res.destroy();
        resolve();
      });
      bb.on('close', async () => {
        if (state.voiceGate) {
          state.heldUploads += 1;
          await state.voiceGate;
          state.heldUploads -= 1;
        }
        call.body = { fields, file };
        if (!fields.name || !fields.owner_ref || !file) {
          fail(res, 400, 'invalid_request', 'name, owner_ref and audio are required');
        } else if (!['.mp3', '.wav', '.m4a', '.flac'].includes(path.extname(file.filename).toLowerCase())) {
          fail(res, 415, 'unsupported_audio', 'use MP3, WAV, M4A or FLAC');
        } else {
          const v = addVoice({ owner_ref: fields.owner_ref, name: fields.name, status: 'processing', language: fields.language ?? null });
          Object.assign(v, { bytes: file.bytes, sha256: file.sha256, fields });
          json(res, 202, { id: v.id, status: v.status });
        }
        resolve();
      });
      req.on('aborted', () => resolve());
      req.on('error', () => resolve());
      req.pipe(bb);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fake');
      const p = url.pathname;
      const route = p.replace(UUID_IN_PATH, ':id').replace(/\/sentences\/\d+/, '/sentences/:idx');
      const call = { method: req.method, route, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers, body: null };
      state.calls.push(call);
      if (route === '/v1/health') {
        if (state.healthStatus === 200) return json(res, 200, { model_loaded: true, queue_depth: 0 });
        return fail(res, state.healthStatus, 'model_loading', 'worker has not loaded the model');
      }
      if (req.headers.authorization !== `Bearer ${token}`) return fail(res, 401, 'unauthorized', 'missing or invalid service token');
      const failKey = `${req.method} ${route}`;
      const planned = state.failNext.get(failKey);
      if (planned) {
        state.failNext.delete(failKey);
        req.resume();
        return fail(res, planned.status, planned.code, planned.message ?? planned.code);
      }
      const id = p.match(UUID_IN_PATH)?.[0];
      const idx = Number(p.match(/\/sentences\/(\d+)/)?.[1]);

      if (req.method === 'POST' && route === '/v1/voices') return await receiveVoice(req, res, call);
      if (req.method === 'GET' && route === '/v1/voices') {
        const owner = url.searchParams.get('owner_ref');
        if (state.listDelayMs) await sleep(state.listDelayMs);
        if (!owner) return fail(res, 400, 'invalid_request', 'query.owner_ref: Field required');
        const list = [...state.voices.values()].filter((v) => v.owner_ref === owner).reverse();
        return json(res, 200, list.map(voiceOut));
      }
      if (route.startsWith('/v1/voices/:id')) {
        const v = state.voices.get(id);
        if (!v) return fail(res, 404, 'not_found', 'voice not found');
        if (req.method === 'GET' && route === '/v1/voices/:id') return json(res, 200, voiceOut(v));
        if (req.method === 'GET' && route === '/v1/voices/:id/preview.wav') {
          if (v.status !== 'ready') return fail(res, 404, 'not_found', 'voice has no preview yet');
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': WAV_BYTES.length });
          return res.end(WAV_BYTES);
        }
        if (req.method === 'DELETE' && route === '/v1/voices/:id') {
          state.voices.delete(id);
          for (const j of [...state.jobs.values()]) if (j.voice_id === id) state.jobs.delete(j.id);
          res.writeHead(204);
          return res.end();
        }
      }
      if (req.method === 'POST' && route === '/v1/jobs') {
        const body = await readJson(req);
        call.body = body;
        const key = req.headers['idempotency-key'];
        const existing = key ? [...state.jobs.values()].find((j) => j.idem === key) : null;
        if (existing) return json(res, 202, { id: existing.id, sentences_total: existing.sentences.length, estimated_seconds: 12 });
        const v = state.voices.get(body.voice_id);
        if (!v) return fail(res, 404, 'not_found', 'voice not found');
        if (v.status !== 'ready') return fail(res, 409, 'voice_not_ready', `voice is ${v.status}`);
        const text = String(body.text ?? '').trim();
        if (!text) return fail(res, 400, 'invalid_text', 'text is empty');
        const j = {
          id: crypto.randomUUID(), voice_id: v.id, text, settings: { speed: 0.9, ...(body.settings ?? {}) },
          callback_url: body.callback_url ?? null, idem: key ?? null, status: 'queued', error_code: null, revision: 1,
          doneRevision: 0, chars: [...text].length, audio_seconds: null, created_at: now(), finished_at: null,
          sentences: text.split(/(?<=[.!?])\s+/).filter(Boolean).map((t, i) => ({
            idx: i, paragraph_idx: 0, text: t, style: null, status: 'pending', takes: 0, score: null,
            duration_s: null, start_s: null, end_s: null, audio: false,
          })),
        };
        state.jobs.set(j.id, j);
        return json(res, 202, { id: j.id, sentences_total: j.sentences.length, estimated_seconds: 12 });
      }
      if (route.startsWith('/v1/jobs/:id')) {
        const j = state.jobs.get(id);
        if (!j) {
          req.resume();
          return fail(res, 404, 'not_found', 'job not found');
        }
        if (req.method === 'GET' && route === '/v1/jobs/:id') return json(res, 200, jobView(j));
        if (req.method === 'DELETE' && route === '/v1/jobs/:id') {
          state.jobs.delete(id);
          res.writeHead(204);
          return res.end();
        }
        if (req.method === 'GET' && route === '/v1/jobs/:id/sentences') return json(res, 200, j.sentences.map((s) => sentenceOut(j, s)));
        if (req.method === 'GET' && route === '/v1/jobs/:id/sentences/:idx/audio.wav') {
          const s = j.sentences.find((x) => x.idx === idx);
          if (!s?.audio) return fail(res, 404, 'not_found', 'sentence audio not found');
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': WAV_BYTES.length });
          return res.end(WAV_BYTES);
        }
        if (req.method === 'GET' && route === '/v1/jobs/:id/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.flushHeaders(); // Starlette's StreamingResponse sends headers before the first event
          const script = state.events.get(id) ?? [['job_done', { revision: j.revision }]];
          for (const [event, data] of script) {
            if (event === '__sleep') await sleep(data);
            else res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          }
          return res.end();
        }
        if (req.method === 'POST' && route === '/v1/jobs/:id/sentences/:idx/regenerate') {
          const body = await readJson(req);
          call.body = body;
          if (j.status !== 'done') return fail(res, 409, 'not_regeneratable', `job is ${j.status}; only finished jobs can be regenerated`);
          const s = j.sentences.find((x) => x.idx === idx);
          if (!s) return fail(res, 404, 'not_found', 'sentence not found');
          if (body.text !== undefined && body.text !== null) s.text = body.text;
          if (body.style !== undefined && body.style !== null) s.style = body.style || null;
          s.status = 'pending';
          j.revision += 1;
          j.status = 'queued';
          j.finished_at = null;
          return json(res, 202, { revision: j.revision });
        }
        if (req.method === 'POST' && route === '/v1/jobs/:id/cancel') {
          if (j.status === 'queued') {
            j.status = 'canceled';
            j.finished_at = now();
          } else if (j.status === 'running') {
            j.cancel_requested = true;
          }
          return json(res, 202, { status: 'cancel_requested' });
        }
        if (req.method === 'GET' && route.startsWith('/v1/jobs/:id/files/')) {
          const name = p.split('/').at(-1);
          const rev = Number(url.searchParams.get('revision')) || j.doneRevision;
          if (!FILE_TYPES[name] || !rev || rev > j.doneRevision) return fail(res, 404, 'not_found', 'file not found');
          const bytes = state.fileBytes;
          const headers = {
            'content-type': FILE_TYPES[name], 'accept-ranges': 'bytes',
            'content-disposition': `attachment; filename="${j.id}-r${rev}-${name}"`,
          };
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Number(range[2]) : bytes.length - 1;
            res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 });
            return res.end(bytes.subarray(start, end + 1));
          }
          res.writeHead(200, { ...headers, 'content-length': bytes.length });
          return res.end(bytes);
        }
      }
      return fail(res, 404, 'not_found', 'no such route');
    } catch (err) {
      return fail(res, 500, 'internal_error', String(err));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    addVoice,
    setJob,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
