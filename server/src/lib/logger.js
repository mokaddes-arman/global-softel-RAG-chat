'use strict';

const pino = require('pino');
const { config } = require('../config/env');

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'headers.authorization',
  'headers["x-api-key"]',
  'apiKey',
  'api_key',
  'key',
  'password',
  'token',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  'body.apiKey',
  'body.api_key',
  'body.password',
  '*.key_enc',
  '*.keyEnc',
];

const isPretty = !config.isProduction && !config.isTest && process.stdout.isTTY;

const logger = pino({
  level: config.logLevel,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isPretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

function child(bindings) {
  return logger.child(bindings);
}

module.exports = { logger, child };
