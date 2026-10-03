import { createAccounts } from './services/accounts.js';
import { createSessionStore } from './services/sessions.js';

export function createContext({ config, pool, lqstudio, engine, log }) {
  const ctx = { config, pool, lqstudio, engine, log };
  ctx.sessions = createSessionStore(pool);
  ctx.accounts = createAccounts(ctx);
  return ctx;
}
