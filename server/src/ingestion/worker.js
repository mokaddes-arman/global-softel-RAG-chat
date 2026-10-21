'use strict';

const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const { query, dbKind } = require('../db');
const { processJob } = require('./pipeline');

/**
 * Database-backed background worker.
 *
 * Uses `SELECT ... FOR UPDATE SKIP LOCKED` to claim exactly one queued job at
 * a time, so no Redis or external queue is required. The worker runs inside the
 * API process by default and can also run standalone (`node src/ingestion/worker-cli.js`).
 */

let running = false;
let stopping = false;
let wake = null;
let activeLoops = 0;
let idleWaiters = [];
let lastRecoveryAt = 0;

function notifyWorker() {
  if (wake) wake();
}

function waitForWork(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, timeoutMs);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
}

/**
 * Re-queue jobs that were left in "processing" by a crash, a kill or a
 * machine that went down.
 *
 * `claimJob()` only picks up *queued* jobs, so an orphaned job would never be
 * attempted again and the document would stay "processing" forever. This
 * resets those jobs (and their document/version status) so the queue keeps
 * moving.
 */
async function recoverStaleJobs({ staleMs = config.ingestionStaleJobMs, reason } = {}) {
  const message = reason || 'The server restarted while this document was being indexed. It has been queued again.';
  const { rows } = await query(
    `UPDATE ingestion_jobs
        SET status = 'queued', stage = 'requeued', progress = 0, started_at = NULL,
            error = $2, error_code = 'ingestion_interrupted'
      WHERE status = 'processing'
        AND (started_at IS NULL OR started_at < now() - make_interval(secs => $1::double precision))
      RETURNING id, document_id, document_version_id`,
    [Math.max(1, Math.round(staleMs / 1000)), message],
  );
  if (!rows.length) return { recovered: 0 };

  for (const job of rows) {
    await query(`UPDATE document_versions SET status = 'pending', error = $2 WHERE id = $1 AND status = 'processing'`, [
      job.document_version_id,
      message,
    ]).catch(() => {});
    await query(
      `UPDATE documents SET status = 'pending', last_error = $2 WHERE id = $1 AND current_version_id = $2 AND status = 'processing'`,
      [job.document_id, message],
    ).catch(() => {});
  }

  logger.warn({ count: rows.length, jobIds: rows.map((r) => r.id) }, 're-queued orphaned ingestion jobs');
  return { recovered: rows.length };
}

async function claimJob() {
  const { rows } = await query(
    `UPDATE ingestion_jobs SET status = 'processing', stage = 'claimed', started_at = COALESCE(started_at, now())
     WHERE id = (
       SELECT id FROM ingestion_jobs
       WHERE status = 'queued'
          OR (status = 'processing'
              AND (started_at IS NULL OR started_at < now() - make_interval(secs => $1::double precision)))
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [Math.max(1, Math.round(config.ingestionStaleJobMs / 1000))],
  );
  return rows[0]?.id || null;
}

async function workerLoop(slot) {
  activeLoops += 1;
  logger.debug({ slot }, 'ingestion worker loop started');
  while (!stopping) {
    // Periodically look for jobs that were orphaned by a crash.
    if (Date.now() - lastRecoveryAt > 60000) {
      lastRecoveryAt = Date.now();
      await recoverStaleJobs().catch((err) => logger.error({ err: err.message }, 'stale job recovery failed'));
    }
    let jobId = null;
    try {
      jobId = await claimJob();
    } catch (err) {
      logger.error({ err: err.message }, 'worker could not claim a job');
      await waitForWork(3000);
      continue;
    }
    if (!jobId) {
      await waitForWork(2000);
      continue;
    }
    try {
      await processJob(jobId);
    } catch (err) {
      // processJob handles its own errors; this is a last-resort guard.
      logger.error({ err: err.message, jobId }, 'unexpected worker error');
    }
  }
  activeLoops -= 1;
  idleWaiters = idleWaiters.filter((fn) => {
    fn();
    return false;
  });
}

async function startWorker() {
  if (running) return;
  running = true;
  stopping = false;
  // Recover jobs that a previous run left in "processing" before claiming
  // anything new, so an interrupted upload does not stay stuck forever.
  await recoverStaleJobs().catch((err) => logger.error({ err: err.message }, 'startup job recovery failed'));
  // PGlite uses a single underlying connection, so parallel jobs would contend.
  const slots = dbKind() === 'pglite' ? 1 : Math.max(1, config.ingestionConcurrency);
  for (let i = 0; i < slots; i += 1) {
    workerLoop(i).catch((err) => logger.error({ err: err.message }, 'worker loop crashed'));
  }
  logger.info({ slots }, 'ingestion worker started');
}

async function stopWorker() {
  if (!running) return;
  stopping = true;
  notifyWorker();
  // Give loops a moment to observe the stop flag.
  await Promise.race([
    new Promise((resolve) => {
      if (activeLoops === 0) resolve();
      else idleWaiters.push(resolve);
    }),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  running = false;
  logger.info('ingestion worker stopped');
}

/** Wait until the queue is empty (test/diagnostic helper). */
async function drainQueue({ timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM ingestion_jobs WHERE status IN ('queued','processing')`,
    );
    if ((rows[0]?.n ?? 0) === 0) return true;
    if (Date.now() > deadline) return false;
    notifyWorker();
    await new Promise((r) => setTimeout(r, 150));
  }
}

module.exports = {
  startWorker,
  stopWorker,
  notifyWorker,
  drainQueue,
  claimJob,
  recoverStaleJobs,
  workerStatus: () => ({ running, activeLoops }),
};
