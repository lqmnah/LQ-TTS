import { randomUUID } from 'node:crypto';
import path from 'node:path';
import busboy from 'busboy';
import express from 'express';
import { clientIp } from '../http/middleware.js';
import { relayEngine } from '../http/relay.js';
import { ApiError } from '../lib/errors.js';
import { engineError } from '../lib/upstream-errors.js';
import { ownVoice } from '../services/ownership.js';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac']);
const LANGUAGES = new Set(['id', 'en']);

export const toVoice = (v) => ({
  id: v.id, name: v.name, language: v.language, status: v.status, errorCode: v.error_code,
  refSeconds: v.ref_seconds, createdAt: v.created_at, previewUrl: v.preview_url ? `/api/voices/${v.id}/preview` : null,
});

// Parses the multipart body; onFile(fields, fileStream, info, signal) sees the fields that came before the file.
// The signal passed to onFile aborts when the browser goes away before the body is complete.
function receiveUpload(req, { maxBytes, onFile }) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: 10, fieldSize: 64 * 1024 } });
    } catch {
      reject(new ApiError('invalid_request', 'expected a multipart/form-data body'));
      return;
    }
    const fields = {};
    let work = null;
    const controller = new AbortController();
    // A pipe never ends busboy when its source is destroyed, so a dropped client would leave this pending forever.
    req.on('close', () => {
      if (req.complete) return;
      controller.abort();
      req.unpipe(bb);
      bb.destroy();
      reject(new ApiError('invalid_request', 'the upload was interrupted'));
    });
    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (name, file, info) => {
      // busboy destroys an unread file stream with an error when the client drops; unhandled, that kills the
      // process. The consumer in engine.uploadVoice still sees the error through its iterator.
      file.on('error', () => {});
      if (name !== 'audio' || work) {
        file.resume();
        return;
      }
      work = onFile(fields, file, info, controller.signal).catch((err) => {
        file.resume(); // drain the rest so the request can finish
        throw err;
      });
      work.catch(() => {});
    });
    bb.on('error', () => reject(new ApiError('invalid_request', 'malformed multipart body')));
    bb.on('close', () => {
      if (work) {
        work.then(resolve, reject);
        return;
      }
      reject(fields.consent === 'true'
        ? new ApiError('invalid_request', 'an audio file is required')
        : new ApiError('consent_required', 'consent is required to clone a voice'));
    });
    // The client may have left during the async middleware, before the close listener above existed.
    if (req.destroyed && !req.complete) {
      bb.destroy();
      reject(new ApiError('invalid_request', 'the upload was interrupted'));
      return;
    }
    req.pipe(bb);
  });
}

export function voicesRouter(ctx) {
  const { config, engine, accounts, pool, jobsRepo, charges, log } = ctx;
  const router = express.Router();

  // One upload per user at a time, so two parallel uploads cannot both pass the plan-limit check. A lease row
  // rather than a lock keeps no pooled connection pinned during a long upload, and it expires after a crash.
  async function withUploadLease(userId, work) {
    const token = randomUUID();
    const { rowCount } = await pool.query(
      `INSERT INTO upload_leases (user_id, token, until) VALUES ($1, $2, now() + interval '30 minutes')
       ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token, until = EXCLUDED.until
       WHERE upload_leases.until < now() RETURNING token`,
      [userId, token],
    );
    if (rowCount === 0) throw new ApiError('voice_not_ready', 'another voice upload is still in progress', { status: 409 });
    try {
      return await work();
    } finally {
      // Matching the token: a request whose lease expired never clears its successor's.
      await pool.query('DELETE FROM upload_leases WHERE user_id = $1 AND token = $2', [userId, token])
        .catch((err) => log.warn({ event: 'upload_lease_release_failed', userId, err: err.message }, 'could not release upload lease'));
    }
  }

  router.get('/voices', async (req, res) => {
    let voices;
    try {
      voices = await engine.listVoices(req.session.user_id);
    } catch (err) {
      throw engineError(err);
    }
    res.json(voices.map(toVoice));
  });

  router.post('/voices', async (req, res) => {
    if (!String(req.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
      throw new ApiError('invalid_request', 'expected multipart/form-data');
    }
    if (Number(req.headers['content-length'] ?? 0) > config.maxUploadBytes + 1024 * 1024) {
      throw new ApiError('too_large', `upload exceeds ${Math.floor(config.maxUploadBytes / 1048576)} MB`);
    }
    const userId = req.session.user_id;
    const ip = clientIp(req);
    const created = await receiveUpload(req, {
      maxBytes: config.maxUploadBytes,
      onFile: async (fields, file, { filename, mimeType }, signal) => {
        if (fields.consent !== 'true') throw new ApiError('consent_required', 'consent is required to clone a voice');
        const name = (fields.name ?? '').trim();
        if (!name || name.length > 80) throw new ApiError('invalid_request', 'name is required (at most 80 characters)');
        const language = fields.language && fields.language !== 'auto' ? fields.language : undefined;
        if (language !== undefined && !LANGUAGES.has(language)) throw new ApiError('invalid_request', 'language must be auto, id or en');
        const transcript = fields.transcript?.trim() || undefined;
        if (transcript && transcript.length > 5000) throw new ApiError('invalid_request', 'transcript is too long');
        if (!AUDIO_EXTS.has(path.extname(filename ?? '').toLowerCase())) {
          throw new ApiError('unsupported_audio', 'use MP3, WAV, M4A or FLAC');
        }
        const session = await accounts.fresh(req.session);
        return withUploadLease(userId, async () => {
          const count = await accounts.voiceCount(userId);
          if (count === null) throw new ApiError('engine_unavailable', 'the voice engine is unavailable, please try again');
          const limit = accounts.voiceLimit(session.paid);
          if (count >= limit) throw new ApiError('voice_limit_reached', `your plan keeps at most ${limit} voices`);
          try {
            return await engine.uploadVoice({ fields: { name, owner_ref: userId, language, transcript }, filename, mimeType, file, signal });
          } catch (err) {
            if (file.truncated) throw new ApiError('too_large', `upload exceeds ${Math.floor(config.maxUploadBytes / 1048576)} MB`);
            throw engineError(err);
          }
        });
      },
    });
    try {
      await pool.query(
        'INSERT INTO voice_consents (voice_id, user_id, ip, consent_version) VALUES ($1, $2, $3, $4)',
        [created.id, userId, ip, config.consentVersion],
      );
    } catch (err) {
      await engine.deleteVoice(created.id).catch(() => {}); // no consent record → no voice
      throw err;
    }
    res.status(202).json({ id: created.id, status: created.status });
  });

  router.get('/voices/:id/preview', async (req, res) => {
    const voice = await ownVoice(ctx, req.session.user_id, req.params.id);
    await relayEngine(ctx, req, res, `/v1/voices/${voice.id}/preview.wav`);
  });

  router.delete('/voices/:id', async (req, res) => {
    const userId = req.session.user_id;
    const voice = await ownVoice(ctx, userId, req.params.id);
    try {
      await engine.deleteVoice(voice.id);
    } catch (err) {
      throw engineError(err);
    }
    for (const jobId of await jobsRepo.markVoiceDeleted(userId, voice.id)) await charges.resolveJob(jobId, null);
    res.status(204).end();
  });

  return router;
}
