import express from 'express';
import { clearSessionCookie, clientIp, readSessionCookie, setSessionCookie } from '../http/middleware.js';
import { ApiError } from '../lib/errors.js';
import { lqError } from '../lib/upstream-errors.js';
import { hashSessionId, userTv } from '../services/sessions.js';

const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

export function authRouter(ctx) {
  const { lqstudio, sessions, accounts, config } = ctx;
  const router = express.Router();
  const needsVerification = { status: 'needs_verification', verifyUrl: config.verifyUrl };

  async function startSession(req, res, user) {
    let full;
    try {
      full = await lqstudio.getUser(user.id);
    } catch (err) {
      throw lqError(err);
    }
    if (!full.verified) return needsVerification;
    await accounts.assertActive(full, String(user.id));
    // tokenVersion moved after verify (password change, "log out everywhere"): the credential just checked is void.
    const tv = userTv(user);
    if (userTv(full) > tv) throw new ApiError('invalid_credentials', 'your password changed, please log in again');
    // The session carries the tv of the verified login.
    const { raw, session } = await sessions.create({ ...user, ...full, tv }, full.balance);
    // The browser's previous session ends here instead of living on unseen for 30 days.
    const replaced = readSessionCookie(req);
    if (replaced) await sessions.revoke(hashSessionId(replaced));
    setSessionCookie(res, raw, config);
    return { status: 'ok', user: await accounts.me(session) };
  }

  async function answer(req, res, out) {
    if (out?.status === 'need_2fa') return res.json({ status: 'need_2fa', challenge: out.challenge });
    if (out?.status === 'needs_verification') return res.json(needsVerification);
    if (out?.status !== 'ok' || !out.user) throw new ApiError('lqstudio_unavailable', 'unexpected answer from LQ-Studio');
    return res.json(await startSession(req, res, out.user));
  }

  router.post('/auth/login', async (req, res) => {
    const { identifier, password } = req.body ?? {};
    if (!isText(identifier, 200) || !isText(password, 200)) throw new ApiError('invalid_request', 'identifier and password are required');
    let out;
    try {
      out = await lqstudio.verify({ identifier: identifier.trim(), password, ip: clientIp(req) });
    } catch (err) {
      throw lqError(err);
    }
    await answer(req, res, out);
  });

  router.post('/auth/2fa', async (req, res) => {
    const { challenge } = req.body ?? {};
    const code = typeof req.body?.code === 'number' ? String(req.body.code) : req.body?.code;
    if (!isText(challenge, 1000) || !isText(code, 64)) throw new ApiError('invalid_request', 'challenge and code are required');
    let out;
    try {
      out = await lqstudio.verify2fa({ challenge, code: code.trim(), ip: clientIp(req) });
    } catch (err) {
      throw lqError(err);
    }
    await answer(req, res, out);
  });

  router.post('/auth/logout', async (req, res) => {
    const raw = readSessionCookie(req);
    if (raw) await sessions.revoke(hashSessionId(raw));
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  return router;
}
