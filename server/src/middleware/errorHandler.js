'use strict';

const { AppError } = require('../lib/errors');
const { config } = require('../config/env');

/** 404 handler for unmatched API routes. */
function notFoundHandler(req, res, next) {
  next(new AppError(`No route for ${req.method} ${req.originalUrl}`, { code: 'not_found', status: 404 }));
}

/**
 * Central error handler. Never leaks stack traces or secrets; unexpected
 * errors are logged with full detail server-side and reported generically.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isAppError = err instanceof AppError;
  const status = isAppError ? err.status : err.status || err.statusCode || 500;
  const code = isAppError ? err.code : 'internal_error';

  // Multer / body-parser known errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: {
        code: 'file_too_large',
        message: `File exceeds the maximum upload size of ${config.maxUploadSizeMb} MB.`,
      },
    });
  }

  const logPayload = { err: err.message, code, status, stack: isAppError ? undefined : err.stack };
  if (status >= 500) req.log?.error(logPayload, 'unhandled error');
  else req.log?.warn({ err: err.message, code, status }, 'request error');

  const body = {
    error: {
      code,
      message: status >= 500 && !isAppError ? 'An internal error occurred. Check the server logs.' : err.message,
    },
  };
  if (isAppError && err.details !== undefined) body.error.details = err.details;
  res.status(status).json(body);
}

/** Wrap async route handlers so rejected promises reach the error handler. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { errorHandler, notFoundHandler, asyncHandler };
