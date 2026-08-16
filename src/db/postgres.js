// Durable persistence (Neon, ADR-0003). When DATABASE_URL is unset the exported
// db is a no-op recorder (dev/test, ADR-0005) so callers never branch.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));

let dbInstance = null;

function createNullDb() {
  // Records writes in memory so tests can assert persistence calls happened.
  const writes = [];
  return {
    kind: 'null',
    writes,
    async migrate() {},
    async query(text, params) {
      writes.push({ text, params });
      return { rows: [] };
    },
    async close() {},
  };
}

async function createPgDb(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? undefined : { rejectUnauthorized: false },
    max: 5,
  });
  pool.on('error', (err) => logger.error('pg pool error', { error: err.message }));
  return {
    kind: 'pg',
    async migrate() {
      const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
      await pool.query(sql);
      logger.info('db migrated');
    },
    query: (text, params) => pool.query(text, params),
    close: () => pool.end(),
  };
}

export async function getDb() {
  if (!dbInstance) {
    dbInstance = config.databaseUrl ? await createPgDb(config.databaseUrl) : createNullDb();
    logger.info('db initialized', { kind: dbInstance.kind });
  }
  return dbInstance;
}

export async function closeDb() {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}

export function _resetDbForTests(db) {
  dbInstance = db ?? null;
}
