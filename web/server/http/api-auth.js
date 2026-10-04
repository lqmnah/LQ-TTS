import { ApiError } from '../lib/errors.js';
import { userTv } from '../services/sessions.js';

const BEARER = /^Bearer +(\S+)$/i;

/**
 * /v1 authentication: `Authorization: Bearer lqtts_<key_id>_<secret>` only; cookies are never read. Then the
 * per-account rate limit, then the account rules (≤ 5-minute LQ-Studio cache): suspension, a plan below Pro and a
 * newer tokenVersion revoke the account's keys; unverified is refused without revoking.
 */
export function requireApiKey({ apiKeys, apiAccounts, apiLimiter }) {
  return async (req, res, next) => {
    const raw = BEARER.exec(req.get('authorization') ?? '')?.[1];
    const key = raw ? await apiKeys.find(raw) : null;
    if (!key) throw new ApiError('unauthorized', 'missing, invalid or revoked API key');
    const userId = key.user_id;
    const hit = apiLimiter.hit(userId);
    if (!hit.ok) {
      throw new ApiError('rate_limited', `at most ${apiLimiter.limit} requests a minute; try again in ${hit.retryAfterS} s`, {
        headers: { 'retry-after': String(hit.retryAfterS) },
      });
    }
    const user = await apiAccounts.get(userId);
    if (user === null) {
      await apiKeys.autoRevoke(userId, 'account_gone');
      throw new ApiError('unauthorized', 'account not found');
    }
    if (user.suspended) {
      await apiKeys.autoRevoke(userId, 'suspended');
      apiAccounts.evict(userId); // a key made after the suspension is lifted must not meet this stale copy
      throw new ApiError('suspended', 'this account is suspended');
    }
    if (!user.verified) throw new ApiError('needs_verification', 'finish verifying your email and phone on LQ-Studio');
    const tv = userTv(user);
    if (tv > key.tv) {
      await apiKeys.autoRevoke(userId, 'tv', { belowTv: tv });
      throw new ApiError('unauthorized', 'this API key was revoked: the password changed or every session was logged out');
    }
    if (!user.paid) {
      await apiKeys.autoRevoke(userId, 'plan');
      apiAccounts.evict(userId); // likewise after a renewal
      throw new ApiError('plan_required', 'the API needs a Pro, Ultra or Sultan plan');
    }
    await apiKeys.touch(key);
    req.apiKey = key;
    req.apiUserId = userId;
    next();
  };
}
