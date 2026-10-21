'use strict';

/**
 * Application error types. Every error carries a stable machine-readable
 * `code` and an HTTP status so the API can map failures consistently and the
 * UI can show an understandable message without leaking stack traces.
 */

class AppError extends Error {
  constructor(message, { code = 'internal_error', status = 500, details = undefined, cause = undefined } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = status < 500;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, AppError);
  }
}

const badRequest = (message, details) => new AppError(message, { code: 'bad_request', status: 400, details });
const validationError = (message, details) =>
  new AppError(message, { code: 'validation_error', status: 422, details });
const notFound = (message = 'Resource not found') => new AppError(message, { code: 'not_found', status: 404 });

/** Error codes surfaced to the UI so it can present specific guidance. */
const Codes = {
  VALIDATION: 'validation_error',
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  DUPLICATE_DOCUMENT: 'duplicate_document',
  UNSUPPORTED_FORMAT: 'unsupported_format',
  FILE_TOO_LARGE: 'file_too_large',
  PARSE_FAILED: 'parse_failed',
  ENCRYPTED_DOCUMENT: 'encrypted_document',
  OCR_REQUIRED: 'ocr_required',
  NO_RELEVANT_DOCUMENTS: 'no_relevant_documents',
  EMBEDDING_UNAVAILABLE: 'embedding_unavailable',
  EMBEDDING_DIM_MISMATCH: 'embedding_dim_mismatch',
  DATABASE_UNAVAILABLE: 'database_unavailable',
  DATABASE_TIMEOUT: 'database_timeout',
  DATABASE_DEADLOCK: 'database_deadlock',
  INVALID_API_KEY: 'invalid_api_key',
  RATE_LIMITED: 'rate_limited',
  MODEL_NOT_FOUND: 'model_not_found',
  NETWORK_TIMEOUT: 'network_timeout',
  PROVIDER_ERROR: 'provider_error',
  GENERATION_FAILED: 'generation_failed',
  HOSTED_AI_DISABLED: 'hosted_ai_disabled',
  MISSING_MASTER_KEY: 'missing_master_key',
  PROJECT_MISMATCH: 'project_mismatch',
  LOCKED: 'locked',
};

module.exports = {
  AppError,
  Codes,
  badRequest,
  validationError,
  notFound,
};
