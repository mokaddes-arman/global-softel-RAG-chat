'use strict';

const { AppError, Codes } = require('./errors');

/**
 * fetch() wrapper that enforces a timeout and supports caller cancellation
 * (used to implement "stop generation"). Never logs request bodies, which may
 * contain API keys or document content.
 *
 * IMPORTANT: `fetch()` resolves as soon as the *response headers* arrive, so a
 * timeout that only guards the `fetch()` call does not protect the body. A
 * provider that accepts the request and then stalls would hang the caller
 * forever. The timeout therefore stays armed until the body has been consumed
 * (see `withBodyDeadline`), and streaming bodies additionally get an idle
 * timeout in `consumeSSE`.
 */
function timeoutSignal(timeoutMs, outerSignal) {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs) : null;
  const onAbort = () => controller.abort(new Error('aborted'));
  if (outerSignal) {
    if (outerSignal.aborted) onAbort();
    else outerSignal.addEventListener('abort', onAbort, { once: true });
  }
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener?.('abort', onAbort);
  };
  return { signal: controller.signal, cleanup, controller };
}

/** HTTP statuses that must not carry a response body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Re-wrap the response body so the abort timer stays armed until the body is
 * fully read. Aborting the controller tears down the socket, which unblocks a
 * stalled provider instead of hanging the request forever.
 */
function withBodyDeadline(res, { cleanup, controller, signal, service, timeoutMs }) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function' || NULL_BODY_STATUSES.has(res.status)) {
    cleanup();
    return res;
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    cleanup();
  };

  const mapError = (err) => {
    if (err instanceof AppError) return err;
    if (!controller.signal.aborted) return err;
    if (signal?.aborted) {
      return new AppError('The request was cancelled.', { code: Codes.GENERATION_FAILED, status: 499, cause: err });
    }
    return new AppError(`The ${service} request timed out after ${Math.round((timeoutMs || 0) / 1000)}s.`, {
      code: Codes.NETWORK_TIMEOUT,
      status: 504,
      cause: err,
    });
  };

  try {
    const reader = body.getReader();
    const wrapped = new ReadableStream({
      async pull(streamController) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finish();
            streamController.close();
            return;
          }
          streamController.enqueue(value);
        } catch (err) {
          finish();
          streamController.error(mapError(err));
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(wrapped, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch {
    // Wrapping failed - keep the original response. The timer is deliberately
    // left armed so the request is still aborted at the deadline.
    return res;
  }
}

async function request(url, init, { timeoutMs, signal, service = 'service' } = {}) {
  const { signal: sig, cleanup, controller } = timeoutSignal(timeoutMs, signal);
  let res;
  try {
    res = await fetch(url, { ...init, signal: sig });
  } catch (err) {
    const wasOuterAbort = signal?.aborted;
    if (controller.signal.aborted) {
      if (wasOuterAbort) {
        throw new AppError('The request was cancelled.', { code: Codes.GENERATION_FAILED, status: 499, cause: err });
      }
      throw new AppError(`The ${service} request timed out after ${Math.round(timeoutMs / 1000)}s.`, {
        code: Codes.NETWORK_TIMEOUT,
        status: 504,
        cause: err,
      });
    }
    throw new AppError(`Could not reach the ${service}: ${err.message}`, {
      code: Codes.PROVIDER_ERROR,
      status: 502,
      cause: err,
    });
  }
  // The abort timer deliberately stays armed until the body is consumed.
  return withBodyDeadline(res, { cleanup, controller, signal, service, timeoutMs });
}

/** Read one chunk with a deadline; on expiry the stream is cancelled. */
function readWithTimeout(reader, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Cancelling releases the socket so the provider stops streaming.
      reader.cancel().catch(() => {});
      reject(onTimeout());
    }, timeoutMs);
    reader.read().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Iterate Server-Sent Events from a streaming response.
 * Calls onEvent(dataString, eventName) for each `data:` payload. Stops on
 * `data: [DONE]`.
 *
 * Two deadlines protect the caller:
 *   - `timeoutMs`     - overall budget for the whole stream
 *   - `idleTimeoutMs` - maximum time without any new data
 * Without them a provider that keeps the connection open but never sends
 * anything leaves the UI spinning forever.
 */
async function consumeSSE(response, onEvent, { timeoutMs = 0, idleTimeoutMs = 0, service = 'provider' } = {}) {
  if (!response.body) {
    throw new AppError('The provider returned no response body.', { code: Codes.PROVIDER_ERROR, status: 502 });
  }
  const decoder = new TextDecoder();
  let buffer = '';
  const flushEvent = (rawBlock) => {
    const lines = rawBlock.split('\n');
    let eventName = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    if (data === '' || data === '[DONE]') return data === '[DONE]' ? 'DONE' : null;
    onEvent(data, eventName);
    return null;
  };

  const reader = response.body.getReader();
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  let lastActivity = Date.now();

  const timeoutError = (overall) =>
    new AppError(
      overall
        ? `The ${service} response did not complete within ${Math.round(timeoutMs / 1000)}s.`
        : `The ${service} stopped sending data for ${Math.round(idleTimeoutMs / 1000)}s.`,
      { code: Codes.NETWORK_TIMEOUT, status: 504 },
    );

  try {
    for (;;) {
      const now = Date.now();
      const overallLeft = deadline === null ? null : deadline - now;
      const idleLeft = idleTimeoutMs > 0 ? idleTimeoutMs - (now - lastActivity) : null;
      const waitFor = Math.min(overallLeft ?? Infinity, idleLeft ?? Infinity);

      if (waitFor <= 0) {
        throw timeoutError(overallLeft !== null && overallLeft <= 0);
      }

      const { value, done } = await readWithTimeout(reader, waitFor, () =>
        timeoutError(overallLeft !== null && overallLeft <= 0),
      );
      if (done) break;
      lastActivity = Date.now();
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (flushEvent(raw) === 'DONE') return;
      }
    }
    if (buffer.trim()) flushEvent(buffer);
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* already released */
    }
  }
}

/** Map an HTTP error status from an LLM provider to an AppError. */
function mapProviderHttpError(status, bodyText, provider) {
  const snippet = String(bodyText || '').replace(/\s+/g, ' ').slice(0, 400);
  if (status === 401 || status === 403) {
    return new AppError(`The ${provider} API key was rejected or lacks permission.`, {
      code: Codes.INVALID_API_KEY,
      status: 401,
      details: { provider },
    });
  }
  if (status === 404) {
    return new AppError(`The model or endpoint was not found on ${provider}. Check the model name and base URL.`, {
      code: Codes.MODEL_NOT_FOUND,
      status: 404,
      details: { provider, snippet },
    });
  }
  if (status === 429) {
    return new AppError(`The ${provider} provider rate-limited this request. Wait and retry.`, {
      code: Codes.RATE_LIMITED,
      status: 429,
      details: { provider },
    });
  }
  if (status === 400 && /context|too long|maximum/i.test(snippet)) {
    return new AppError('The request exceeded the model context window. Reduce retrieved context or choose a larger model.', {
      code: Codes.PROVIDER_ERROR,
      status: 400,
      details: { provider, snippet },
    });
  }
  return new AppError(`${provider} returned HTTP ${status}. ${snippet}`, {
    code: Codes.PROVIDER_ERROR,
    status: 502,
    details: { provider, snippet },
  });
}

module.exports = { request, consumeSSE, mapProviderHttpError, timeoutSignal };
