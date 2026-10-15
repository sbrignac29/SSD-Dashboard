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
const fsp = require('node:fs/promises');
const { openDatabase, saveScan, togglePin, listProjects, latestScan, nodeApiProblem, DatabaseError, MIGRATIONS } = require('../src/db');
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

  it("a container the scan couldn't open keeps its shoots, and they can't turn Ready on old facts", async () => {
    // A finished shoot, edited 10 days before the first scan: Review ("Ready in 4 days").
    file('NCHS Football/Week 2/Exports/Highlights FD.mp4', 400, 10);
    try {
      await save(NOW);
      assert.equal(row('NCHS Football/Week 2').bucket, 'Review');

      // Five days later macOS refuses to let the scan open "NCHS Football".
      const realReaddir = fsp.readdir;
      fsp.readdir = async (dir, ...rest) => {
        if (path.basename(dir) === 'NCHS Football') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return realReaddir(dir, ...rest);
      };
      let result;
      try {
        result = await save(NOW + 5 * DAY);
      } finally {
        fsp.readdir = realReaddir;
      }
      assert.ok(result.scan.warnings.some((w) => w.includes("Couldn't open container folder")));
      assert.equal(result.markedMissing, 0);
      const week2 = row('NCHS Football/Week 2');
      assert.equal(week2.missing, 0, 'not reported as gone');
      assert.equal(week2.incomplete, 1, 'flagged: its facts are from an older scan');
      assert.notEqual(week2.bucket, 'Ready', '15 days old by now, but nobody could check it');
      assert.match(week2.score_notes, /couldn't be read/);

      // The next scan that can read it clears the flag.
      await save(NOW + 6 * DAY);
      assert.equal(row('NCHS Football/Week 2').incomplete, 0);
      assert.equal(row('NCHS Football/Week 2').bucket, 'Ready');
    } finally {
      fs.rmSync(path.join(ssd, 'NCHS Football/Week 2'), { recursive: true, force: true });
    }
  });

  it('a --root scan (one folder, or another drive) is never saved', async () => {
    const partial = await scanDrive(testConfig(), { root: path.join(ssd, 'NCHS Football'), now: NOW });
    assert.equal(partial.scope, 'partial');
    assert.throws(() => saveScan(db, partial, testConfig()), /Only full scans of the Working SSD/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
  });
});

describe('upgrading the database', () => {
  it('a database made by an earlier version is upgraded in place, keeping its rows', async () => {
    // Build a version-1 file by hand, the way the first Phase 2 build left
    // it, with one saved (and pinned) project in it.
    const file = path.join(base, 'from-version-1.db');
    const Database = require('better-sqlite3');
    const old = new Database(file);
    old.exec(MIGRATIONS[0]);
    old.pragma('user_version = 1');
    const firstSeen = '2026-01-01T00:00:00.000Z';
    const { lastInsertRowid } = old
      .prepare(
        `INSERT INTO projects (path, name, kind, size_bytes, raw_bytes, proxy_bytes, export_bytes, cache_bytes,
           project_bytes, other_bytes, file_count, has_export, has_final_export, first_seen, last_scanned, pinned_keep)
         VALUES ('Old Finished', 'Old Finished', 'project', 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, ?, ?, 1)`,
      )
      .run(firstSeen, firstSeen);
    old.close();

    db.close();
    db = openDatabase({ file }); // upgrades it (afterEach closes it)
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const kept = row('Old Finished');
    assert.equal(kept.id, Number(lastInsertRowid));
    assert.equal(kept.newer_footage_file, null);

    // The next scans update that same row, and keep its pin and first_seen.
    await save(NOW);
    await save(NOW + HOUR);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 5);
    const updated = row('Old Finished');
    assert.equal(updated.id, kept.id);
    assert.equal(updated.first_seen, firstSeen);
    assert.equal(updated.size_bytes, 6000);
    assert.equal(updated.pinned_keep, 1);
    assert.equal(updated.bucket, 'Keep');
  });

  it('a read-only command asks for a scan instead of upgrading', () => {
    const file = path.join(base, 'needs-upgrade.db');
    const Database = require('better-sqlite3');
    const old = new Database(file);
    old.exec(MIGRATIONS[0]);
    old.pragma('user_version = 1');
    old.close();
    assert.throws(() => openDatabase({ file, readonly: true }), /Run `npm run scan` once/);
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

  it("refuses a database file that is a shortcut, even to a file that doesn't exist yet", () => {
    // e.g. data/dashboard.db -> /Volumes/BRIGSMEDIA/dashboard.db (not there yet)
    const target = path.join(os.tmpdir(), `ssd-dashboard-must-not-be-created-${process.pid}-${dbCount}.db`);
    const link = path.join(base, 'dangling-shortcut.db');
    fs.symlinkSync(target, link);
    assert.throws(() => openDatabase({ file: link }), /shortcut \(symlink\)/);
    assert.equal(fs.existsSync(target), false, 'nothing may be created where the shortcut points');
  });

  it('explains a too-old Node.js instead of crashing', () => {
    assert.match(nodeApiProblem('9'), /needs Node 22\.14 or newer/);
    assert.equal(nodeApiProblem('10'), null);
    assert.equal(nodeApiProblem(process.versions.napi), null, 'the Node running these tests is new enough');
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

  it('footage newer than the final export still blocks Ready after a pin round-trip', async () => {
    // Game 1 is exported as final; Game 2 was shot later and isn't edited yet.
    file('Two Games/Exports/Game 1 FD.mp4', 800, 100);
    file('Two Games/Footage/game1.mov', 3000, 101);
    file('Two Games/Footage/game2.mov', 3000, 30);
    try {
      const config = testConfig();
      await save(NOW);
      const before = row('Two Games');
      assert.equal(before.has_final_export, 1);
      assert.equal(before.newer_footage_file, 'Footage/game2.mov');
      assert.equal(before.bucket, 'Review');

      togglePin(db, config, 'Two Games');
      assert.equal(row('Two Games').bucket, 'Keep');
      togglePin(db, config, 'Two Games'); // unpin: re-scored from the saved row
      assert.equal(row('Two Games').bucket, 'Review');
      assert.match(row('Two Games').score_notes, /newer than its final export/);
    } finally {
      fs.rmSync(path.join(ssd, 'Two Games'), { recursive: true, force: true });
    }
  });

  it('after a rename that only changes upper/lower case, pin finds the project still on the SSD', async () => {
    const config = testConfig();
    await save(NOW);
    togglePin(db, config, 'Fresh Edit'); // pinned under its old name
    fs.renameSync(path.join(ssd, 'Fresh Edit'), path.join(ssd, 'fresh edit'));
    try {
      await save(NOW + HOUR); // old name: missing (and pinned); new name: a new row
      const outcome = togglePin(db, config, 'fresh edit');
      assert.equal(outcome.result, 'pinned');
      assert.equal(outcome.project.relPath, 'fresh edit');
      assert.equal(row('fresh edit').pinned_keep, 1);
      // The pin moved to the new spelling; none is left on the old row, where
      // `npm run pin` could never reach it.
      assert.equal(row('Fresh Edit').pinned_keep, 0);
      assert.equal(togglePin(db, config, 'Fresh Edit').result, 'unpinned');
      assert.equal(listProjects(db).filter((p) => p.pinnedInDatabase).length, 0);
    } finally {
      fs.renameSync(path.join(ssd, 'fresh edit'), path.join(ssd, 'Fresh Edit'));
    }
  });

  it("pinning a project that's no longer on the SSD doesn't show its old bucket as current", async () => {
    const config = testConfig();
    await save(NOW);
    const away = path.join(base, 'moved-away-pin');
    fs.renameSync(path.join(ssd, 'Gone Soon'), away);
    try {
      await save(NOW + HOUR);
      const outcome = togglePin(db, config, 'Gone Soon');
      assert.equal(outcome.result, 'pinned');
      assert.equal(outcome.project.missing, true);
      assert.equal(outcome.project.scoring, null);
    } finally {
      fs.renameSync(away, path.join(ssd, 'Gone Soon'));
    }
  });

  it("a missing project pinned in config.json gets no stale bucket from npm run pin", async () => {
    await save(NOW);
    const away = path.join(base, 'moved-away-config');
    fs.renameSync(path.join(ssd, 'Gone Soon'), away);
    try {
      await save(NOW + HOUR);
      const outcome = togglePin(db, testConfig({ keepPinned: ['Gone Soon'] }), 'Gone Soon');
      assert.equal(outcome.result, 'pinned-in-config');
      assert.equal(outcome.project.missing, true);
      assert.equal(outcome.project.scoring, null);
    } finally {
      fs.renameSync(away, path.join(ssd, 'Gone Soon'));
    }
  });

  it('a project newly pinned in config.json shows as Keep after npm run pin', async () => {
    await save(NOW);
    assert.equal(row('Old Finished').bucket, 'Ready');
    const edited = testConfig({ keepPinned: ['Old Finished'] }); // config.json edited after the scan
    const outcome = togglePin(db, edited, 'Old Finished');
    assert.equal(outcome.result, 'pinned-in-config');
    assert.equal(outcome.project.scoring.bucket, 'Keep');
    assert.equal(row('Old Finished').bucket, 'Keep');
    assert.equal(row('Old Finished').pinned_keep, 0);
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
