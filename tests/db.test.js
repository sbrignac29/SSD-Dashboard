'use strict';

// Tests for the database (src/db.js) and the "scan, then save" job.
//
// Like tests/scan.test.js, this builds a small fake SSD inside data/ (the one
// folder the app may write to), plus test databases next to it. It never
// touches your real data/dashboard.db, and everything is deleted afterwards.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DATA_DIR, withDefaults, isInside } = require('../src/config');
const { scanDrive, ScanError } = require('../src/scanner/scan');
const { openDatabase, saveScan, togglePin, listProjects, latestScan, DatabaseError } = require('../src/db');
const { scanAndSave } = require('../src/jobs/scanAndSave');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-15T12:00:00Z');

let base; // the test folder inside data/
let ssd; // the fake SSD inside it
let dbCount = 0;
let db;

// Creates a file of `size` bytes whose modified time is `ageDays` before NOW.
function file(rel, size, ageDays) {
  const abs = path.join(ssd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(size));
  const time = new Date(NOW - ageDays * DAY);
  fs.utimesSync(abs, time, time);
}

// Records every file's size and modified time, to prove a scan changes nothing.
function snapshot(dir) {
  const result = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const stats = fs.lstatSync(abs);
      result[path.relative(dir, abs)] = { size: stats.size, mtimeMs: stats.mtimeMs, isDir: stats.isDirectory() };
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(dir);
  return result;
}

function testConfig(folders = {}) {
  return withDefaults({
    drives: { working: ssd, library: '', archive: '' },
    folders: { ignore: [], shared: ['Resolve Project Library'], containers: ['NCHS Football'], keepPinned: [], ...folders },
  });
}

// One full scan + save, as `npm run scan` and the nightly job do it.
function save(now = NOW, config = testConfig()) {
  return scanAndSave({ config, db, now });
}

function row(projectPath) {
  const found = db.prepare('SELECT * FROM projects WHERE path = ?').get(projectPath);
  assert.ok(found, `expected a row for "${projectPath}"`);
  return found;
}

before(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  base = fs.mkdtempSync(path.join(DATA_DIR, '.test-db-'));
  ssd = path.join(base, 'ssd');

  // Finished (a video export named "final"), untouched 200 days, the biggest:
  // 0.45×70 + 0.35×100 + 0.20×100 = 86.5 → Ready
  file('Old Finished/Footage/a.mov', 5000, 200);
  file('Old Finished/Exports/final.mp4', 1000, 200);
  // Unfinished, edited 2 days ago → Keep
  file('Fresh Edit/b.mov', 1000, 2);
  // An unfinished container shoot: 0.35×100 + 0.20×50 = 45 → Review
  file('NCHS Football/Week 1/clip.mov', 3000, 150);
  file('Gone Soon/c.mov', 500, 30);
  file('Resolve Project Library/Projects/QB Era/Project.db', 100, 1);
});

after(() => {
  if (base && isInside(base, DATA_DIR) && base !== DATA_DIR) fs.rmSync(base, { recursive: true, force: true });
});

// A fresh, empty test database for every test.
beforeEach(() => {
  dbCount += 1;
  db = openDatabase({ file: path.join(base, `test-${dbCount}.db`) });
});
afterEach(() => db.close());

describe('saving scans', () => {
  it('scanning twice creates no duplicate rows', async () => {
    const first = await save(NOW);
    const second = await save(NOW + HOUR);

    const paths = db.prepare('SELECT path FROM projects').all().map((r) => r.path);
    assert.equal(paths.length, 5); // 4 projects + 1 shared folder
    assert.equal(new Set(paths).size, paths.length, 'every path appears once');
    assert.deepEqual([first.added, first.updated], [5, 0]);
    assert.deepEqual([second.added, second.updated], [0, 5]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scans WHERE status = 'finished'").get().n, 2);

    // The rescan updated the rows: first_seen kept, last_scanned moved on.
    const old = row('Old Finished');
    assert.equal(old.first_seen, new Date(NOW).toISOString());
    assert.equal(old.last_scanned, new Date(NOW + HOUR).toISOString());
  });

  it('a rescan updates the existing row', async () => {
    await save(NOW);
    const before = row('Fresh Edit');
    file('Fresh Edit/new-render.mov', 700, 1);
    try {
      await save(NOW + HOUR);
      const after = row('Fresh Edit');
      assert.equal(after.id, before.id);
      assert.equal(after.size_bytes, before.size_bytes + 700);
      assert.equal(after.file_count, before.file_count + 1);
    } finally {
      fs.rmSync(path.join(ssd, 'Fresh Edit/new-render.mov'));
    }
  });

  it('a project that disappears is marked missing, not deleted — and comes back', async () => {
    await save(NOW);
    const before = row('Gone Soon');
    const away = path.join(base, 'moved-away');
    fs.renameSync(path.join(ssd, 'Gone Soon'), away); // "offloaded"
    try {
      const result = await save(NOW + HOUR);
      assert.equal(result.markedMissing, 1);
      const gone = row('Gone Soon');
      assert.equal(gone.missing, 1);
      assert.equal(gone.last_scanned, new Date(NOW).toISOString(), 'last seen by the first scan');
      assert.equal(row('Old Finished').missing, 0);
      assert.ok(!result.projects.some((p) => p.relPath === 'Gone Soon'), 'missing projects are not ranked');
    } finally {
      fs.renameSync(away, path.join(ssd, 'Gone Soon'));
    }

    const back = await save(NOW + 2 * HOUR);
    assert.equal(back.returned, 1);
    const returned = row('Gone Soon');
    assert.equal(returned.missing, 0);
    assert.equal(returned.id, before.id);
    assert.equal(returned.first_seen, before.first_seen);
  });

  it('saves the facts the plan asks for', async () => {
    await save(NOW);
    const old = row('Old Finished');
    assert.equal(old.size_bytes, 6000);
    assert.deepEqual(
      [old.raw_bytes, old.proxy_bytes, old.export_bytes, old.cache_bytes, old.project_bytes, old.other_bytes],
      [5000, 0, 1000, 0, 0, 0],
    );
    assert.equal(old.has_export, 1);
    assert.equal(old.export_file, 'Exports/final.mp4');
    assert.equal(old.has_final_export, 1);
    assert.equal(old.final_export_file, 'Exports/final.mp4');
    assert.equal(old.last_modified, new Date(NOW - 200 * DAY).toISOString());
    assert.equal(old.last_nle_save, null);
    assert.equal(old.score, 86.5);
    assert.equal(old.bucket, 'Ready');

    const week1 = row('NCHS Football/Week 1');
    assert.equal(week1.name, 'NCHS Football / Week 1');
    assert.equal(week1.client, 'NCHS Football');

    const library = row('Resolve Project Library');
    assert.equal(library.kind, 'shared');
    assert.equal(library.score, null);
    assert.equal(library.bucket, null);

    const scan = latestScan(db, 'finished');
    assert.equal(scan.projectCount, 4);
    assert.equal(scan.totalBytes, 6000 + 1000 + 3000 + 500 + 100);
  });

  it('a failed scan is recorded, and changes no projects', async () => {
    await save(NOW);
    const unplugged = withDefaults({ ...testConfig(), drives: { working: path.join(base, 'not-plugged-in'), library: '', archive: '' } });
    await assert.rejects(save(NOW + HOUR, unplugged), ScanError);

    const failed = latestScan(db);
    assert.equal(failed.status, 'failed');
    assert.match(failed.errors[0], /Is the drive plugged in\?/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE missing = 1').get().n, 0);
  });

  it('a --root scan (one folder, or another drive) is never saved', async () => {
    const partial = await scanDrive(testConfig(), { root: path.join(ssd, 'NCHS Football'), now: NOW });
    assert.equal(partial.scope, 'partial');
    assert.throws(() => saveScan(db, partial, testConfig()), /Only full scans of the Working SSD/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
  });
});

describe('safety', () => {
  it('scanning and saving changes nothing on the SSD', async () => {
    const before = snapshot(ssd);
    await save(NOW);
    assert.deepEqual(snapshot(ssd), before);
  });

  it('refuses a database anywhere outside data/', () => {
    for (const outside of [path.join(os.tmpdir(), 'dashboard.db'), path.join(DATA_DIR, '..', 'dashboard.db'), DATA_DIR]) {
      assert.throws(() => openDatabase({ file: outside }), DatabaseError, outside);
    }
  });

  it('refuses a database reached through a shortcut that leads out of data/', () => {
    const link = path.join(base, 'shortcut-out');
    fs.symlinkSync(os.tmpdir(), link);
    assert.throws(() => openDatabase({ file: path.join(link, 'dashboard.db') }), /outside the app's data\/ folder/);
  });

  it('read-only mode never creates a database', () => {
    const notThere = path.join(base, 'never-created.db');
    assert.throws(() => openDatabase({ file: notThere, readonly: true }), /Run `npm run scan` first/);
    assert.equal(fs.existsSync(notThere), false);
  });
});

describe('pins', () => {
  it('a pinned project never scores Ready — through rescans, until unpinned', async () => {
    const config = testConfig();
    await save(NOW);
    assert.equal(row('Old Finished').bucket, 'Ready');

    const pinned = togglePin(db, config, 'old finished'); // any upper/lower case
    assert.equal(pinned.result, 'pinned');
    assert.equal(pinned.project.scoring.bucket, 'Keep');
    assert.match(pinned.project.scoring.notes[0], /Pinned as Keep \(would be Ready\)/);
    assert.equal(pinned.project.scoring.score, 86.5, 'the score still shows what it would be');
    assert.equal(row('Old Finished').bucket, 'Keep');

    // Still Keep after more scans, even as it gets older.
    await save(NOW + 30 * DAY);
    await save(NOW + 60 * DAY);
    assert.equal(row('Old Finished').pinned_keep, 1);
    assert.equal(row('Old Finished').bucket, 'Keep');

    const unpinned = togglePin(db, config, 'Old Finished');
    assert.equal(unpinned.result, 'unpinned');
    assert.equal(row('Old Finished').bucket, 'Ready');
  });

  it('pinning changes only the pinned project', async () => {
    const config = testConfig();
    await save(NOW);
    const scoresBefore = db.prepare("SELECT path, score, bucket FROM projects WHERE path <> 'Old Finished' ORDER BY path").all();
    togglePin(db, config, 'Old Finished');
    const scoresAfter = db.prepare("SELECT path, score, bucket FROM projects WHERE path <> 'Old Finished' ORDER BY path").all();
    assert.deepEqual(scoresAfter, scoresBefore);
  });

  it('a pin in config.json is respected, and npm run pin explains it can\'t remove it', async () => {
    const config = testConfig({ keepPinned: ['NCHS Football'] });
    await save(NOW, config);
    assert.equal(row('NCHS Football/Week 1').bucket, 'Keep');

    const outcome = togglePin(db, config, 'NCHS Football / Week 1');
    assert.equal(outcome.result, 'pinned-in-config');
    assert.equal(row('NCHS Football/Week 1').pinned_keep, 0);
  });

  it('finds projects by report name or path, and suggests near misses', async () => {
    const config = testConfig();
    await save(NOW);
    assert.equal(togglePin(db, config, 'nchs football / week 1').result, 'pinned');
    assert.equal(togglePin(db, config, 'NCHS Football/Week 1').result, 'unpinned');

    const notFound = togglePin(db, config, 'week');
    assert.equal(notFound.result, 'not-found');
    assert.deepEqual(notFound.suggestions, ['NCHS Football / Week 1']);

    assert.equal(togglePin(db, config, 'Resolve Project Library').result, 'shared');
    assert.equal(listProjects(db).filter((p) => p.pinnedInDatabase).length, 0);
  });
});
