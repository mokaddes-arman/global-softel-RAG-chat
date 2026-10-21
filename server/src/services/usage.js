'use strict';

const { query } = require('../db');

/**
 * Per-model usage reporting.
 *
 * The numbers come from the app's own `messages` table: every completed
 * assistant answer records the concrete `model` and its `token_usage`. Because
 * providers report usage in different shapes (OpenAI-compatible:
 * prompt_tokens/completion_tokens, some gateways: input_tokens/output_tokens),
 * the SQL below coalesces the known keys so aggregation is provider-agnostic.
 */

const INPUT_TOKENS = `COALESCE(
  NULLIF(token_usage->>'prompt_tokens','')::numeric,
  NULLIF(token_usage->>'input_tokens','')::numeric,
  NULLIF(token_usage->>'input','')::numeric,
  NULLIF(token_usage->>'promptTokenCount','')::numeric,
  0)`;

const OUTPUT_TOKENS = `COALESCE(
  NULLIF(token_usage->>'completion_tokens','')::numeric,
  NULLIF(token_usage->>'output_tokens','')::numeric,
  NULLIF(token_usage->>'output','')::numeric,
  NULLIF(token_usage->>'candidatesTokenCount','')::numeric,
  NULLIF(token_usage->>'estimated_completion_tokens','')::numeric,
  0)`;

const TOTAL_TOKENS = `(${INPUT_TOKENS}) + (${OUTPUT_TOKENS})`;

const GRANULARITIES = new Set(['day', 'week', 'month', 'year']);

/** Character length of the bucket label for each granularity (YYYY-MM-DD, etc). */
function bucketLabel(value, granularity) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const iso = d.toISOString();
  if (granularity === 'year') return iso.slice(0, 4);
  if (granularity === 'month') return iso.slice(0, 7);
  return iso.slice(0, 10); // day + week start
}

/**
 * @param {object} p
 * @param {Date} p.from inclusive lower bound
 * @param {Date} p.to   inclusive upper bound
 * @param {string} [p.granularity] day|week|month|year
 * @param {string} [p.provider]
 * @param {string} [p.model]
 * @param {string} [p.projectId]
 */
async function modelUsage({ from, to, granularity = 'day', provider = null, model = null, projectId = null } = {}) {
  const unit = GRANULARITIES.has(granularity) ? granularity : 'day';

  const conditions = ["role = 'assistant'", "status = 'complete'", 'model IS NOT NULL', 'created_at >= $1', 'created_at <= $2'];
  const params = [from, to];
  if (provider) conditions.push(`provider = $${params.push(provider)}`);
  if (model) conditions.push(`model = $${params.push(model)}`);
  if (projectId) conditions.push(`project_id = $${params.push(projectId)}`);
  const where = conditions.join(' AND ');

  const [totalsRes, seriesRes] = await Promise.all([
    query(
      `SELECT model,
              MAX(provider) AS provider,
              COUNT(*)::int AS requests,
              COALESCE(SUM(${INPUT_TOKENS}),0)::bigint AS input_tokens,
              COALESCE(SUM(${OUTPUT_TOKENS}),0)::bigint AS output_tokens,
              COALESCE(SUM(${TOTAL_TOKENS}),0)::bigint AS total_tokens,
              MIN(created_at) AS first_used,
              MAX(created_at) AS last_used
       FROM messages
       WHERE ${where}
       GROUP BY model
       ORDER BY total_tokens DESC, requests DESC, model ASC`,
      params,
    ),
    // `date_trunc` accepts only a literal unit, hence the whitelisted `unit`.
    query(
      `SELECT model,
              MAX(provider) AS provider,
              date_trunc('${unit}', created_at) AS bucket,
              COUNT(*)::int AS requests,
              COALESCE(SUM(${INPUT_TOKENS}),0)::bigint AS input_tokens,
              COALESCE(SUM(${OUTPUT_TOKENS}),0)::bigint AS output_tokens
       FROM messages
       WHERE ${where}
       GROUP BY model, bucket
       ORDER BY bucket ASC`,
      params,
    ),
  ]);

  const num = (v) => Number(v) || 0;

  // Assemble per-model series keyed by bucket label.
  const labels = new Set();
  const byModel = new Map();
  for (const row of seriesRes.rows) {
    const label = bucketLabel(row.bucket, unit);
    labels.add(label);
    const key = row.model;
    if (!byModel.has(key)) byModel.set(key, {});
    byModel.get(key)[label] = {
      requests: num(row.requests),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      totalTokens: num(row.input_tokens) + num(row.output_tokens),
    };
  }

  const models = totalsRes.rows.map((row) => {
    const requests = num(row.requests);
    const inputTokens = num(row.input_tokens);
    const outputTokens = num(row.output_tokens);
    const totalTokens = num(row.total_tokens);
    return {
      model: row.model,
      provider: row.provider,
      requests,
      inputTokens,
      outputTokens,
      totalTokens,
      avgTokensPerRequest: requests ? Math.round(totalTokens / requests) : 0,
      firstUsed: row.first_used,
      lastUsed: row.last_used,
      perBucket: byModel.get(row.model) || {},
    };
  });

  const totals = models.reduce(
    (acc, m) => {
      acc.requests += m.requests;
      acc.inputTokens += m.inputTokens;
      acc.outputTokens += m.outputTokens;
      acc.totalTokens += m.totalTokens;
      return acc;
    },
    { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  totals.modelCount = models.length;
  totals.avgTokensPerRequest = totals.requests ? Math.round(totals.totalTokens / totals.requests) : 0;

  // Aggregate every model into one ordered series for the chart.
  const buckets = [...labels].sort().map((label) => {
    const agg = { label, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const m of models) {
      const b = m.perBucket[label];
      if (!b) continue;
      agg.requests += b.requests;
      agg.inputTokens += b.inputTokens;
      agg.outputTokens += b.outputTokens;
      agg.totalTokens += b.totalTokens;
    }
    return agg;
  });

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    granularity: unit,
    totals,
    buckets,
    models,
  };
}

module.exports = { modelUsage };
