import { useEffect, useState } from 'react';
import { api } from './api.js';

/** Polls GET /api/health while the tab is visible (spec §8.1 and §8.4 banners). */
export function useHealth(intervalMs = 15000) {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    let stopped = false;
    let timer;
    async function tick() {
      if (document.visibilityState !== 'hidden') {
        try {
          const next = await api.health();
          if (!stopped) setHealth(next);
        } catch {
          if (!stopped) setHealth(null);
        }
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [intervalMs]);
  return health;
}
