import { loadConfig } from './config.js';
import { createPool, migrate } from './db/pool.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbSchema, { max: 1 });
try {
  await migrate(pool, config.dbSchema);
  console.log(`migrated schema ${config.dbSchema}`);
} finally {
  await pool.end();
}
