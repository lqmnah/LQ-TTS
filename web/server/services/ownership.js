import { ApiError } from '../lib/errors.js';
import { engineError } from '../lib/upstream-errors.js';

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
