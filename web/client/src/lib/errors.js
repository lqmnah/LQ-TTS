import { hasKey } from '../i18n/index.jsx';

const VOICE_ERRORS = new Set(['no_clean_speech', 'unsupported_audio', 'internal_error']);
const JOB_ERRORS = new Set(['synthesis_failed', 'worker_crashed', 'internal_error']);

/** Localized, actionable text for any thrown error (ApiError or otherwise). */
export function errorText(t, err) {
  const code = typeof err?.code === 'string' ? err.code : 'generic';
  if (code === 'rate_limited') {
    return err.retryAfter ? t('error.rate_limited', { seconds: err.retryAfter }) : t('error.rate_limited_later');
  }
  return hasKey(`error.${code}`) ? t(`error.${code}`) : t('error.generic');
}

/** Readable reason for a failed voice (engine `error_code`, spec §8.5). */
export function voiceErrorText(t, code) {
  return t(VOICE_ERRORS.has(code) ? `voices.error.${code}` : 'voices.error.unknown');
}

/**
 * Readable reason for a failed or canceled job. A first run is refunded in full (spec §4); a failed or
 * canceled regenerate (revision > 1) refunds only that change and keeps the previous revision.
 */
export function jobFailureText(t, status, code, revision = 1) {
  if (revision > 1) {
    return t(status === 'canceled' ? 'job.failed.change_canceled' : 'job.failed.change_failed', { n: revision - 1 });
  }
  if (status === 'canceled') return t('job.failed.canceled');
  return t(JOB_ERRORS.has(code) ? `job.failed.${code}` : 'job.failed.unknown');
}
