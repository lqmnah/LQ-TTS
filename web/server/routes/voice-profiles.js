import express from 'express';
import { profilesWithVoices } from '../services/profiles.js';

const toProfile = (row, voice) => ({
  id: row.voice_id,
  slug: row.slug,
  name: row.name,
  gender: row.gender,
  language: row.language,
  status: voice?.status ?? null,
  errorCode: voice?.error_code ?? null,
  description: { id: row.description_id, en: row.description_en },
  tags: row.tags,
  bestFor: { id: row.best_for_id, en: row.best_for_en },
  previewUrl: `/api/voices/${row.voice_id}/preview`,
});

export function voiceProfilesRouter(ctx) {
  const router = express.Router();
  router.get('/voice-profiles', async (req, res) => {
    const list = await profilesWithVoices(ctx);
    res.set('Cache-Control', 'no-store').json(list.map(({ row, voice }) => toProfile(row, voice)));
  });
  return router;
}
