import { describe, expect, it } from 'vitest';
import { translate } from '../i18n/index.jsx';
import { errorText, jobFailureText, voiceErrorText } from './errors.js';

const t = (key, vars) => translate('en', key, vars);

describe('errorText', () => {
  it('uses the dictionary text for a known code', () => {
    expect(errorText(t, { code: 'invalid_credentials' })).toBe('Wrong email/username or password.');
    expect(errorText(t, { code: 'internal_error' })).toBe('Something went wrong on the server. Try again in a moment.');
  });
  it('includes the wait time for rate limits when known', () => {
    expect(errorText(t, { code: 'rate_limited', retryAfter: 30 })).toBe('Too many attempts. Try again in 30 seconds.');
    expect(errorText(t, { code: 'rate_limited', retryAfter: null })).toBe('Too many attempts. Try again in a moment.');
  });
  it('falls back to the generic text for unknown codes and non-API errors', () => {
    expect(errorText(t, { code: 'teapot' })).toBe('Something went wrong on our side. Please try again.');
    expect(errorText(t, new Error('boom'))).toBe('Something went wrong on our side. Please try again.');
  });
});

describe('voice and job failure texts', () => {
  it('explains engine voice error codes', () => {
    expect(voiceErrorText(t, 'no_clean_speech')).toMatch(/at least 8 seconds of clear speech/);
    expect(voiceErrorText(t, 'something_new')).toBe('The voice could not be processed. Try uploading it again.');
  });
  it('explains failed and canceled jobs with the refund', () => {
    expect(jobFailureText(t, 'failed', 'worker_crashed')).toMatch(/refunded/);
    expect(jobFailureText(t, 'canceled', null)).toBe('The job was canceled. Your credits were refunded.');
    expect(jobFailureText(t, 'failed', 'synthesis_failed', 3)).toBe(
      'This change failed. Only its credits were refunded; revision 2 is still available below.',
    );
    expect(jobFailureText(t, 'canceled', null, 2)).toBe(
      'This change was canceled. Only its credits were refunded; revision 1 is still available below.',
    );
    expect(jobFailureText(t, 'failed', null, 1)).toMatch(/^The job failed/);
    expect(jobFailureText(t, 'failed', null)).toBe('The job failed. Your credits were refunded.');
  });
});
