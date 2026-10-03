import express from 'express';
import { ApiError } from '../lib/errors.js';

export function meRouter({ accounts, sessions }) {
  const router = express.Router();

  router.get('/me', async (req, res) => {
    res.json(await accounts.me(req.session));
  });

  router.patch('/me', async (req, res) => {
    const { lang } = req.body ?? {};
    if (lang !== 'id' && lang !== 'en') throw new ApiError('invalid_request', 'lang must be "id" or "en"');
    await sessions.setLang(req.session.user_id, lang);
    res.json(await accounts.me({ ...req.session, lang }));
  });

  return router;
}
