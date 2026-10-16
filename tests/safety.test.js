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

// --- Notion is read-only ------------------------------------------------------
//
// Phase 4 only READS Notion. The integration you made in Notion has only
// "Read content" ticked (that's the real lock: Notion itself refuses anything
// else), and this test is the second lock: the only Notion calls in src/ are
// the two read calls in src/notion/sync.js, and only that file loads the
// Notion library.

const NOTION_AREAS = ['pages', 'blocks', 'databases', 'dataSources', 'comments', 'users', 'fileUploads', 'oauth', 'views'];
const NOTION_READS = ['dataSources.retrieve', 'dataSources.query'];

function notionCalls(code) {
  const found = [];
  const lines = stripComments(code).split('\n');
  for (const line of lines) {
    // client.dataSources.query  /  notion.pages.update  /  x.blocks.children.append
    // (but not the spread "...pages.map(...)": a list called pages, not Notion)
    for (const m of line.matchAll(new RegExp(`(?<!\\.)\\.\\s*(${NOTION_AREAS.join('|')})\\s*\\.\\s*(\\w+)`, 'g'))) {
      found.push(`${m[1]}.${m[2]}`);
    }
    // The library's catch-alls: client.request(...) and client.search(...)
    for (const m of line.matchAll(/\.\s*(request|search)\s*\(/g)) found.push(m[1]);
  }
  return found;
}

test('src/ only ever reads Notion: no Notion call but the two read calls', () => {
  const problems = [];
  for (const file of listCodeFiles(SRC_DIR)) {
    const relative = path.relative(SRC_DIR, file);
    const code = fs.readFileSync(file, 'utf8');
    for (const call of notionCalls(code)) {
      if (!(relative === path.join('notion', 'sync.js') && NOTION_READS.includes(call))) problems.push(`${relative}: ${call}`);
    }
    if (/@notionhq\/client/.test(stripComments(code)) && relative !== path.join('notion', 'sync.js')) {
      problems.push(`${relative}: loads @notionhq/client (only notion/sync.js may)`);
    }
  }
  assert.deepEqual(problems, [], `Notion must only be read:\n${problems.join('\n')}`);
});

test('the Notion guard catches calls that would change Notion', () => {
  const sneaky = [
    "await client.pages.update({ page_id: id, properties: {} })",
    "notion.blocks.children.append({ block_id: id, children: [] })",
    "client.comments.create({ parent: { page_id: id } })",
    "client.dataSources.update({ data_source_id: id })",
    "client.databases.create({})",
    "client.request({ path: 'pages', method: 'post' })",
  ];
  for (const code of sneaky) {
    assert.ok(notionCalls(code).some((call) => !NOTION_READS.includes(call)), `should have been caught: ${code}`);
  }
  assert.deepEqual(notionCalls("client.dataSources.query({ data_source_id: id })"), ['dataSources.query']);
  assert.deepEqual(notionCalls('const all = [...pages.map((p) => p.title)]'), [], 'a spread list is not Notion');
});

// --- Outgoing HTTP: only VeriCopy, only on 127.0.0.1 --------------------------
//
// Phase 5: the dashboard asks VeriCopy to copy. The only code that may send a
// request to another program is src/offload/vericopy.js (which only talks to
// http://127.0.0.1:<port>, only on four routes: tests/vericopy.test.js runs
// those rules). Notion's library (src/notion/sync.js) reaches api.notion.com
// on its own, read-only, and is guarded above.
//
// Everywhere else in src/: no fetch(), no network modules, and node:http only
// for running the dashboard's own server (createServer).

const NETWORK_MODULES = ['https', 'net', 'tls', 'dgram', 'http2', 'undici', 'axios', 'got', 'node-fetch', 'ws'];
const CLIENT_FILE = path.join('offload', 'vericopy.js');

function networkProblems(code, relative) {
  const problems = [];
  const lines = stripComments(code).split('\n');
  lines.forEach((line, index) => {
    const where = `line ${index + 1}`;
    for (const m of line.matchAll(new RegExp(`(require\\s*\\(|from\\s+|import\\s*\\()\\s*['"\`](node:)?(${NETWORK_MODULES.join('|')})['"\`]`, 'g'))) {
      problems.push(`${where}: loads ${m[3]}`);
    }
    if (/\bfetch\s*\(/.test(line)) problems.push(`${where}: fetch(`);
    if (/\b(XMLHttpRequest|WebSocket|EventSource)\b/.test(line)) problems.push(`${where}: browser-style network call`);
    if (relative === CLIENT_FILE) return;
    // node:http: only the server's own createServer, nothing that sends.
    for (const m of line.matchAll(/\bhttp\s*\.\s*(\w+)/g)) {
      if (m[1] !== 'createServer') problems.push(`${where}: http.${m[1]}`);
    }
    if (/\{[^}]*\b(request|get)\b[^}]*\}\s*=\s*require\s*\(\s*['"`](node:)?http['"`]/.test(line)) {
      problems.push(`${where}: takes request/get from node:http`);
    }
  });
  return problems;
}

test('only src/offload/vericopy.js sends HTTP requests (to VeriCopy on 127.0.0.1)', () => {
  const problems = [];
  for (const file of listCodeFiles(SRC_DIR)) {
    const relative = path.relative(SRC_DIR, file);
    problems.push(...networkProblems(fs.readFileSync(file, 'utf8'), relative).map((p) => `${relative} ${p}`));
  }
  assert.deepEqual(problems, [], `Outgoing network code outside the VeriCopy client:\n${problems.join('\n')}`);

  // The client itself: one place sends, always to 127.0.0.1, and the address
  // is checked by config.js → vericopyAddress before any request.
  const client = stripComments(fs.readFileSync(path.join(SRC_DIR, CLIENT_FILE), 'utf8'));
  assert.equal((client.match(/\bhttpRequest\s*\(/g) ?? []).length, 1, 'exactly one place sends a request');
  assert.match(client, /host:\s*'127\.0\.0\.1'/);
  assert.match(client, /vericopyAddress\(url\)/);
  // The headers object it builds, and anything added to it later, never name Origin.
  const headers = client.match(/const headers = \{[^}]*\}/)?.[0];
  assert.ok(headers, 'the headers are built in one place');
  assert.doesNotMatch(headers, /origin/i, 'never sets an Origin header');
  assert.doesNotMatch(client, /headers\s*\[\s*['"`]origin/i, 'never adds an Origin header');
});

test('the network guard catches requests to other places', () => {
  const sneaky = [
    "await fetch('https://example.com')",
    "const https = require('node:https')",
    "http.request({ host: 'example.com' })",
    "http.get('http://10.0.0.1/')",
    "const { request } = require('node:http')",
    "import got from 'got'",
    'new WebSocket(url)',
  ];
  for (const code of sneaky) assert.notDeepEqual(networkProblems(code, 'web/views.js'), [], `should have been caught: ${code}`);
  assert.deepEqual(networkProblems('const server = http.createServer(app)', 'server.js'), []);
});

test("the browser pages never talk to VeriCopy (only the server does)", () => {
  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  const problems = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(js|html)$/.test(entry.name)) {
        const text = fs.readFileSync(abs, 'utf8');
        if (/127\.0\.0\.1|:8787|\/api\/jobs|\/api\/health|localhost:/.test(text)) problems.push(path.relative(PUBLIC_DIR, abs));
      }
    }
  };
  walk(PUBLIC_DIR);
  assert.deepEqual(problems, [], 'browser code must only call the dashboard\'s own /api/ routes');
});
