/** Fixed windows per id (an account), in memory: one web process per environment. */
export function createRateLimiter({ limit = 60, windowMs = 60_000, now = Date.now } = {}) {
  const windows = new Map(); // id → { start, count }

  function prune(t) {
    for (const [id, w] of windows) if (t - w.start >= windowMs) windows.delete(id);
  }

  return {
    limit,
    hit(id) {
      const t = now();
      let w = windows.get(id);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.set(id, w);
        if (windows.size > 10_000) prune(t);
      }
      w.count += 1;
      if (w.count <= limit) return { ok: true };
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)) };
    },
    reset() {
      windows.clear();
    },
  };
}
