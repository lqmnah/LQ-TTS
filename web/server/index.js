import { createApp } from './app.js';
import { createEngine } from './clients/engine.js';
import { createLqStudio } from './clients/lqstudio.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createPool, migrate } from './db/pool.js';
import { log } from './lib/log.js';
import { createReconciler } from './services/reconcile.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbSchema);
await migrate(pool, config.dbSchema); // every migration in db/migrations, in order, before listen

const ctx = createContext({
  config,
  pool,
  log,
  lqstudio: createLqStudio({ baseUrl: config.lqstudioUrl, token: config.lqstudioToken }),
  engine: createEngine({ baseUrl: config.engineUrl, token: config.engineToken }),
});
const server = createApp(ctx).listen(config.port, config.host, () => {
  log.info({ event: 'listening', host: config.host, port: server.address().port, schema: config.dbSchema }, 'lq-tts web listening');
});
server.requestTimeout = 30 * 60 * 1000; // 95 MB uploads on slow links
const reconciler = createReconciler(ctx, { intervalMs: config.reconcileIntervalMs });
reconciler.start();

const DRAIN_MS = 10_000;

// Stop accepting, let in-flight requests finish (a create cut off between the engine call and its charge row would
// leave an unbilled job), then stop the reconciler and the pool. A second signal exits at once.
let stopping = false;
async function shutdown(signal) {
  if (stopping) {
    log.warn({ event: 'shutdown_forced', signal }, 'second signal, exiting now');
    process.exit(1);
  }
  stopping = true;
  log.info({ event: 'shutdown', signal }, 'shutting down');
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  const sweep = setInterval(() => server.closeIdleConnections(), 100); // keep-alive sockets freed by finished requests
  const deadline = setTimeout(() => {
    log.warn({ event: 'shutdown_drain_timeout', ms: DRAIN_MS }, 'closing remaining connections');
    server.closeAllConnections(); // also ends open SSE streams
  }, DRAIN_MS);
  await closed;
  clearTimeout(deadline);
  clearInterval(sweep);
  await reconciler.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
