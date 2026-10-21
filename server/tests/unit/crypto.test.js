'use strict';

/* globals describe, it, expect, beforeEach, afterEach */
const { encryptSecret, decryptSecret, maskSecret } = require('../../src/lib/crypto');
const { config } = require('../../src/config/env');

describe('API key encryption', () => {
  const originalKey = config.appMasterKey;

  beforeEach(() => {
    config.appMasterKey = 'a-strong-test-master-key-with-enough-entropy-123456';
  });
  afterEach(() => {
    config.appMasterKey = originalKey;
  });

  it('round-trips a secret', () => {
    const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz-0123456789';
    const enc = encryptSecret(secret);
    expect(enc.ciphertext).toBeTruthy();
    expect(enc.iv).toBeTruthy();
    expect(enc.tag).toBeTruthy();
    expect(enc.ciphertext).not.toContain(secret);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it('produces a different ciphertext for the same plaintext (random IV)', () => {
    const secret = 'sk-same-secret-value';
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('rejects a tampered auth tag instead of returning garbage', () => {
    const enc = encryptSecret('sk-tamper-me');
    const tampered = { ...enc, tag: Buffer.from('0'.repeat(16)).toString('base64') };
    expect(() => decryptSecret(tampered)).toThrow(/could not be decrypted/i);
  });

  it('fails cleanly when the master key changes', () => {
    const enc = encryptSecret('sk-rotate-me');
    config.appMasterKey = 'a-completely-different-master-key-value-999999';
    expect(() => decryptSecret(enc)).toThrow(/could not be decrypted/i);
  });

  it('masks secrets so the full value is never shown', () => {
    const masked = maskSecret('sk-1234567890abcdef');
    expect(masked).not.toContain('1234567890');
    expect(masked.startsWith('sk-')).toBe(true);
    expect(masked.endsWith('cdef')).toBe(true);
    expect(maskSecret('short')).toBe('••••');
  });

  it('refuses to encrypt an empty secret', () => {
    expect(() => encryptSecret('')).toThrow();
  });
});
