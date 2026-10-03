import { ApiError } from '../lib/errors.js';
import { ME_CACHE_MS } from '../services/accounts.js';

export const COOKIE = 'lqtts_sid';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readSessionCookie(req) {
  const match = /(?:^|;\s*)lqtts_sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '');
  return match ? match[1] : null;
}

export function setSessionCookie(res, raw, config) {
  res.cookie(COOKIE, raw, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: MAX_AGE_MS });
}

export function clearSessionCookie(res, config) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' });
}

export function clientIp(req) {
  const ip = req.get('cf-connecting-ip')?.trim() || req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function csrf(req, res, next) {
  if (SAFE_METHODS.has(req.method) || req.path === '/internal/engine-callback') return next();
  if (req.get('x-requested-with') !== 'lq-tts') {
    return next(new ApiError('invalid_request', 'missing X-Requested-With: lq-tts header', { status: 403 }));
  }
  return next();
}

export function requireAuth({ sessions, accounts, config }) {
  return async (req, res, next) => {
    const raw = readSessionCookie(req);
    const session = await sessions.find(raw);
    if (!session) {
      if (raw) clearSessionCookie(res, config);
      throw new ApiError('unauthorized', 'please log in');
    }
    if (await sessions.slide(session)) setSessionCookie(res, raw, config);
    // Once the account cache is due, every route re-checks it: tokenVersion, suspension and verification apply everywhere.
    const due = Date.now() - new Date(session.refreshed_at).getTime() >= ME_CACHE_MS;
    req.session = due ? await accounts.fresh(session) : session;
    req.sessionRaw = raw;
    next();
  };
}
