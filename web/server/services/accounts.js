import { UpstreamError } from '../clients/http.js';
import { ApiError } from '../lib/errors.js';
import { lqError } from '../lib/upstream-errors.js';

export const ME_CACHE_MS = 5 * 60 * 1000;

export function createAccounts({ sessions, lqstudio, engine, config }) {
  async function assertActive(user, userId) {
    if (user.suspended) {
      await sessions.revokeUser(userId);
      throw new ApiError('suspended', 'this account is suspended');
    }
    if (!user.verified) {
      await sessions.revokeUser(userId);
      throw new ApiError('needs_verification', 'finish verifying your email and phone on LQ-Studio');
    }
  }

  // Plan, paid flag and balance from LQ-Studio, cached on the session row for at most ME_CACHE_MS.
  async function fresh(session) {
    const age = Date.now() - new Date(session.refreshed_at).getTime();
    if (session.balance !== null && age < ME_CACHE_MS) return session;
    let user;
    try {
      user = await lqstudio.getUser(session.user_id);
    } catch (err) {
      if (err instanceof UpstreamError && err.code === 'not_found') {
        await sessions.revokeUser(session.user_id);
        throw new ApiError('unauthorized', 'account not found');
      }
      if (session.balance !== null) return session; // LQ-Studio down: keep serving the cached copy
      throw lqError(err);
    }
    await assertActive(user, session.user_id);
    return (await sessions.refresh(session.id, user)) ?? session;
  }

  const voiceLimit = (paid) => (paid ? config.voiceLimitPaid : config.voiceLimitFree);

  async function voiceCount(userId) {
    try {
      const voices = await engine.listVoices(userId);
      return voices.filter((v) => v.status === 'processing' || v.status === 'ready').length;
    } catch {
      return null;
    }
  }

  async function me(session) {
    const s = await fresh(session);
    return {
      id: s.user_id, name: s.name, email: s.email, plan: s.plan, paid: s.paid, lang: s.lang, balance: s.balance,
      voiceLimit: voiceLimit(s.paid), voiceCount: await voiceCount(s.user_id), topupUrl: config.topupUrl,
    };
  }

  return { fresh, assertActive, voiceLimit, voiceCount, me };
}
