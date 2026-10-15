'use strict';

// Tests for the dashboard server (src/server.js) and its API routes, over
// real HTTP, the way the browser talks to it.
//
// Like the other tests, the fake Working SSD and Library are built inside
// data/ and deleted afterwards, with their own test database. Drive sizes are
// faked (getSpaces), so the "Library is 92% full" banner can be tested.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DATA_DIR, withDefaults, isInside } = require('../src/config');
const { openDatabase } = require('../src/db');
const { scanAndSave } = require('../src/jobs/scanAndSave');
const { createApp } = require('../src/server');
const { createScanRunner, overallPercent } = require('../src/web/scanRunner');

const DAY = 24 * 60 * 60 * 1000;
const GB = 1e9;
const TB = 1e12;

let base;
let ssd;
let library;

function file(drive, rel, size, ageDays) {
  const abs = path.join(drive, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(size));
  const time = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(abs, time, time);
}

function snapshot(dir) {
  const result = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const stats = fs.lstatSync(abs);
      result[path.relative(dir, abs)] = { size: stats.size, mtimeMs: stats.mtimeMs };
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(dir);
  return result;
}

function configFor({ working = ssd, lib = library } = {}) {
  return withDefaults({
    drives: { working, library: lib, archive: '' },
    folders: { ignore: [], shared: ['Resolve Project Library'], containers: ['NCHS Football'], keepPinned: [] },
  });
}

// Fake drive sizes: the Library is 92% full unless a test says otherwise.
function fakeSpaces(libraryUsedPercent = 92) {
  return async (config) =>
    ['working', 'library', 'archive']
      .filter((drive) => config.drives[drive])
      .map((drive) => {
        const connected = fs.existsSync(config.drives[drive]);
        const total = 2 * TB;
        const used = drive === 'library' ? (libraryUsedPercent / 100) * total : 1.2 * TB;
        return {
          drive,
          path: config.drives[drive],
          space: connected ? { totalBytes: total, freeBytes: total - used, usedBytes: used, usedPercent: (used / total) * 100 } : null,
        };
      });
}

let dbCount = 0;

// Starts a server on a free port with its own empty database.
//   config       – the settings the server sees
//   scanAndSave  – optionally a fake (e.g. one that waits, to look at progress)
async function startServer({ config = configFor(), libraryUsedPercent, scanAndSave: scanStep } = {}) {
  dbCount += 1;
  const db = openDatabase({ file: path.join(base, `server-${dbCount}.db`) });
  const runner = createScanRunner({ db, getConfig: () => config, scanAndSave: scanStep, log: { error() {} } });
  const app = createApp({ db, runner, getConfig: () => config, getSpaces: fakeSpaces(libraryUsedPercent) });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, { method = 'GET', json = method === 'POST' } = {}) => {
    const response = await fetch(url + route, {
      method,
      headers: json ? { 'Content-Type': 'application/json' } : {},
      body: method === 'POST' ? '{}' : undefined,
    });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, body: type.includes('json') ? await response.json() : await response.text() };
  };
  // Presses Scan now and waits until it's finished.
  const scanNow = async () => {
    const started = await call('/api/scan', { method: 'POST' });
    for (let i = 0; i < 200; i += 1) {
      const { body } = await call('/api/scan');
      if (!body.running) return { started, final: body };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the scan never finished');
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  };
  return { db, url, call, scanNow, stop, server };
}

before(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  base = fs.mkdtempSync(path.join(DATA_DIR, '.test-server-'));
  ssd = path.join(base, 'ssd');
  library = path.join(base, 'library');

  // Working SSD
  file(ssd, 'Old Finished/Footage/Card A/a.mov', 5000, 200); // Ready (finished + old, the biggest)
  file(ssd, 'Old Finished/Exports/Old FD.mp4', 1000, 200);
  file(ssd, 'Fresh Edit/b.mov', 1000, 2); // Keep (unfinished, recent)
  file(ssd, 'NCHS Football/Week 1/Footage/clip.mov', 3000, 150); // Check first (old, big, unfinished)
  file(ssd, 'NCHS Football/Week 2/Exports/Week 2 FD.mp4', 400, 3); // Check first (finished, but edited 3 days ago)
  file(ssd, 'Resolve Project Library/Project.db', 100, 1); // shared

  // Library HDD
  file(library, 'Oldest Shoot/Footage/a.mov', 400 * 1000, 500);
  file(library, 'Middle Shoot/Footage/a.mov', 300 * 1000, 300);
  file(library, 'Newest Shoot/Footage/a.mov', 200 * 1000, 40);
});

after(() => {
  if (base && isInside(base, DATA_DIR) && base !== DATA_DIR) fs.rmSync(base, { recursive: true, force: true });
});

describe('starting the server', () => {
  it('scans nothing until Scan now is pressed', async () => {
    const server = await startServer();
    try {
      assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM scans').get().n, 0);
      const { body: scan } = await server.call('/api/scan');
      assert.deepEqual([scan.running, scan.outcome], [false, null]);
      const { body: summary } = await server.call('/api/summary');
      assert.equal(summary.hasScan, false);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM scans').get().n, 0, 'still no scan');
    } finally {
      await server.stop();
    }
  });

  it('serves the pages and the two browser libraries', async () => {
    const server = await startServer();
    try {
      for (const page of ['/', '/project.html', '/library.html', '/styles.css', '/js/common.js']) {
        assert.equal((await server.call(page)).status, 200, page);
      }
      assert.equal((await server.call('/vendor/alpine.min.js')).status, 200);
      assert.equal((await server.call('/vendor/chart.umd.min.js')).status, 200);
      assert.equal((await server.call('/vendor/constructor')).status, 404);
      assert.equal((await server.call('/api/nothing-here')).status, 404);
    } finally {
      await server.stop();
    }
  });
});

describe('unplugged drives', () => {
  it('show as not connected with their last scan, never as errors', async () => {
    const config = configFor();
    const server = await startServer({ config });
    try {
      await server.scanNow();
      // Now "unplug" both: the same database, settings pointing at missing folders.
      const unplugged = configFor({ working: path.join(base, 'unplugged-ssd'), lib: path.join(base, 'unplugged-lib') });
      const db = server.db;
      const runner = createScanRunner({ db, getConfig: () => unplugged });
      const app = createApp({ db, runner, getConfig: () => unplugged, getSpaces: fakeSpaces() });
      const offline = http.createServer(app);
      await new Promise((resolve) => offline.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${offline.address().port}`;
      try {
        const drives = await (await fetch(`${url}/api/drives`)).json();
        for (const drive of drives.drives) {
          assert.equal(drive.connected, false, drive.drive);
          assert.ok(drive.lastScan?.at, `${drive.drive} still shows when it was last scanned`);
          assert.ok(drive.lastKnownSpace, `${drive.drive} still shows how full it was`);
        }
        const projects = await (await fetch(`${url}/api/projects`)).json();
        assert.equal(projects.projects.length, 4, 'the last scan is still listed');
        const summary = await (await fetch(`${url}/api/summary`)).json();
        assert.deepEqual([summary.working.connected, summary.working.lastKnown], [false, true]);
        const lib = await (await fetch(`${url}/api/library`)).json();
        assert.deepEqual([lib.connected, lib.spaceIsLastKnown, lib.projects.length], [false, true, 3]);
        // Scan now with nothing plugged in: a calm "nothing to scan", not an error.
        const response = await fetch(`${url}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const answer = await response.json();
        assert.equal(response.status, 200);
        assert.deepEqual([answer.started, answer.reason], [false, 'nothing-connected']);
        assert.match(answer.message, /plug in/);
      } finally {
        offline.closeAllConnections();
        await new Promise((resolve) => offline.close(resolve));
      }
    } finally {
      await server.stop();
    }
  });

  it('a Library that is unplugged is skipped (no failed scan recorded)', async () => {
    const server = await startServer({ config: configFor({ lib: path.join(base, 'not-plugged-in') }) });
    try {
      const { final } = await server.scanNow();
      assert.equal(final.outcome, 'saved');
      assert.deepEqual(
        final.steps.map((s) => [s.drive, s.state]),
        [
          ['working', 'saved'],
          ['library', 'skipped'],
        ],
      );
      assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM scans WHERE status = 'failed'").get().n, 0);
      const { body } = await server.call('/api/library');
      assert.deepEqual([body.connected, body.lastScan, body.projects], [false, null, []]);
    } finally {
      await server.stop();
    }
  });
});

describe('Scan now', () => {
  it('runs in the background and reports progress; a second press waits for the first', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // A scan step that reports some progress, then waits until the test lets it finish.
    const slowScan = async (args) => {
      args.onProgress({ name: 'Old Finished', filesScanned: 3, foldersDone: 1, foldersTotal: 4 });
      await gate;
      return scanAndSave(args);
    };
    const server = await startServer({ scanAndSave: slowScan });
    try {
      const started = await server.call('/api/scan', { method: 'POST' });
      assert.equal(started.status, 202);
      assert.equal(started.body.running, true);

      const { body: progress } = await server.call('/api/scan');
      assert.equal(progress.running, true);
      assert.match(progress.message, /Scanning Working SSD · 3 files · Old Finished/);
      assert.equal(progress.percent, 12.5, 'first of two drives, 1 of 4 folders done');

      const again = await server.call('/api/scan', { method: 'POST' });
      assert.deepEqual([again.status, again.body.started, again.body.reason], [200, false, 'already-running']);

      release();
      let final;
      for (let i = 0; i < 200 && (!final || final.running); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        final = (await server.call('/api/scan')).body;
      }
      assert.equal(final.outcome, 'saved');
      assert.equal(final.percent, 100);
      assert.deepEqual(
        final.steps.map((s) => [s.drive, s.state]),
        [
          ['working', 'saved'],
          ['library', 'saved'],
        ],
      );
      assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM scans WHERE status = 'finished'").get().n, 2);
    } finally {
      release();
      await server.stop();
    }
  });

  it('changes nothing on the drives', async () => {
    const server = await startServer();
    try {
      const before = [snapshot(ssd), snapshot(library)];
      await server.scanNow();
      assert.deepEqual([snapshot(ssd), snapshot(library)], before);
    } finally {
      await server.stop();
    }
  });

  it('the progress percentage weighs drives by their last file counts', () => {
    const step = (state, expectedFiles, filesScanned = 0) => ({ state, expectedFiles, filesScanned, foldersDone: 0, foldersTotal: 0 });
    assert.equal(overallPercent([step('scanning', 300, 150), step('waiting', 100)]), 37.5);
    assert.equal(overallPercent([step('saved', 300), step('scanning', 100, 50)]), 87.5);
    assert.equal(overallPercent([step('skipped', null), step('scanning', 100, 50)]), 50);
  });
});

describe('the API after a scan', () => {
  let server;

  before(async () => {
    server = await startServer();
    await server.scanNow();
  });

  after(() => server.stop());

  it('GET /api/drives: each drive, connected, used/free, last scanned', async () => {
    const { body } = await server.call('/api/drives');
    assert.deepEqual(
      body.drives.map((d) => [d.drive, d.connected, d.scannedByButton]),
      [
        ['working', true, true],
        ['library', true, true],
      ],
    );
    const lib = body.drives[1];
    assert.equal(Math.round(lib.space.usedPercent), 92);
    assert.equal(lib.limitPercent, 90);
    assert.ok(lib.lastScan.at);
  });

  it('GET /api/summary: the space you could free (the Ready projects)', async () => {
    const { body } = await server.call('/api/summary');
    assert.equal(body.hasScan, true);
    assert.deepEqual(body.ready, { count: 1, bytes: 6000 });
    assert.deepEqual(
      Object.fromEntries(Object.entries(body.tagCounts).map(([tag, c]) => [tag, c.count])),
      { ready: 1, check: 2, keep: 1, pinned: 0 },
    );
    assert.equal(body.shared.count, 1);
  });

  it('GET /api/projects: sorted by score, with a plain-language tag first', async () => {
    const { body } = await server.call('/api/projects');
    const scores = body.projects.map((p) => p.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    const old = body.projects.find((p) => p.name === 'Old Finished');
    assert.deepEqual([old.tag, old.status], ['ready', null]);
    assert.equal(body.tags.find((t) => t.id === 'ready').label, 'Ready to move to HDD');
    const week2 = body.projects.find((p) => p.name === 'NCHS Football / Week 2');
    assert.equal(week2.tag, 'check');
    assert.match(week2.reason, /Edited recently — can be ready/);
  });

  it('GET /api/projects: filters for tag, client and date range', async () => {
    const names = async (query) => (await server.call(`/api/projects?${query}`)).body.projects.map((p) => p.name).sort();
    assert.deepEqual(await names('tag=ready'), ['Old Finished']);
    assert.deepEqual(await names('tag=check'), ['NCHS Football / Week 1', 'NCHS Football / Week 2']);
    assert.deepEqual(await names('client=NCHS%20Football'), ['NCHS Football / Week 1', 'NCHS Football / Week 2']);
    assert.deepEqual(await names('client='), ['Fresh Edit', 'Old Finished'], 'client= means "no client"');
    const day = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toLocaleDateString('en-CA'); // YYYY-MM-DD, local
    assert.deepEqual(await names(`from=${day(10)}`), ['Fresh Edit', 'NCHS Football / Week 2']);
    assert.deepEqual(await names(`from=${day(400)}&to=${day(100)}`), ['NCHS Football / Week 1', 'Old Finished']);
    // The tag counts follow the other filters.
    const { body } = await server.call('/api/projects?client=NCHS%20Football&tag=ready');
    assert.deepEqual([body.projects.length, body.tagCounts.check], [0, 2]);
    assert.deepEqual(body.clients, ['NCHS Football']);
  });

  it('GET /api/projects: a bad filter gets a clear 400 answer', async () => {
    for (const query of ['tag=maybe', 'from=yesterday', 'drive=archive', 'from=2026-10-10&to=2026-10-01', 'tag=ready&tag=keep']) {
      const { status, body } = await server.call(`/api/projects?${query}`);
      assert.equal(status, 400, query);
      assert.ok(body.error, query);
    }
  });

  it('GET /api/projects/:id: every scoring signal and the biggest subfolders', async () => {
    const list = (await server.call('/api/projects')).body.projects;
    const id = list.find((p) => p.name === 'Old Finished').id;
    const { body } = await server.call(`/api/projects/${id}`);
    assert.equal(body.scoring.tagLabel, 'Ready to move to HDD');
    assert.deepEqual(
      body.scoring.checks.map((c) => [c.id, c.state]),
      [
        ['finished', 'pass'],
        ['untouched', 'pass'],
        ['newer-footage', 'pass'],
        ['dates', 'pass'],
        ['readable', 'pass'],
        ['pinned', 'pass'],
        ['notion', 'na'],
      ],
    );
    const points = body.scoring.parts.reduce((sum, part) => sum + part.value * part.weight, 0);
    assert.equal(Math.round(points * 10) / 10, body.scoring.score);
    assert.equal(body.scoring.stale, false);
    assert.deepEqual(
      body.tree.folders.map((f) => [f.name, f.sizeBytes, f.children.map((c) => c.name)]),
      [
        ['Footage', 5000, ['Card A']],
        ['Exports', 1000, []],
      ],
    );
    assert.equal((await server.call('/api/projects/99999')).status, 404);
    assert.equal((await server.call('/api/projects/abc')).status, 404);
  });

  it('POST /api/projects/:id/pin toggles Keep', async () => {
    const list = (await server.call('/api/projects')).body.projects;
    const id = list.find((p) => p.name === 'Old Finished').id;
    const pinned = await server.call(`/api/projects/${id}/pin`, { method: 'POST' });
    assert.deepEqual([pinned.status, pinned.body.result], [200, 'pinned']);
    let detail = (await server.call(`/api/projects/${id}`)).body;
    assert.equal(detail.scoring.tag, 'pinned');
    assert.equal(detail.scoring.checks.find((c) => c.id === 'pinned').state, 'fail');
    assert.equal((await server.call('/api/summary')).body.ready.count, 0);

    const unpinned = await server.call(`/api/projects/${id}/pin`, { method: 'POST' });
    assert.equal(unpinned.body.result, 'unpinned');
    detail = (await server.call(`/api/projects/${id}`)).body;
    assert.equal(detail.scoring.tag, 'ready');
  });

  it('GET /api/library: Library projects oldest first, and what to move to the Archive past the limit', async () => {
    const { body } = await server.call('/api/library');
    assert.deepEqual(body.projects.map((p) => p.name), ['Oldest Shoot', 'Middle Shoot', 'Newest Shoot']);
    assert.equal(body.plan.status, 'full-now'); // 92% ≥ 90%
    // Down to 70% of 2 TB = 1.4 TB: 1.84 TB − 1.4 TB = 440 GB to move.
    assert.equal(Math.round(body.plan.bytesToFree / GB), 440);
    // The fake projects are tiny, so every dated one is listed, oldest first, and it's not enough.
    assert.deepEqual(body.plan.moves.map((p) => p.name), ['Oldest Shoot', 'Middle Shoot', 'Newest Shoot']);
    assert.equal(body.plan.enough, false);
    assert.ok(body.projects.every((p) => p.suggested));
    assert.equal((await server.call('/api/projects?drive=library')).body.projects[0].name, 'Oldest Shoot');
  });
});

describe('a Library with room', () => {
  it('shows no Archive list', async () => {
    const server = await startServer({ libraryUsedPercent: 50 });
    try {
      await server.scanNow();
      const { body } = await server.call('/api/library');
      assert.equal(body.plan.status, 'ok');
      assert.deepEqual(body.plan.moves, []);
      assert.ok(body.projects.every((p) => !p.suggested));
    } finally {
      await server.stop();
    }
  });
});

describe('guards', () => {
  it('buttons (POST) must send JSON, so other websites cannot press them', async () => {
    const server = await startServer();
    try {
      const { status } = await server.call('/api/scan', { method: 'POST', json: false });
      assert.equal(status, 415);
      assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM scans').get().n, 0, 'nothing was scanned');
    } finally {
      await server.stop();
    }
  });

  it('only answers requests addressed to localhost', async () => {
    const server = await startServer();
    try {
      const { port } = server.server.address();
      const status = await new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/api/summary', headers: { Host: `evil.example:${port}` } }, (res) => {
            res.resume();
            resolve(res.statusCode);
          })
          .on('error', reject);
      });
      assert.equal(status, 403);
    } finally {
      await server.stop();
    }
  });
});
