#!/usr/bin/env node
/**
 * Pre-flight checks for a fresh checkout (run by `npm run setup`).
 *
 * Verifies the hard requirements (Node, npm, .env, master key) and reports on
 * optional tools (git, psql, ollama). It never prints secret values.
 *
 * Usage:  node scripts/check-prereqs.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const REQUIRED_NODE_MAJOR = 20;
const REQUIRED_NODE_MINOR = 11; // engines: ">=20.11"

let failures = 0;
let warnings = 0;

const tag = {
  ok: '\x1b[32m[ ok ]\x1b[0m',
  warn: '\x1b[33m[warn]\x1b[0m',
  fail: '\x1b[31m[fail]\x1b[0m',
  info: '\x1b[36m[info]\x1b[0m',
};

function ok(msg) {
  console.log(`${tag.ok} ${msg}`);
}
function warn(msg) {
  warnings += 1;
  console.log(`${tag.warn} ${msg}`);
}
function fail(msg) {
  failures += 1;
  console.log(`${tag.fail} ${msg}`);
}
function info(msg) {
  console.log(`${tag.info} ${msg}`);
}

function tryVersion(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

console.log('\nGlobal Softel RAG Chat — prerequisite check\n');

// --- Node -------------------------------------------------------------------
const nodeVersion = process.versions.node;
const [nodeMajor, nodeMinor] = nodeVersion.split('.').map(Number);
if (
  nodeMajor > REQUIRED_NODE_MAJOR ||
  (nodeMajor === REQUIRED_NODE_MAJOR && nodeMinor >= REQUIRED_NODE_MINOR)
) {
  ok(`Node.js ${nodeVersion}`);
} else {
  fail(`Node.js ${nodeVersion} is too old — need >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.`);
}

// --- npm --------------------------------------------------------------------
const npmVersion = tryVersion(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']);
if (npmVersion) ok(`npm ${npmVersion}`);
else fail('npm was not found on PATH.');

// --- .env -------------------------------------------------------------------
const envPath = resolve(root, '.env');
const envExamplePath = resolve(root, '.env.example');
let envContents = '';
if (existsSync(envPath)) {
  envContents = readFileSync(envPath, 'utf8');
  ok('.env found');
} else {
  warn('.env is missing. Create it from the template:');
  info(`  PowerShell:  Copy-Item "${envExamplePath}" "${envPath}"`);
}

// --- APP_MASTER_KEY ---------------------------------------------------------
const placeholder = 'change_me_to_a_long_random_secret_at_least_32_chars';
const keyMatch = envContents.match(/^\s*APP_MASTER_KEY\s*=\s*(.*)$/m);
const keyValue = keyMatch ? keyMatch[1].trim() : '';
if (!keyValue || keyValue === placeholder) {
  warn('APP_MASTER_KEY is not set in .env. Provider API keys cannot be encrypted until you set one.');
  info('  Generate:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
} else if (keyValue.length < 32) {
  warn(`APP_MASTER_KEY is set but short (${keyValue.length} chars). Use at least 32 characters.`);
} else {
  ok('APP_MASTER_KEY is set');
}

// --- storage directories ----------------------------------------------------
const dirs = [
  resolve(root, 'storage'),
  resolve(root, 'storage', 'pgdata'),
  resolve(root, 'storage', 'models'),
];
try {
  for (const d of dirs) mkdirSync(d, { recursive: true });
  ok('storage directories are present (uploads, embedded database, model cache)');
} catch (err) {
  fail(`Could not create storage directories: ${err.message}`);
}

// --- node_modules -----------------------------------------------------------
if (existsSync(resolve(root, 'node_modules'))) {
  ok('dependencies are installed');
} else {
  warn('node_modules not found. Run:  npm install');
}

// --- optional tools ---------------------------------------------------------
for (const [cmd, label, hint] of [
  ['git', 'git', 'Optional. Used for version control; the app does not require it.'],
  ['psql', 'psql (PostgreSQL client)', 'Optional. Only needed if you point DATABASE_URL at a real PostgreSQL server.'],
  ['ollama', 'ollama', 'Optional alternative local embedding/LLM runtime. The default uses in-process transformers.js.'],
]) {
  const bin = process.platform === 'win32' ? `${cmd}.cmd` : cmd;
  const v = tryVersion(bin, cmd === 'psql' ? ['--version'] : ['--version']);
  if (v) {
    info(`${label} detected: ${v}`);
  } else {
    info(`${label} not found. ${hint}`);
  }
}

// --- summary ----------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.log(`${tag.fail} ${failures} blocking issue(s) found. Fix them and re-run \`npm run setup\`.`);
  process.exit(1);
}
if (warnings > 0) {
  console.log(`${tag.warn} ${warnings} warning(s). The app can still run, but review the notes above.`);
}
console.log('\nNext steps:');
console.log('  1. Copy .env.example to .env and set APP_MASTER_KEY (if you have not already).');
console.log('  2. npm run db:migrate      # create the schema (embedded PGlite, no server needed)');
console.log('  3. npm run dev             # start API (http://127.0.0.1:3001) and web UI (http://localhost:5173)');
console.log('  4. Open http://localhost:5173, create a project, and upload documents.\n');
