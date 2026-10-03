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
  log.info({ event: 'listening', host: config.host, port: config.port, schema: config.dbSchema }, 'lq-tts web listening');
});
server.requestTimeout = 30 * 60 * 1000; // 95 MB uploads on slow links
const reconciler = createReconciler(ctx, { intervalMs: config.reconcileIntervalMs });
reconciler.start();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info({ event: 'shutdown', signal }, 'shutting down');
  server.close();
  server.closeIdleConnections();
  await reconciler.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
