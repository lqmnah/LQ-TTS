import { UpstreamError } from '../clients/http.js';
import { ApiError } from '../lib/errors.js';
import { lqError } from '../lib/upstream-errors.js';
import { userTv } from './sessions.js';

export const ME_CACHE_MS = 5 * 60 * 1000;
export const OUTAGE_RETRY_MS = 60 * 1000;

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
      if (session.balance !== null) {
        // LQ-Studio down: serve the cached copy, and ask again only after OUTAGE_RETRY_MS so every route stays fast.
        return (await sessions.deferRefresh(session.id, session.user_id, ME_CACHE_MS, OUTAGE_RETRY_MS)) ?? session;
      }
      throw lqError(err);
    }
    await assertActive(user, session.user_id);
    // tokenVersion only rises (password change, "log out everywhere"): every refresh ends the sessions from before it,
    // whichever session asks, and an answer read before a bump can never end sessions opened after it.
    const tv = userTv(user);
    await sessions.revokeBeforeTv(session.user_id, tv);
    if (session.user_tv < tv) throw new ApiError('unauthorized', 'please log in again');
    // A lower tv is a read from before this session's login: serve the cache as is (this request only) and ask again
    // on the next one.
    if (session.user_tv > tv) return { ...session, refreshed_at: new Date() };
    return (await sessions.refresh(session.id, user, tv)) ?? session;
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
