'use strict';

const crypto = require('node:crypto');
const { AppError, Codes } = require('./errors');
const { getMasterKey } = require('../config/env');

/**
 * Provider API keys are stored encrypted at rest with AES-256-GCM.
 * The master key is derived from APP_MASTER_KEY (see config/env.js).
 *
 * Storage layout (three short base64 strings + a masked hint), so a plaintext
 * key can never be recovered from an ordinary database dump alone.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

function requireKey() {
  const key = getMasterKey();
  if (!key) {
    throw new AppError(
      'APP_MASTER_KEY is not configured, so provider API keys cannot be encrypted. ' +
        'Set APP_MASTER_KEY in your .env file (at least 32 random characters) and restart.',
      { code: Codes.MISSING_MASTER_KEY, status: 500 },
    );
  }
  return key;
}

function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new AppError('Cannot encrypt an empty secret.', { code: Codes.VALIDATION, status: 400 });
  }
  const key = requireKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    hint: maskSecret(plaintext),
  };
}

function decryptSecret({ ciphertext, iv, tag }) {
  const key = requireKey();
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    return out.toString('utf8');
  } catch (err) {
    throw new AppError(
      'Stored API key could not be decrypted. This usually means APP_MASTER_KEY changed after the key was saved.',
      { code: Codes.INVALID_API_KEY, status: 500, cause: err },
    );
  }
}

/** Safe display form: keeps a short prefix/suffix, never the full key. */
function maskSecret(secret) {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= 8) return '••••';
  const head = s.slice(0, 3);
  const tail = s.slice(-4);
  return `${head}••••••${tail}`;
}

module.exports = { encryptSecret, decryptSecret, maskSecret };
