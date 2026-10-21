'use strict';

const { z, ZodError } = require('zod');
const { AppError } = require('../lib/errors');

/**
 * Query-string boolean. `z.coerce.boolean()` would treat the string "false" as
 * true, so we parse the common truthy/falsey spellings explicitly. Absent -> undefined.
 */
function booleanQuery() {
  return z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
    .optional()
    .transform((v) => (v === undefined ? undefined : ['true', '1', 'yes', 'on'].includes(v)));
}

function formatZodIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

/** Validate req.body (or another part) with a Zod schema. */
function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      return next(
        new AppError('Request validation failed.', {
          code: 'validation_error',
          status: 422,
          details: formatZodIssues(result.error),
        }),
      );
    }
    req.validated = result.data;
    return next();
  };
}

function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      return next(
        new AppError('Invalid query parameters.', {
          code: 'validation_error',
          status: 422,
          details: formatZodIssues(result.error),
        }),
      );
    }
    req.validatedQuery = result.data;
    return next();
  };
}

/** Parse and validate a UUID route param. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuidParam(name = 'id') {
  return (req, _res, next) => {
    const value = req.params[name];
    if (!UUID_RE.test(String(value || ''))) {
      return next(new AppError(`Invalid ${name}: expected a UUID.`, { code: 'bad_request', status: 400 }));
    }
    return next();
  };
}

module.exports = { validateBody, validateQuery, validateUuidParam, formatZodIssues, UUID_RE, ZodError, booleanQuery };
