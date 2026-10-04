import { UpstreamError } from '../clients/http.js';
import { ApiError } from './errors.js';

const LQ_MESSAGES = {
  invalid_credentials: 'wrong email/username or password',
  invalid_code: 'wrong or expired code',
  suspended: 'this account is suspended',
  insufficient_credits: 'not enough credits — top up on LQ-Studio',
};

export function lqError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof UpstreamError) {
    if (err.code === 'rate_limited') {
      const wait = Number(err.body?.retryAfter) || 60;
      return new ApiError('rate_limited', `too many attempts, try again in ${wait} s`, { headers: { 'retry-after': String(wait) } });
    }
    if (LQ_MESSAGES[err.code]) {
      // LQ-Studio's 402 carries the balance (contract C1); /v1 also adds topupUrl.
      const balance = err.code === 'insufficient_credits' && Number.isFinite(err.body?.balance) ? { balance: err.body.balance } : {};
      return new ApiError(err.code, LQ_MESSAGES[err.code], { details: balance });
    }
  }
  return new ApiError('lqstudio_unavailable', 'LQ-Studio is temporarily unavailable');
}

const ENGINE_CODES = {
  not_found: 'not_found',
  voice_not_ready: 'voice_not_ready',
  not_regeneratable: 'not_regeneratable',
  too_large: 'too_large',
  unsupported_audio: 'unsupported_audio',
  invalid_text: 'invalid_request',
  invalid_settings: 'invalid_request',
  invalid_request: 'invalid_request',
};

export function engineError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof UpstreamError && ENGINE_CODES[err.code]) return new ApiError(ENGINE_CODES[err.code], err.message);
  return new ApiError('engine_unavailable', 'the voice engine is unavailable, please try again');
}

export const isEngineNotFound = (err) => err instanceof UpstreamError && err.status === 404;
