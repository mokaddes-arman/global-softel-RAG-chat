'use strict';

const crypto = require('node:crypto');

/** Deterministic, reversible-free id helpers. */
const newId = () => crypto.randomUUID();

const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex');

const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

/** Rough token estimate used for budgeting context. ~4 chars/token for English. */
const estimateTokens = (text) => (text ? Math.ceil(String(text).length / 4) : 0);

function slugify(value, fallback = 'item') {
  const s = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

/** Short stable suffix so slugs stay unique without a round-trip to the DB. */
const slugSuffix = () => crypto.randomBytes(3).toString('hex');

function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

module.exports = { newId, sha256, randomToken, estimateTokens, slugify, slugSuffix, truncate };
