import express from 'express';
import { engineError } from '../lib/upstream-errors.js';
import { ownJob } from '../services/ownership.js';

export function translateEvent(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  let payload;
  try {
    payload = JSON.parse(data.join('\n'));
  } catch {
    return null;
  }
  if (event === 'job_failed') payload = { status: payload.status, errorCode: payload.error_code ?? null };
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function eventsRouter(ctx, { keepaliveMs = 15000 } = {}) {
  const router = express.Router();
  router.get('/jobs/:id/events', async (req, res) => {
    // Listen before any await: a client that leaves during the ownership check must not open an engine stream.
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const job = await ownJob(ctx, req.session.user_id, req.params.id);
    if (abort.signal.aborted || res.destroyed) return;
    let upstream;
    try {
      upstream = await ctx.engine.stream(`/v1/jobs/${job.id}/events`, { signal: abort.signal, sse: true });
    } catch (err) {
      throw engineError(err);
    }
    res.status(200).set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const keepalive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
    }, keepaliveMs);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          const out = translateEvent(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
          if (out && !res.destroyed) res.write(out);
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // the browser or the engine went away; the browser's EventSource reconnects
    } finally {
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
    }
  });
  return router;
}
