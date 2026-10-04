import { UpstreamError } from '../clients/http.js';
import { lqError } from '../lib/upstream-errors.js';
import { ME_CACHE_MS, OUTAGE_RETRY_MS } from './accounts.js';

const MAX_CACHED = 10_000;

/**
 * LQ-Studio's view of API callers (plan, paid, suspension, verification, tokenVersion), cached per user for at most
 * ME_CACHE_MS like web sessions, in memory (one web process per environment). While LQ-Studio is unreachable the
 * cached copy is served and asked again only after OUTAGE_RETRY_MS. `get` answers null when LQ-Studio no longer
 * knows the user. `cache` is exposed for tests and operations (clearing it forces a re-read).
 */
export function createApiAccounts({ lqstudio }, { now = Date.now } = {}) {
  const cache = new Map(); // userId → { user, at }

  async function get(userId) {
    const hit = cache.get(userId);
    if (hit && now() - hit.at < ME_CACHE_MS) return hit.user;
    let user;
    try {
      user = await lqstudio.getUser(userId);
    } catch (err) {
      if (err instanceof UpstreamError && err.code === 'not_found') {
        cache.delete(userId);
        return null;
      }
      if (hit) {
        hit.at = now() - ME_CACHE_MS + OUTAGE_RETRY_MS;
        return hit.user;
      }
      throw lqError(err);
    }
    cache.delete(userId); // re-inserted last: Map order is the eviction order
    cache.set(userId, { user, at: now() });
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    return user;
  }

  return { get, cache };
}
