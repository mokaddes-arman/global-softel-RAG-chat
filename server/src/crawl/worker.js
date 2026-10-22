'use strict';

const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const { query, dbKind } = require('../db');
const { processCrawlJob } = require('./pipeline');

/**
 * Database-backed crawl worker.
 *
 * Mirrors the ingestion worker: exactly one queued crawl job is claimed at a
 * time with `FOR UPDATE SKIP LOCKED`, so no Redis or external queue is needed.
 * A job that was interrupted by a crash is re-queued instead of staying
 * "processing" forever.
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

/** Re-queue crawl jobs that a crash left in "processing". */
async function recoverStaleJobs({ staleMs = config.crawl.staleJobMs } = {}) {
  const message = 'The server restarted while this page was being crawled. It has been queued again.';
  const { rows } = await query(
    `UPDATE crawl_jobs
        SET status = 'queued', stage = 'requeued', progress = 0, started_at = NULL,
            error = $2, error_code = 'crawl_interrupted'
      WHERE status = 'processing'
        AND (started_at IS NULL OR started_at < now() - make_interval(secs => $1::double precision))
      RETURNING id, web_link_id`,
    [Math.max(1, Math.round(staleMs / 1000)), message],
  );
  if (!rows.length) return { recovered: 0 };
  for (const job of rows) {
    await query(`UPDATE web_links SET status = 'pending', last_error = $2 WHERE id = $1 AND status = 'crawling'`, [
      job.web_link_id,
      message,
    ]).catch(() => {});
  }
  logger.warn({ count: rows.length, jobIds: rows.map((r) => r.id) }, 're-queued orphaned crawl jobs');
  return { recovered: rows.length };
}

async function claimJob() {
  const { rows } = await query(
    `UPDATE crawl_jobs SET status = 'processing', stage = 'claimed', started_at = COALESCE(started_at, now())
     WHERE id = (
       SELECT id FROM crawl_jobs
       WHERE status = 'queued'
          OR (status = 'processing'
              AND (started_at IS NULL OR started_at < now() - make_interval(secs => $1::double precision)))
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [Math.max(1, Math.round(config.crawl.staleJobMs / 1000))],
  );
  return rows[0]?.id || null;
}

async function workerLoop(slot) {
  activeLoops += 1;
  logger.debug({ slot }, 'crawl worker loop started');
  while (!stopping) {
    if (Date.now() - lastRecoveryAt > 60000) {
      lastRecoveryAt = Date.now();
      await recoverStaleJobs().catch((err) => logger.error({ err: err.message }, 'stale crawl job recovery failed'));
    }
    let jobId = null;
    try {
      jobId = await claimJob();
    } catch (err) {
      logger.error({ err: err.message }, 'crawl worker could not claim a job');
      await waitForWork(3000);
      continue;
    }
    if (!jobId) {
      await waitForWork(2000);
      continue;
    }
    try {
      await processCrawlJob(jobId);
    } catch (err) {
      logger.error({ err: err.message, jobId }, 'unexpected crawl worker error');
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
  await recoverStaleJobs().catch((err) => logger.error({ err: err.message }, 'startup crawl job recovery failed'));
  const slots = dbKind() === 'pglite' ? 1 : Math.max(1, config.crawl.concurrency);
  for (let i = 0; i < slots; i += 1) {
    workerLoop(i).catch((err) => logger.error({ err: err.message }, 'crawl worker loop crashed'));
  }
  logger.info({ slots }, 'crawl worker started');
}

async function stopWorker() {
  if (!running) return;
  stopping = true;
  notifyWorker();
  await Promise.race([
    new Promise((resolve) => {
      if (activeLoops === 0) resolve();
      else idleWaiters.push(resolve);
    }),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  running = false;
  logger.info('crawl worker stopped');
}

/** Wait until no crawl job is queued or running (test/diagnostic helper). */
async function drainQueue({ timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM crawl_jobs WHERE status IN ('queued','processing')`);
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
