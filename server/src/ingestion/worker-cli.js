'use strict';

/**
 * Standalone worker process: `node src/ingestion/worker-cli.js`
 * Useful when you want ingestion to run separately from the API server.
 */
require('../config/env');
const { initDb, closeDb } = require('../db');
const { migrate } = require('../db/migrate');
const { logger } = require('../lib/logger');
const { startWorker, stopWorker } = require('./worker');

async function main() {
  await initDb();
  await migrate({ log: false });
  await startWorker();
  logger.info('Standalone ingestion worker running. Ctrl+C to stop.');

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down worker');
    await stopWorker();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err: err.message }, 'worker failed to start');
  process.exit(1);
});
