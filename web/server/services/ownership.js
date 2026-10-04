import { ApiError } from '../lib/errors.js';
import { engineError } from '../lib/upstream-errors.js';
import { LIBRARY_OWNER } from './profiles.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value) => typeof value === 'string' && UUID.test(value);

export async function ownVoice({ engine }, userId, voiceId) {
  if (!isUuid(voiceId)) throw new ApiError('not_found', 'voice not found');
  let voice;
  try {
    voice = await engine.getVoice(voiceId.toLowerCase());
  } catch (err) {
    throw engineError(err);
  }
  if (voice.owner_ref !== String(userId)) throw new ApiError('not_found', 'voice not found');
  return voice;
}

/**
 * A voice the user may preview and voice over with: their own, or an active VO Profile (library voice).
 * With `api`, a profile must also be allowed for the API (voice_profiles.api_allowed).
 */
export async function usableVoice(ctx, userId, voiceId, { api = false } = {}) {
  if (!isUuid(voiceId)) throw new ApiError('not_found', 'voice not found');
  let voice;
  try {
    voice = await ctx.engine.getVoice(voiceId.toLowerCase());
  } catch (err) {
    throw engineError(err);
  }
  if (voice.owner_ref === String(userId)) return voice;
  if (voice.owner_ref === LIBRARY_OWNER) {
    const profile = await ctx.profiles.get(voice.id);
    if (profile && (!api || profile.api_allowed)) return voice;
  }
  throw new ApiError('not_found', 'voice not found');
}

export async function ownJob({ jobsRepo }, userId, jobId) {
  if (!isUuid(jobId)) throw new ApiError('not_found', 'job not found');
  const job = await jobsRepo.own(userId, jobId.toLowerCase());
  if (!job) throw new ApiError('not_found', 'job not found');
  return job;
}

export function parseIdx(raw) {
  if (!/^\d{1,6}$/.test(String(raw))) throw new ApiError('not_found', 'sentence not found');
  return Number(raw);
}
