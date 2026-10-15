'use strict';

// SAFETY GUARD: reads every file in src/ and fails if it finds code that can
// change files on disk. The scanner only needs to READ; the only writing the
// app will ever do is in data/ (Phase 2's database).
//
// If a future phase legitimately needs to write inside data/, add exactly that
// file and call to ALLOWED below — never loosen the rule for the whole app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');

// Calls that create, change, move or delete files (both the plain and "Sync"
// versions match, e.g. rename( and renameSync( ).
const FORBIDDEN_CALLS = [
  'writeFile', 'appendFile', 'createWriteStream', 'open', 'openSync',
  'unlink', 'rm', 'rmdir', 'rename', 'mkdir', 'mkdtemp',
  'copyFile', 'cp', 'symlink', 'link', 'truncate', 'ftruncate',
  'utimes', 'lutimes', 'futimes', 'chmod', 'lchmod', 'fchmod', 'chown', 'lchown', 'fchown',
];
const FORBIDDEN_CALL_PATTERN = new RegExp(`\\b(${FORBIDDEN_CALLS.join('|')})(Sync)?\\s*\\(`);
// Running other programs (e.g. `rm -rf`) is just as dangerous.
const FORBIDDEN_MODULE_PATTERN = /require\(\s*['"](node:)?child_process['"]\s*\)/;

// file (relative to src/) -> list of calls it may use. Empty in Phase 1.
const ALLOWED = {};

function listJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(abs);
    return entry.name.endsWith('.js') ? [abs] : [];
  });
}

// Removes comments so explanations like "never rename(...)" don't trip the check.
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('nothing in src/ can write, move, rename or delete files', () => {
  const problems = [];
  for (const file of listJsFiles(SRC_DIR)) {
    const relative = path.relative(SRC_DIR, file);
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      const match = line.match(FORBIDDEN_CALL_PATTERN);
      if (match && !(ALLOWED[relative] || []).includes(match[1])) {
        problems.push(`${relative}:${index + 1} calls ${match[0].trim()}`);
      }
      if (FORBIDDEN_MODULE_PATTERN.test(line)) {
        problems.push(`${relative}:${index + 1} loads child_process`);
      }
    });
  }
  assert.deepEqual(problems, [], `Safety rule broken — the app must never change files outside data/:\n${problems.join('\n')}`);
});

test('the safety check actually catches forbidden calls', () => {
  assert.match('await fsp.rm(target, { recursive: true })', FORBIDDEN_CALL_PATTERN);
  assert.match('fs.renameSync(a, b)', FORBIDDEN_CALL_PATTERN);
  assert.match("fs.writeFile('x', data)", FORBIDDEN_CALL_PATTERN);
  assert.match("require('node:child_process')", FORBIDDEN_MODULE_PATTERN);
  assert.doesNotMatch('const stats = await fsp.lstat(file)', FORBIDDEN_CALL_PATTERN);
  assert.doesNotMatch('const names = await fsp.readdir(dir)', FORBIDDEN_CALL_PATTERN);
});
