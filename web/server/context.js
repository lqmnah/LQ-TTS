import { createAccounts } from './services/accounts.js';
import { createApiKeys } from './services/api-keys.js';
import { createCharges } from './services/charges.js';
import { createJobsRepo } from './services/jobs-repo.js';
import { createProfiles } from './services/profiles.js';
import { createSessionStore } from './services/sessions.js';

export function createContext({ config, pool, lqstudio, engine, log }) {
  const ctx = { config, pool, lqstudio, engine, log };
  ctx.apiKeys = createApiKeys(ctx);
  ctx.sessions = createSessionStore(pool);
  ctx.accounts = createAccounts(ctx);
  ctx.jobsRepo = createJobsRepo(pool);
  ctx.profiles = createProfiles(pool);
  ctx.charges = createCharges(ctx);
  return ctx;
}
