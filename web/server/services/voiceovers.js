import { ApiError } from '../lib/errors.js';
import { countChars, makeTitle } from '../lib/pricing.js';
import { engineError } from '../lib/upstream-errors.js';

/** Engine queue priority by source (the engine clamps to its 1-5 caller range): web first, API after; regenerate is 10. */
export const PRIORITY = Object.freeze({ web: 5, api: 1 });

export function readText(value, max) {
  if (typeof value !== 'string') throw new ApiError('invalid_request', 'text is required');
  const text = value.trim();
  const chars = countChars(text);
  if (chars > max) throw new ApiError('too_large', 'text exceeds 20,000 characters');
  return { text, chars };
}

/** The body of a voiceover create, checked the same way for POST /api/jobs and POST /v1/tts. */
export function readJobInput(body, maxChars) {
  const { voiceId, settings = {} } = body ?? {};
  const { text, chars } = readText(body?.text, maxChars);
  if (chars === 0) throw new ApiError('invalid_request', 'text is empty');
  if (typeof voiceId !== 'string') throw new ApiError('invalid_request', 'voiceId is required');
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new ApiError('invalid_request', 'settings must be an object');
  }
  return { text, chars, voiceId, settings };
}

/**
 * Holds the already inserted charge, queues the engine job and records it with the charge. `key` is the engine
 * Idempotency-Key and the middle of the hold ref. An engine refusal refunds the hold at once. `idemKey`, a claimed
 * /v1 Idempotency-Key, is bound to the job in the transaction that records it.
 */
export async function queueVoiceover(ctx, {
  charge, key, userId, voice, text, chars, settings, source = 'web', apiKeyId = null, webhookUrl = null, idemKey = null,
}) {
  const { charges, engine, jobsRepo, config } = ctx;
  await charges.hold(charge);
  let created;
  try {
    created = await engine.createJob({
      voiceId: voice.id, text, settings, callbackUrl: config.engineCallbackUrl, idempotencyKey: key, priority: PRIORITY[source],
    });
  } catch (err) {
    await charges.refundNow(charge);
    throw engineError(err);
  }
  await jobsRepo.insertWithCharge({
    id: created.id, userId, voiceId: voice.id, voiceName: voice.name, title: makeTitle(text), chars, chargeId: charge.id,
    source, apiKeyId, webhookUrl, idemKey,
  });
  return created;
}
