'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { config, ensureRuntimeDirs } = require('../config/env');
const { AppError, Codes } = require('./errors');
const { sha256 } = require('./ids');

/**
 * Filesystem storage for original documents.
 *
 * Only relative paths are ever persisted in the database. Every path that is
 * read or deleted is re-resolved and verified to live inside the storage root,
 * which blocks path-traversal attempts from a tampered database row.
 */

const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Produce a safe, human-readable filename (never a path). */
function sanitiseFilename(name, fallback = 'document') {
  let base = path.basename(String(name || ''));
  base = base.replace(/[\u0000-\u001f\u007f]/g, '');
  base = base.replace(/[<>:"/\\|?*]/g, '_');
  base = base.replace(/\.+$/, '');
  base = base.trim().replace(/\s+/g, ' ');
  if (!base) base = fallback;
  const ext = path.extname(base);
  const stemRaw = path.basename(base, ext);
  let stem = stemRaw.slice(0, 120) || fallback;
  if (RESERVED.has(stem.toLowerCase())) stem = `_${stem}`;
  const safeExt = ext.slice(0, 12).replace(/[^.\w]/g, '');
  return `${stem}${safeExt}`;
}

function storageRoot() {
  return path.resolve(config.paths.uploads);
}

/** Resolve a relative storage path, refusing anything outside the root. */
function resolveStoredPath(relativePath) {
  const root = storageRoot();
  const full = path.resolve(root, String(relativePath || ''));
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    throw new AppError('Refusing to access a file outside the storage directory.', {
      code: Codes.BAD_REQUEST,
      status: 400,
    });
  }
  return full;
}

function buildRelativePath({ projectId, documentId, versionNumber, originalFilename }) {
  const safe = sanitiseFilename(originalFilename);
  return path.posix.join(String(projectId), String(documentId), `v${versionNumber}__${safe}`);
}

async function moveFileIntoStorage(tempPath, relativePath) {
  ensureRuntimeDirs();
  const dest = resolveStoredPath(relativePath);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(tempPath, dest);
  } catch (err) {
    // Cross-device rename fails on some Windows setups - fall back to copy+unlink.
    if (err.code === 'EXDEV' || err.code === 'EPERM') {
      await fsp.copyFile(tempPath, dest);
      await fsp.unlink(tempPath).catch(() => {});
    } else {
      throw err;
    }
  }
  return dest;
}

async function computeFileHash(filePath) {
  const buf = await fsp.readFile(filePath);
  return sha256(buf);
}

async function statSize(filePath) {
  const s = await fsp.stat(filePath);
  return s.size;
}

async function deleteStoredFile(relativePath) {
  if (!relativePath) return false;
  let full;
  try {
    full = resolveStoredPath(relativePath);
  } catch {
    return false;
  }
  try {
    await fsp.unlink(full);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function removeVersionDirectory(projectId, documentId) {
  const dir = resolveStoredPath(path.posix.join(String(projectId), String(documentId)));
  await fsp.rm(dir, { recursive: true, force: true });
}

async function readStoredFile(relativePath, maxBytes = 50 * 1024 * 1024) {
  const full = resolveStoredPath(relativePath);
  const s = await fsp.stat(full);
  if (s.size > maxBytes) {
    throw new AppError(`Stored file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB read limit.`, {
      code: Codes.FILE_TOO_LARGE,
      status: 413,
    });
  }
  return fsp.readFile(full);
}

function fileExists(relativePath) {
  try {
    return fs.existsSync(resolveStoredPath(relativePath));
  } catch {
    return false;
  }
}

module.exports = {
  sanitiseFilename,
  resolveStoredPath,
  buildRelativePath,
  moveFileIntoStorage,
  computeFileHash,
  statSize,
  deleteStoredFile,
  removeVersionDirectory,
  readStoredFile,
  fileExists,
  storageRoot,
};
