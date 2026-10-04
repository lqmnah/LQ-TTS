import express from 'express';
import { ApiError } from '../lib/errors.js';
import { toApiKey } from '../services/api-keys.js';
import { isUuid } from '../services/ownership.js';

const MAX_NAME = 60; // code points, as the api_keys CHECK counts them

export function apiKeysRouter(ctx) {
  const { accounts, apiKeys } = ctx;
  const router = express.Router();

  router.get('/keys', async (req, res) => {
    const keys = await apiKeys.list(req.session.user_id);
    res.set('Cache-Control', 'no-store').json({ keys: keys.map(toApiKey) });
  });

  router.post('/keys', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || [...name].length > MAX_NAME) throw new ApiError('invalid_request', `name is required (at most ${MAX_NAME} characters)`);
    const session = await accounts.fresh(req.session);
    if (!session.paid) throw new ApiError('plan_required', 'API keys need a Pro, Ultra or Sultan plan');
    const { row, key, webhookSecret } = await apiKeys.create(session.user_id, { name, tv: session.user_tv });
    res.status(201).set('Cache-Control', 'no-store').json({ ...toApiKey(row), key, webhookSecret });
  });

  router.delete('/keys/:id', async (req, res) => {
    if (!isUuid(req.params.id) || !(await apiKeys.revoke(req.session.user_id, req.params.id.toLowerCase()))) {
      throw new ApiError('not_found', 'API key not found');
    }
    res.status(204).end();
  });

  return router;
}
