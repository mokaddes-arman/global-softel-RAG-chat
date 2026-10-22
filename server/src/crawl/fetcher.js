'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');
const { config } = require('../config/env');
const { AppError, Codes } = require('../lib/errors');

/**
 * Safe HTTP fetcher for the knowledge-base crawler.
 *
 * A crawler fetches URLs a human typed in, so it is a classic SSRF vector:
 * without a guard it would happily read `http://169.254.169.254/` (cloud
 * metadata) or `http://127.0.0.1:5432/` (a local database) and put the
 * response into the knowledge base.
 *
 * Guards:
 *   - only http/https, no credentials in the URL
 *   - the hostname must resolve to a public address (loopback, link-local,
 *     private and unique-local ranges are refused)
 *   - every redirect hop is re-validated
 *   - a response size cap and a request deadline
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 (protocol assignments)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase();
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(value)) return true; // unique local fc00::/7
  if (value.startsWith('::ffff:')) {
    // IPv4-mapped: delegate to the IPv4 rules.
    return isPrivateIPv4(value.slice('::ffff:'.length));
  }
  return false;
}

function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // not an address we understand -> treat as unsafe
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** Parse and normalise a user-supplied URL. */
function parseUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) {
    throw new AppError('A URL is required.', { code: Codes.VALIDATION, status: 422 });
  }
  // A bare "example.com/page" is a common paste; assume https.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new AppError(`"${value}" is not a valid URL.`, { code: Codes.VALIDATION, status: 422 });
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new AppError(`Only http and https URLs can be crawled (got "${url.protocol.replace(':', '')}").`, {
      code: Codes.UNSAFE_URL,
      status: 422,
    });
  }
  if (!url.hostname) {
    throw new AppError(`"${value}" has no hostname.`, { code: Codes.VALIDATION, status: 422 });
  }
  if (url.username || url.password) {
    throw new AppError('URLs with embedded credentials are not accepted.', {
      code: Codes.UNSAFE_URL,
      status: 422,
    });
  }
  url.hash = '';
  return url;
}

/** Canonical form used to recognise "the same link" across re-imports. */
function canonicalUrl(url) {
  const u = typeof url === 'string' ? parseUrl(url) : url;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const port = u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) ? `:${u.port}` : '';
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  return `${u.protocol}//${host}${port}${pathname}${u.search}`;
}

/** Reject hosts that point back into the machine or the private network. */
async function assertPublicHost(url) {
  if (config.crawl.allowPrivateHosts) return;
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new AppError(`"${hostname}" points at a private address and cannot be crawled.`, {
      code: Codes.UNSAFE_URL,
      status: 422,
    });
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new AppError(`Could not resolve "${hostname}": ${err.message}`, {
      code: Codes.CRAWL_FAILED,
      status: 502,
    });
  }
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new AppError(`"${hostname}" resolves to the private address ${record.address} and cannot be crawled.`, {
        code: Codes.UNSAFE_URL,
        status: 422,
      });
    }
  }
}

function contentTypeOf(res) {
  const header = res.headers.get('content-type') || '';
  return header.split(';')[0].trim().toLowerCase();
}

/** Read at most `maxBytes` from a response body. */
async function readBody(res, maxBytes) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AppError(`The page is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB crawl limit.`, {
          code: Codes.FILE_TOO_LARGE,
          status: 413,
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* already released */
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a URL and return its body.
 *
 * @returns {Promise<{url:string, finalUrl:string, status:number, contentType:string, body:Buffer}>}
 */
async function fetchUrl(rawUrl, { timeoutMs, maxBytes, maxRedirects } = {}) {
  const timeout = timeoutMs ?? config.crawl.timeoutMs;
  const limit = maxBytes ?? config.crawl.maxBytes;
  const redirects = maxRedirects ?? config.crawl.maxRedirects;

  let current = parseUrl(rawUrl);
  let hops = 0;

  for (;;) {
    await assertPublicHost(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);
    let res;
    try {
      res = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': config.crawl.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-language': 'en',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      throw new AppError(`Could not reach ${current.host}: ${err.message}`, {
        code: Codes.CRAWL_FAILED,
        status: 502,
      });
    }

    try {
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) {
          throw new AppError(`${current.host} returned a redirect without a target.`, {
            code: Codes.CRAWL_FAILED,
            status: 502,
          });
        }
        hops += 1;
        if (hops > redirects) {
          throw new AppError(`The URL redirected more than ${redirects} times.`, {
            code: Codes.CRAWL_FAILED,
            status: 502,
          });
        }
        current = parseUrl(new URL(location, current).toString());
        continue;
      }

      if (!res.ok) {
        throw new AppError(`${current.host} returned HTTP ${res.status}.`, {
          code: Codes.CRAWL_FAILED,
          status: 502,
          details: { status: res.status },
        });
      }

      const contentType = contentTypeOf(res);
      const body = await readBody(res, limit);
      return {
        url: current.toString(),
        finalUrl: current.toString(),
        status: res.status,
        contentType,
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  fetchUrl,
  parseUrl,
  canonicalUrl,
  assertPublicHost,
  isPrivateAddress,
};
