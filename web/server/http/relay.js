import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { engineError } from '../lib/upstream-errors.js';

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'last-modified', 'etag'];

export async function relay(res, upstream) {
  res.status(upstream.status);
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader('cache-control', 'no-store');
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    res.destroy(); // the browser went away mid-download
  }
}

export async function relayEngine(ctx, req, res, enginePath) {
  const range = req.get('range');
  let upstream;
  try {
    upstream = await ctx.engine.stream(enginePath, { headers: range ? { range } : {} });
  } catch (err) {
    throw engineError(err);
  }
  await relay(res, upstream);
}
