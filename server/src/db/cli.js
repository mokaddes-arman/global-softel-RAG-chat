'use strict';

/** CLI: `node src/db/cli.js migrate|status|rollback` */
require('../../src/config/env');

const { migrate, status, rollback } = require('./migrate');
const { closeDb } = require('./index');
const { logger } = require('../lib/logger');

async function main() {
  const cmd = process.argv[2] || 'migrate';
  try {
    if (cmd === 'migrate') {
      const res = await migrate();
      // eslint-disable-next-line no-console
      console.log(`\nMigration complete on ${res.backend}. Applied: ${res.applied.length ? res.applied.join(', ') : 'none (already up to date)'}`);
    } else if (cmd === 'status') {
      const res = await status();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'rollback') {
      if (process.env.CONFIRM_ROLLBACK !== 'yes') {
        // eslint-disable-next-line no-console
        console.error('Refusing to rollback without CONFIRM_ROLLBACK=yes. This drops all tables.');
        process.exitCode = 1;
        return;
      }
      await rollback();
      // eslint-disable-next-line no-console
      console.log('Rollback complete.');
    } else {
      // eslint-disable-next-line no-console
      console.error(`Unknown command: ${cmd}. Use migrate|status|rollback.`);
      process.exitCode = 1;
    }
  } catch (err) {
    logger.error({ err: err.message, code: err.code }, 'Database command failed');
    process.exitCode = 1;
  } finally {
    await closeDb().catch(() => {});
  }
}

main();
