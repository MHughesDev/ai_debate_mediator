import http from 'node:http';
import { config, bootWarnings } from './config.js';
import { logger } from './logger.js';
import { createApp } from './server.js';
import { attachWsHub } from './ws/hub.js';
import { getDb, closeDb } from './db/postgres.js';
import { getStore, closeStore } from './state/store.js';
import { stopAllMocks } from './mock/generator.js';
import { stopAllPipelines } from './pipeline/runtime.js';

async function main() {
  for (const w of bootWarnings()) logger.warn(w);

  await getStore();
  const db = await getDb();
  await db.migrate();

  const app = createApp();
  const server = http.createServer(app);
  const hub = attachWsHub(server);

  server.listen(config.port, () => {
    logger.info('listening', { port: config.port });
  });

  // Design contract #6: SIGTERM -> stop intake, flush hot state, close (~10s window).
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown started', { signal });
    const deadline = setTimeout(() => {
      logger.error('shutdown deadline exceeded, exiting');
      process.exit(1);
    }, 9000);
    try {
      stopAllMocks();
      await stopAllPipelines(); // flushes transcript buffers / in-flight state to Redis
      await hub.close();
      await new Promise((resolve) => server.close(resolve));
      await closeDb();
      await closeStore();
      clearTimeout(deadline);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('shutdown error', { error: err.message });
      process.exit(1);
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('fatal boot error', { error: err.message, stack: err.stack });
  process.exit(1);
});
