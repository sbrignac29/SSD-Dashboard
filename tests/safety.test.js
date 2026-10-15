'use strict';

// SAFETY GUARD: reads every file in src/ and fails if it finds code that can
// change files on disk. The scanner only needs to READ; the only writing the
// app does is in data/ (the database, src/db.js).
//
// This is a tripwire, not a proof: it looks for the NAMES of file-changing
// functions, whether they're called directly (fs.rm(...)), passed around
// (files.map(fsp.unlink)), looked up by name (fsp['rm']) or renamed
// (const { rm: remove } = fsp).
//
// If a future phase legitimately needs to write inside data/, add exactly that
// file and name to ALLOWED below — never loosen the rule for the whole app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');

// Functions that create, change, move or delete files. Each also matches its
// "Sync" version (rename / renameSync).
const FORBIDDEN_NAMES = [
  'writeFile', 'appendFile', 'createWriteStream', 'WriteStream', 'open', 'openSync',
  'unlink', 'rm', 'rmdir', 'rename', 'mkdir', 'mkdtemp',
  'copyFile', 'cp', 'symlink', 'link', 'truncate', 'ftruncate',
  'utimes', 'lutimes', 'futimes', 'chmod', 'lchmod', 'fchmod', 'chown', 'lchown', 'fchown',
];
const NAMES = `(${FORBIDDEN_NAMES.join('|')})(Sync)?`;
// The "g" flag lets us find EVERY match on a line, not just the first, so an
// allowed call can't hide a forbidden one written after it on the same line.
const FORBIDDEN_PATTERNS = [
  // A direct call: rm(  renameSync(
  new RegExp(`\\b${NAMES}\\s*(\\?\\.)?\\(`, 'g'),
  // Used as a property, called or not: fsp.unlink  fs.promises.rm
  new RegExp(`\\.\\s*${NAMES}\\b`, 'g'),
  // Looked up by name: fsp['rm']
  new RegExp(`\\[\\s*['"\`]${NAMES}['"\`]\\s*\\]`, 'g'),
  // Pulled out of a module: const { rm } = ...  /  { rename: move }
  // (The closing , : or } is only looked at, not used up, so it can also start
  // the next match: in { mkdir, rm } both names are found.)
  new RegExp(`[{,]\\s*${NAMES}\\s*(?=[:,}])`, 'g'),
  // Running other programs (e.g. `rm -rf`) is just as dangerous.
  /\b(require|import)\s*\(\s*['"`](node:)?child_process/g,
  /\bfrom\s+['"`](node:)?child_process/g,
];

// file (relative to src/) -> list of names it may use. Keep this as small as
// possible: each entry is a place where the app is allowed to change files.
//
//   db.js: creates the data/ folder itself if it's missing, so the database
//   has somewhere to live. db.js checks the path is DATA_DIR first. (The
//   database file itself is written by SQLite through `new Database(path)`,
//   which this guard can't see, so db.js refuses any path outside data/.)
const ALLOWED = {
  'db.js': ['mkdir'],
};

function listCodeFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return listCodeFiles(abs);
    return /\.(c|m)?js$/.test(entry.name) ? [abs] : [];
  });
}

// Blanks out comment lines so explanations like "never rename(...)" don't trip
// the check. Deliberately simple and line-based: it only removes lines that
// START as comments, plus a " // ..." at the end of a line. (Text inside quotes
// that merely looks like a comment, e.g. 'Exports/*.mp4', can't hide code.)
function stripComments(code) {
  return code
    .split('\n')
    .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, '')))
    .join('\n');
}

function findProblems(code, allowed = []) {
  const problems = [];
  stripComments(code)
    .split('\n')
    .forEach((line, index) => {
      for (const pattern of FORBIDDEN_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          const name = FORBIDDEN_NAMES.find((n) => match[0].includes(n));
          if (name && allowed.includes(name)) continue;
          problems.push(`line ${index + 1}: ${match[0].trim()}`);
        }
      }
    });
  return problems;
}

test('nothing in src/ can write, move, rename or delete files', () => {
  const problems = [];
  for (const file of listCodeFiles(SRC_DIR)) {
    const relative = path.relative(SRC_DIR, file);
    const found = findProblems(fs.readFileSync(file, 'utf8'), ALLOWED[relative] || []);
    problems.push(...found.map((problem) => `${relative} ${problem}`));
  }
  assert.deepEqual(problems, [], `Safety rule broken — the app must never change files outside data/:\n${problems.join('\n')}`);
});

test('the guard catches file-changing code, however it is written', () => {
  const sneaky = [
    'await fsp.rm(target, { recursive: true })',
    'fs.renameSync(a, b)',
    "fs.writeFile('x', data)",
    'await Promise.all(stale.map(fsp.unlink))',
    "fsp['rm'](dir)",
    'fsp.rm?.(dir)',
    'const { rm: remove } = require("node:fs/promises")',
    'const out = new fs.WriteStream(file)',
    "const cp = require('node:child_process')",
    "const { exec } = await import('child_process')",
    "const glob = 'Exports/*.mp4'; await fsp.rm(dir); /** later doc */",
    "const url = 'a//b'; fsp.unlink(file)",
  ];
  for (const code of sneaky) {
    assert.notDeepEqual(findProblems(code), [], `should have been caught: ${code}`);
  }
});

test("an allowed name doesn't let anything else through", () => {
  const allowed = ['mkdir'];
  assert.deepEqual(findProblems('fs.mkdirSync(DATA_DIR, { recursive: true })', allowed), []);
  const sneaky = [
    'fs.mkdirSync(DATA_DIR); fs.rmSync(DATA_DIR, { recursive: true })',
    'fs.mkdirSync(a); fs.renameSync(a, b)',
    'fs.mkdirSync(DATA_DIR); fsp.unlink(file)',
    'fs.rmdirSync(DATA_DIR)',
    'const { mkdirSync, rmSync: removeEverything } = require("node:fs")',
    'const { mkdir, unlink } = require("node:fs/promises")',
    'const { mkdirSync, rmSync } = require("node:fs")',
  ];
  for (const code of sneaky) {
    assert.notDeepEqual(findProblems(code, allowed), [], `should have been caught: ${code}`);
  }
});

test('the guard allows read-only code and plain comments', () => {
  const harmless = [
    'const stats = await fsp.lstat(file)',
    'const names = await fsp.readdir(dir)',
    'const real = await fsp.realpath(root)',
    '// we never rename(...) or rm(...) anything',
    '   * It never opens, creates, changes, moves, renames or deletes anything.',
    "throw new Error('Offloading is not built yet')",
  ];
  for (const code of harmless) {
    assert.deepEqual(findProblems(code), [], `should be allowed: ${code}`);
  }
});
