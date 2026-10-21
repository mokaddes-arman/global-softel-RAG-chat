'use strict';

/**
 * Server entry point.
 * Boots the database, applies migrations, starts the in-process ingestion
 * worker and begins listening. Binds to HOST (localhost by default) so the
 * application is not exposed to the network unless explicitly configured.
 */
require('./config/env');
const { config, ensureRuntimeDirs, getMasterKey } = require('./config/env');
const { logger } = require('./lib/logger');
const { createApp } = require('./app');
const { initDb, closeDb, dbKind } = require('./db');
const { migrate } = require('./db/migrate');
const { startWorker, stopWorker } = require('./ingestion/worker');

async function bootstrap() {
  ensureRuntimeDirs();

  if (!getMasterKey()) {
    logger.warn(
      'APP_MASTER_KEY is not set. Provider API keys cannot be encrypted and saving a provider configuration will fail. ' +
        'Set APP_MASTER_KEY in .env before configuring providers.',
    );
  }

  await initDb();
  await migrate();
  logger.info({ backend: dbKind() }, 'database ready');

  await startWorker();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info(
      { url: `http://${config.host}:${config.port}`, env: config.nodeEnv },
      'Global Softel RAG Chat API listening',
    );
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await stopWorker().catch(() => {});
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ err: String(reason) }, 'unhandled promise rejection'));

  return server;
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error({ err: err.message, code: err.code }, 'failed to start server');
    process.exit(1);
  });
}

module.exports = { bootstrap };
