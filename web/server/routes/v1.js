import express from 'express';
import { requireApiKey } from '../http/api-auth.js';
import { ApiError } from '../lib/errors.js';
import { engineError } from '../lib/upstream-errors.js';
import { profilesWithVoices } from '../services/profiles.js';

export function v1Router(ctx) {
  const { engine } = ctx;
  const router = express.Router();
  router.use(requireApiKey(ctx));
  router.use(express.json({ limit: '256kb' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/voices', async (req, res) => {
    let own;
    try {
      own = await engine.listVoices(req.apiUserId);
    } catch (err) {
      throw engineError(err);
    }
    const profiles = await profilesWithVoices(ctx);
    res.json({
      voices: [
        ...own.filter((v) => v.status === 'ready').map((v) => ({ id: v.id, name: v.name, language: v.language, kind: 'own' })),
        ...profiles.filter(({ row, voice }) => row.api_allowed && voice?.status === 'ready').map(({ row }) => ({
          id: row.voice_id, name: row.name, language: row.language, kind: 'profile',
          description: { id: row.description_id, en: row.description_en },
        })),
      ],
    });
  });

  router.use(() => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  return router;
}
