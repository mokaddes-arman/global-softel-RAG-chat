/* globals describe, it, expect */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquirePgliteLock } = require('../../src/db');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-lock-'));
}

describe('embedded database lock', () => {
  it('refuses a second owner and allows reuse after release', () => {
    const dir = tempDir();
    const lockPath = `${dir}.lock`;
    try {
      const release = acquirePgliteLock(dir);
      expect(() => acquirePgliteLock(dir)).toThrow(/already open/i);
      release();
      expect(fs.existsSync(lockPath)).toBe(false);

      const releaseAgain = acquirePgliteLock(dir);
      releaseAgain();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(lockPath, { force: true });
    }
  });

  it('reclaims a lock left behind by a dead process', () => {
    const dir = tempDir();
    const lockPath = `${dir}.lock`;
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, token: 'stale' }));
      const release = acquirePgliteLock(dir);
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token).not.toBe('stale');
      release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(lockPath, { force: true });
    }
  });
});
