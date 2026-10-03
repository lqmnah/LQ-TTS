import express from 'express';

export function healthRouter({ engine, lqstudio, config }, { cacheMs = 10000 } = {}) {
  const router = express.Router();
  let cached = null;
  router.get('/health', async (req, res) => {
    if (!cached || Date.now() - cached.at >= cacheMs) {
      cached = {
        at: Date.now(),
        value: Promise.all([engine.health(), lqstudio.ping()])
          .then(([e, l]) => ({ engine: e, lqstudio: l ? 'ok' : 'down', signupUrl: config.signupUrl })),
      };
    }
    res.set('cache-control', 'no-store').json(await cached.value);
  });
  return router;
}
