'use strict';

const { newId } = require('../lib/ids');
const { logger } = require('../lib/logger');

/** Attach a request id and a scoped logger to every request; log completion. */
function requestContext(req, res, next) {
  req.id = req.headers['x-request-id'] || newId();
  res.setHeader('x-request-id', req.id);
  req.log = logger.child({ reqId: req.id });
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const meta = {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Math.round(ms),
    };
    if (res.statusCode >= 500) req.log.error(meta, 'request failed');
    else if (res.statusCode >= 400) req.log.warn(meta, 'request completed with client error');
    else req.log.info(meta, 'request completed');
  });
  next();
}

module.exports = { requestContext };
