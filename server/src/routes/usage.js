'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateQuery } = require('../middleware/validate');
const usage = require('../services/usage');
const providersService = require('../services/providers');

const router = express.Router();

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an ISO date or datetime. Date-only values span the whole day. */
function parseBound(value, fallback, { endOfDay = false } = {}) {
  if (!value) return fallback;
  if (DATE_ONLY.test(value)) {
    const d = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return fallback;
    if (endOfDay) d.setUTCHours(23, 59, 59, 999);
    return d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

const usageQuerySchema = z.object({
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  granularity: z.enum(['day', 'week', 'month', 'year']).optional().default('day'),
  provider: z.string().trim().max(100).optional(),
  model: z.string().trim().max(200).optional(),
  projectId: z.string().uuid().optional(),
});

router.get(
  '/model-usage',
  validateQuery(usageQuerySchema),
  asyncHandler(async (req, res) => {
    const q = req.validatedQuery;
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = parseBound(q.from, defaultFrom);
    let to = parseBound(q.to, now, { endOfDay: true });
    if (to < from) to = from;
    const result = await usage.modelUsage({
      from,
      to,
      granularity: q.granularity,
      provider: q.provider || null,
      model: q.model || null,
      projectId: q.projectId || null,
    });
    res.json(result);
  }),
);

/**
 * Catalog of the models this deployment can use.
 *
 * It is based on the provider configurations stored in the database (the
 * settings the operator made), not on the ambient environment, so the answer
 * is the same everywhere the app runs.
 */
router.get(
  '/model-usage/catalog',
  asyncHandler(async (_req, res) => {
    const providers = await Promise.all(
      ['openrouter', 'groq'].map((id) => providersService.getProviderRuntimeConfig(id)),
    );
    const configured = providers.filter(Boolean);
    if (!configured.length) {
      return res.json({ configured: false, models: [] });
    }
    const models = configured.map((p) => ({ provider: p.provider, model: p.model, baseUrl: p.baseUrl }));
    return res.json({ configured: true, models });
  }),
);

module.exports = router;
