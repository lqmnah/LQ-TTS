import express from 'express';
import { csrf, requireAuth } from './http/middleware.js';
import { ApiError, errorHandler } from './lib/errors.js';
import { apiKeysRouter } from './routes/api-keys.js';
import { authRouter } from './routes/auth.js';
import { callbackRouter } from './routes/callback.js';
import { creditsRouter } from './routes/credits.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { jobActionsRouter } from './routes/job-actions.js';
import { jobsRouter } from './routes/jobs.js';
import { meRouter } from './routes/me.js';
import { mountClient } from './routes/static.js';
import { voicesRouter } from './routes/voices.js';
import { voiceProfilesRouter } from './routes/voice-profiles.js';

export function createApp(ctx, { healthCacheMs = 10000, sseKeepaliveMs = 15000 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Deny framing only; no other CSP directives, so Cloudflare's injected analytics beacon keeps working.
  app.use((req, res, next) => {
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    res.set('X-Frame-Options', 'DENY');
    next();
  });
  app.use('/api', callbackRouter(ctx));
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api', csrf);
  app.use('/api', healthRouter(ctx, { cacheMs: healthCacheMs }));
  app.use('/api', authRouter(ctx));
  app.use('/api', requireAuth(ctx));
  app.use('/api', meRouter(ctx));
  app.use('/api', voicesRouter(ctx));
  app.use('/api', voiceProfilesRouter(ctx));
  app.use('/api', jobsRouter(ctx));
  app.use('/api', jobActionsRouter(ctx));
  app.use('/api', eventsRouter(ctx, { keepaliveMs: sseKeepaliveMs }));
  app.use('/api', creditsRouter(ctx));
  app.use('/api', apiKeysRouter(ctx));
  app.use('/api', () => {
    throw new ApiError('not_found', 'no such endpoint');
  });
  mountClient(app, ctx.config.clientDist);
  app.use(errorHandler(ctx.log));
  return app;
}
