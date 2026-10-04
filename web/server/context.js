import { createAccounts } from './services/accounts.js';
import { createApiAccounts } from './services/api-accounts.js';
import { createApiJobs } from './services/api-jobs.js';
import { createApiKeys } from './services/api-keys.js';
import { createCharges } from './services/charges.js';
import { createJobControl } from './services/job-control.js';
import { createJobsRepo } from './services/jobs-repo.js';
import { createProfiles } from './services/profiles.js';
import { createRateLimiter } from './services/rate-limit.js';
import { createSessionStore } from './services/sessions.js';

export function createContext({ config, pool, lqstudio, engine, log }) {
  const ctx = { config, pool, lqstudio, engine, log };
  ctx.apiKeys = createApiKeys(ctx);
  ctx.sessions = createSessionStore(pool);
  ctx.accounts = createAccounts(ctx);
  ctx.apiAccounts = createApiAccounts(ctx);
  ctx.apiLimiter = createRateLimiter();
  ctx.jobsRepo = createJobsRepo(pool);
  ctx.profiles = createProfiles(pool);
  ctx.charges = createCharges(ctx);
  ctx.jobControl = createJobControl(ctx);
  ctx.apiJobs = createApiJobs(pool);
  return ctx;
}
