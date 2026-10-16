'use strict';

// Tests for moves (Phase 5A): the pre-checks, starting a copy in VeriCopy,
// following it to the end, and the spot check. They use a fake VeriCopy
// (tests/fakeVericopy.js) and fake drives inside data/.test-moves-*, never
// the real app or a real drive.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DATA_DIR, withDefaults } = require('../src/config');
const { openDatabase, listProjects, getMove, createMove, updateMove } = require('../src/db');
const { scanAndSave } = require('../src/jobs/scanAndSave');
const { createMover, driveProblem } = require('../src/offload/moves');
const { moveView } = require('../src/web/views');
const { createApp } = require('../src/server');
const { createScanRunner } = require('../src/web/scanRunner');
const { createNotionSyncer } = require('../src/notion/sync');
const { fakeNotion } = require('./fakeNotion');
const { startFakeVericopy, closedPort } = require('./fakeVericopy');

const DAY = 24 * 60 * 60 * 1000;
const TB = 1e12;

let base;
let fake;
let worldCount = 0;

function file(drive, rel, size, ageDays) {
  const abs = path.join(drive, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(size, 7));
  const time = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(abs, time, time);
}

// Every file and folder under `dir`, with sizes and dates: to prove nothing changed.
function snapshot(dir) {
  const result = {};
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const abs = path.join(entry.parentPath, entry.name);
    const stats = fs.lstatSync(abs);
    result[path.relative(dir, abs)] = { size: stats.size, mtimeMs: stats.mtimeMs, dir: stats.isDirectory() };
  }
  return result;
}

// Fake drive sizes (statfs can't be faked): the Library is 92% full unless told otherwise.
//   libraryTotal – a tiny Library (bytes) makes Move 2's list as small as the test files
function fakeSpaces(libraryUsedPercent, libraryTotal = 2 * TB) {
  return async (config) =>
    ['working', 'library', 'archive']
      .filter((drive) => config.drives[drive])
      .map((drive) => {
        const total = drive === 'library' ? libraryTotal : 2 * TB;
        const used = drive === 'library' ? (libraryUsedPercent / 100) * total : 0.5 * TB;
        return { drive, path: config.drives[drive], space: { totalBytes: total, freeBytes: total - used, usedBytes: used, usedPercent: (used / total) * 100 } };
      });
}

// A fresh set of fake drives, a database with both drives scanned, and a mover.
//   url      – VeriCopy's address (the fake's, unless a test wants another)
//   freeBytes – free space the destination reports
async function world({ url = fake.url, freeBytes = TB, libraryUsedPercent = 92, libraryTotal, withContainerOnLibrary = false } = {}) {
  worldCount += 1;
  const root = path.join(base, `world-${worldCount}`);
  const ssd = path.join(root, 'ssd');
  const library = path.join(root, 'library');
  const archive = path.join(root, 'archive');
  // Working SSD
  file(ssd, 'Old Finished/Footage/Card A/a.mov', 5000, 200); // Ready
  file(ssd, 'Old Finished/Footage/Card A/b.mov', 3000, 200);
  file(ssd, 'Old Finished/Exports/Old FD.mp4', 1000, 200);
  file(ssd, 'Old Finished/.DS_Store', 10, 1);
  file(ssd, 'Fresh Edit/b.mov', 1000, 2); // Keep
  file(ssd, 'NCHS Football/Week 9/Footage/clip.mov', 3000, 150); // Ready, inside a container
  file(ssd, 'NCHS Football/Week 9/Exports/Week 9 FD.mp4', 500, 150);
  file(ssd, 'Resolve Project Library/Project.db', 100, 1); // shared
  // Library HDD (a top-level project only: no "NCHS Football" folder unless asked)
  file(library, 'Oldest Shoot/Footage/a.mov', 4000, 500);
  file(library, 'Newest Shoot/Footage/a.mov', 2000, 40);
  if (withContainerOnLibrary) fs.mkdirSync(path.join(library, 'NCHS Football'), { recursive: true });
  fs.mkdirSync(archive, { recursive: true });

  const config = withDefaults({
    drives: { working: ssd, library, archive },
    folders: { ignore: [], shared: ['Resolve Project Library'], containers: ['NCHS Football'], keepPinned: [] },
    vericopy: { url },
  });
  const db = openDatabase({ file: path.join(base, `moves-${worldCount}.db`) });
  await scanAndSave({ config, db, drive: 'working' });
  await scanAndSave({ config, db, drive: 'library' });
  const quiet = { error() {} };
  const mover = createMover({
    db,
    getConfig: () => config,
    getSpaces: fakeSpaces(libraryUsedPercent, libraryTotal),
    getSpace: async () => ({ freeBytes }),
    log: quiet,
  });
  const id = (relPath, drive = 'working') => listProjects(db, { drive }).find((p) => p.relPath === relPath).id;
  // Polls until the move is no longer running (the fake moves one step per poll).
  const runToEnd = async (moveId) => {
    for (let i = 0; i < 10; i += 1) {
      await mover.tick();
      if (!getMove(db, moveId).unfinished) break;
    }
    return getMove(db, moveId);
  };
  return { root, ssd, library, archive, config, db, mover, id, runToEnd };
}

function check(preview, checkId) {
  return preview.checks.find((c) => c.id === checkId);
}

before(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  base = fs.mkdtempSync(path.join(DATA_DIR, '.test-moves-'));
  fake = await startFakeVericopy().listen();
});

after(async () => {
  await fake.stop();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('the happy path', () => {
  it('queued → copying → verifying → verified → spot check passes → "Copied to HDD, original still on SSD"', async () => {
    const w = await world();
    const projectId = w.id('Old Finished');
    const ssdBefore = snapshot(w.ssd);

    const preview = await w.mover.preview(projectId);
    assert.equal(preview.canStart, true, JSON.stringify(preview.checks, null, 2));
    assert.equal(preview.source, path.join(w.ssd, 'Old Finished'));
    assert.equal(preview.destinationParent, w.library, 'a top-level project goes into the top of the Library');
    assert.equal(preview.destinationPath, path.join(w.library, 'Old Finished'));
    assert.equal(preview.fileCount, 3, '.DS_Store is not counted');
    assert.equal(preview.sizeBytes, 9000);
    assert.equal(preview.freeAfterBytes, 1e12 - 9000);
    assert.equal(check(preview, 'apps').state, 'info');

    const started = await w.mover.start(projectId);
    assert.equal(started.started, true, started.message);
    // The job id is saved straight away, before any polling.
    const saved = getMove(w.db, started.move.id);
    assert.match(saved.jobId, /^[0-9A-F-]{36}$/);
    assert.equal(saved.state, 'queued');
    assert.equal(saved.sourcePath, path.join(w.ssd, 'Old Finished'));
    assert.equal(saved.destinationParent, w.library);
    assert.equal(saved.vericopyUrl, fake.url);
    assert.equal(saved.sizeBytes, 9000);
    assert.equal(saved.fileCount, 3);
    assert.deepEqual([saved.fromDrive, saved.toDrive], ['working', 'library']);

    await w.mover.tick();
    const copying = getMove(w.db, saved.id);
    assert.equal(copying.state, 'copying');
    assert.equal(moveView(copying).progress.copyPercent, 100);
    assert.equal(moveView(copying).progress.secondsRemaining, 120);
    assert.equal(moveView(copying).label, 'Copying');

    await w.mover.tick();
    const verifying = getMove(w.db, saved.id);
    assert.equal(verifying.state, 'verifying');
    // VeriCopy counts the .DS_Store too (4 files): the fake says 2 verified so far.
    assert.equal(moveView(verifying).progress.verifyPercent, 50);

    await w.mover.tick();
    const done = getMove(w.db, saved.id);
    assert.equal(done.state, 'copied');
    assert.equal(done.vericopyStatus, 'verified');
    assert.equal(done.spotCheckOk, true);
    assert.deepEqual([done.spotCheck.source.files, done.spotCheck.destination.files], [3, 3]);
    assert.deepEqual([done.spotCheck.source.bytes, done.spotCheck.destination.bytes], [9000, 9000]);
    const view = moveView(done);
    assert.equal(view.label, 'Copied to HDD, original still on SSD');
    assert.equal(view.copied, true);
    assert.equal(view.active, false);
    assert.equal(view.progress.secondsRemaining, null);
    assert.deepEqual(
      done.history.map((h) => h.state),
      ['starting', 'queued', 'copying', 'verifying', 'checking', 'copied'],
    );

    // The original is untouched, and a second move of it is refused.
    assert.deepEqual(snapshot(w.ssd), ssdBefore);
    const again = await w.mover.preview(projectId);
    assert.equal(again.canStart, false);
    assert.match(check(again, 'previous').message, /Already copied to the Library HDD/);
    assert.match(check(again, 'destination').message, /already exists/);
    w.db.close();
  });

  it('Move 2: a suggested Library project goes to the Archive', async () => {
    // 95% of 10,000 bytes: 2,500 bytes over the 70% target, so only the oldest (4,000) is suggested.
    const w = await world({ libraryUsedPercent: 95, libraryTotal: 10000 });
    const projectId = w.id('Oldest Shoot', 'library');
    const preview = await w.mover.preview(projectId);
    assert.equal(preview.canStart, true, JSON.stringify(preview.checks, null, 2));
    assert.equal(preview.buttonLabel, 'Move to Archive');
    assert.equal(preview.destinationParent, w.archive);
    const started = await w.mover.start(projectId);
    const done = await w.runToEnd(started.move.id);
    assert.equal(done.state, 'copied');
    assert.equal(moveView(done).label, 'Copied to Archive, original still on the Library HDD');
    assert.ok(fs.existsSync(path.join(w.library, 'Oldest Shoot', 'Footage', 'a.mov')), 'the original stays');

    // Not suggested (the newest one, or a Library under its limit): refused.
    const newest = await w.mover.preview(w.id('Newest Shoot', 'library'));
    assert.match(check(newest, 'eligible').message, /Only the projects the Done HDD page suggests/);
    w.db.close();
  });

  it('a container shoot goes into the same container folder on the Library', async () => {
    const w = await world({ withContainerOnLibrary: true });
    const preview = await w.mover.preview(w.id('NCHS Football/Week 9'));
    assert.equal(preview.canStart, true, JSON.stringify(preview.checks, null, 2));
    assert.equal(preview.destinationParent, path.join(w.library, 'NCHS Football'));
    assert.equal(preview.destinationPath, path.join(w.library, 'NCHS Football', 'Week 9'));
    const done = await w.runToEnd((await w.mover.start(w.id('NCHS Football/Week 9'))).move.id);
    assert.equal(done.state, 'copied');
    w.db.close();
  });
});

describe('anything else is not a success', () => {
  it('verified, but the spot check finds a missing file: not marked as copied, with a clear warning', async () => {
    const w = await world();
    fake.nextJob = { tamper: (copy) => fs.rmSync(path.join(copy, 'Exports', 'Old FD.mp4')) };
    const started = await w.mover.start(w.id('Old Finished'));
    const done = await w.runToEnd(started.move.id);
    assert.equal(done.vericopyStatus, 'verified');
    assert.equal(done.state, 'check_failed');
    assert.equal(done.spotCheckOk, false);
    const view = moveView(done);
    assert.equal(view.copied, false);
    assert.equal(view.tone, 'problem');
    assert.match(view.label, /spot check failed: not marked as copied/);
    assert.match(view.message, /NOT marked as copied/);
    assert.match(view.message, /The original has 3 files, the copy 2 files/);
    assert.equal(view.canRecheck, true);

    // Put the file back (as if a drive had been unplugged): Check the copy again passes.
    fs.copyFileSync(path.join(w.ssd, 'Old Finished', 'Exports', 'Old FD.mp4'), path.join(w.library, 'Old Finished', 'Exports', 'Old FD.mp4'));
    const rechecked = await w.mover.recheck(done.id);
    assert.equal(rechecked.ok, true);
    assert.equal(getMove(w.db, done.id).state, 'copied');
    w.db.close();
  });

  it('.DS_Store and ._ files on the copy alone don\'t fail the spot check', async () => {
    const w = await world();
    fake.nextJob = {
      tamper: (copy) => {
        fs.writeFileSync(path.join(copy, '.DS_Store'), 'Finder looked here');
        fs.writeFileSync(path.join(copy, 'Exports', '._Old FD.mp4'), 'AppleDouble');
      },
    };
    const done = await w.runToEnd((await w.mover.start(w.id('Old Finished'))).move.id);
    assert.equal(done.state, 'copied');
    assert.equal(done.spotCheck.destination.macClutterFiles, 2);
    w.db.close();
  });

  it('the database itself refuses "copied" without verified + a passed spot check', async () => {
    const w = await world();
    const move = createMove(w.db, {
      projectId: w.id('Old Finished'),
      projectPath: 'Old Finished',
      projectName: 'Old Finished',
      fromDrive: 'working',
      toDrive: 'library',
      sourcePath: '/a',
      destinationParent: '/b',
      destinationPath: '/b/Old Finished',
      vericopyUrl: fake.url,
      sizeBytes: 1,
      fileCount: 1,
    });
    assert.throws(() => updateMove(w.db, move.id, { state: 'copied' }), /CHECK constraint failed/);
    assert.throws(() => updateMove(w.db, move.id, { state: 'copied', vericopyStatus: 'verified', spotCheckOk: false }), /CHECK constraint failed/);
    w.db.close();
  });

  it('failed: shows failedFiles and warns that the partial folder must be removed in Finder', async () => {
    const w = await world();
    fake.nextJob = {
      steps: ['queued', 'copying', 'failed'],
      failedFiles: [{ path: 'Old Finished/Footage/Card A/a.mov', message: 'Checksum mismatch on read-back' }],
    };
    const done = await w.runToEnd((await w.mover.start(w.id('Old Finished'))).move.id);
    assert.equal(done.state, 'failed');
    const view = moveView(done);
    assert.equal(view.copied, false);
    assert.deepEqual(view.failedFiles, [{ path: 'Old Finished/Footage/Card A/a.mov', message: 'Checksum mismatch on read-back' }]);
    assert.match(view.message, /1 file that failed/);
    assert.match(view.message, /Files already copied stay in .*Old Finished\. Before trying again, delete that partial folder in Finder/);
    w.db.close();
  });

  it('failed before starting: shows fatalError', async () => {
    const w = await world();
    fake.nextJob = { steps: ['queued', 'failed'], fatalError: 'Not enough free space on the destination' };
    const done = await w.runToEnd((await w.mover.start(w.id('Old Finished'))).move.id);
    assert.equal(done.state, 'failed');
    assert.match(moveView(done).message, /Not enough free space on the destination/);
    assert.equal(moveView(done).fatalError, 'Not enough free space on the destination');
    w.db.close();
  });

  it('cancelled: the Cancel button calls VeriCopy\'s cancel route', async () => {
    const w = await world();
    const started = await w.mover.start(w.id('Old Finished'));
    await w.mover.tick(); // copying
    const before = fake.requests.length;
    const outcome = await w.mover.cancel(started.move.id);
    assert.equal(outcome.ok, true);
    assert.deepEqual(
      fake.requests.slice(before).map((r) => `${r.method} ${r.path}`),
      [`POST /api/jobs/${started.move.jobId}/cancel`],
    );
    const done = getMove(w.db, started.move.id);
    assert.equal(done.state, 'cancelled');
    assert.equal(moveView(done).copied, false);
    assert.match(moveView(done).message, /delete that partial folder in Finder/);
    assert.equal((await w.mover.cancel(started.move.id)).ok, false, 'a finished move cannot be cancelled again');
    w.db.close();
  });

  it('job_not_found (VeriCopy quit or restarted): "Lost: copy state unknown", never verified', async () => {
    const w = await world();
    const started = await w.mover.start(w.id('Old Finished'));
    await w.mover.tick();
    fake.forgetJobs();
    await w.mover.tick();
    const done = getMove(w.db, started.move.id);
    assert.equal(done.state, 'lost');
    const view = moveView(done);
    assert.equal(view.label, 'Lost: copy state unknown');
    assert.equal(view.copied, false);
    assert.match(view.message, /never verified\. Check .*Old Finished in Finder/);
    w.db.close();
  });

  it('VeriCopy not running: the pre-check says to open it, Start is refused, nothing is saved', async () => {
    const port = await closedPort();
    const w = await world({ url: `http://127.0.0.1:${port}` });
    const preview = await w.mover.preview(w.id('Old Finished'));
    assert.equal(preview.canStart, false);
    assert.equal(preview.vericopy.running, false);
    assert.equal(check(preview, 'vericopy').state, 'fail');
    assert.match(check(preview, 'vericopy').message, /Open VeriCopy/);
    const outcome = await w.mover.start(w.id('Old Finished'));
    assert.equal(outcome.started, false);
    assert.equal(outcome.reason, 'checks');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM archive_log').get().n, 0);
    w.db.close();
  });

  it('VeriCopy stops answering mid-copy: the move keeps its state and the page is told', async () => {
    const w = await world();
    const started = await w.mover.start(w.id('Old Finished'));
    await w.mover.tick();
    const port = await closedPort();
    w.config.vericopy.url = `http://127.0.0.1:${port}`;
    await w.mover.tick();
    assert.equal(getMove(w.db, started.move.id).state, 'copying');
    assert.equal(w.mover.status().vericopy.reachable, false);
    assert.match(w.mover.status().vericopy.message, /isn't answering/);
    w.config.vericopy.url = fake.url;
    const done = await w.runToEnd(started.move.id);
    assert.equal(done.state, 'copied');
    w.db.close();
  });

  it('409 destination_exists from VeriCopy: a plain message, nothing started', async () => {
    const w = await world();
    fake.nextStartError = { status: 409, error: 'destination_exists', message: '…already exists. This API never overwrites…' };
    const outcome = await w.mover.start(w.id('Old Finished'));
    assert.equal(outcome.started, false);
    assert.equal(outcome.reason, 'refused');
    assert.equal(outcome.code, 'destination_exists');
    assert.match(outcome.message, /already exists\. It may be a leftover partial copy/);
    assert.equal(outcome.move.state, 'refused');
    assert.equal(moveView(outcome.move).label, 'Not started: VeriCopy refused');
    w.db.close();
  });

  it('400 path_not_found from VeriCopy: a plain message', async () => {
    const w = await world();
    fake.nextStartError = { status: 400, error: 'path_not_found', message: 'Path does not exist (drive unplugged?)' };
    const outcome = await w.mover.start(w.id('Old Finished'));
    assert.equal(outcome.code, 'path_not_found');
    assert.match(outcome.message, /is the drive plugged in\? Nothing was copied/);
    w.db.close();
  });

  it('403 path_not_allowed: explains VeriCopy\'s allowedRoots', async () => {
    const w = await world();
    fake.nextStartError = { status: 403, error: 'path_not_allowed', message: 'Outside every allowed root' };
    const outcome = await w.mover.start(w.id('Old Finished'));
    assert.match(outcome.message, /allowedRoots/);
    w.db.close();
  });
});

describe('the pre-checks', () => {
  it('destination parent missing: says which folder to create in Finder, creates nothing, asks VeriCopy nothing', async () => {
    const w = await world(); // no "NCHS Football" folder on the Library
    const libraryBefore = snapshot(w.library);
    const before = fake.requests.length;
    const preview = await w.mover.preview(w.id('NCHS Football/Week 9'));
    assert.equal(preview.canStart, false);
    const parent = check(preview, 'parent');
    assert.equal(parent.state, 'fail');
    assert.match(parent.message, /create a folder named exactly “NCHS Football” inside “.*library”/);
    assert.match(parent.message, /never creates folders/);
    const outcome = await w.mover.start(w.id('NCHS Football/Week 9'));
    assert.equal(outcome.reason, 'checks');
    assert.equal(fs.existsSync(path.join(w.library, 'NCHS Football')), false);
    assert.deepEqual(snapshot(w.library), libraryBefore);
    assert.ok(
      fake.requests.slice(before).every((r) => r.path === '/api/health'),
      'only health checks: no POST /api/jobs',
    );
    w.db.close();
  });

  it('the project already at the destination (a leftover partial copy?): stops', async () => {
    const w = await world();
    file(w.library, 'Old Finished/Footage/partial.mov', 10, 1);
    const preview = await w.mover.preview(w.id('Old Finished'));
    assert.equal(check(preview, 'destination').state, 'fail');
    assert.match(check(preview, 'destination').message, /leftover partial copy/);
    assert.equal(preview.canStart, false);
    w.db.close();
  });

  it('free space must be the size + 10%', async () => {
    const w = await world({ freeBytes: 9500 }); // 9,000 bytes needs 9,900
    const preview = await w.mover.preview(w.id('Old Finished'));
    assert.equal(check(preview, 'space').state, 'fail');
    assert.match(check(preview, 'space').message, /size \+ 10%/);
    w.db.close();
  });

  it('a project changed in the last 10 minutes is refused (housekeeping files don\'t count)', async () => {
    const w = await world();
    file(w.ssd, 'Old Finished/.DS_Store', 10, 0);
    assert.equal(check(await w.mover.preview(w.id('Old Finished')), 'quiet').state, 'pass');
    file(w.ssd, 'Old Finished/Exports/Old FD v2.mp4', 10, 0);
    const preview = await w.mover.preview(w.id('Old Finished'));
    assert.equal(check(preview, 'quiet').state, 'fail');
    assert.match(check(preview, 'quiet').message, /Old FD v2\.mp4/);
    w.db.close();
  });

  it('warns when Premiere has the project open (its .prlock file)', async () => {
    const w = await world();
    file(w.ssd, 'Old Finished/Edit.prlock', 10, 200);
    const preview = await w.mover.preview(w.id('Old Finished'));
    assert.equal(check(preview, 'apps').state, 'warn');
    assert.equal(preview.canStart, true, 'a warning, not a stop');
    w.db.close();
  });

  it('only Ready projects move from the SSD; shared folders never move', async () => {
    const w = await world();
    assert.match(check(await w.mover.preview(w.id('Fresh Edit')), 'eligible').message, /Only projects tagged “Ready to move to HDD”/);
    assert.match(check(await w.mover.preview(w.id('Resolve Project Library')), 'eligible').message, /never moved/);
    w.db.close();
  });

  it('an unplugged destination drive', async () => {
    const w = await world();
    fs.rmSync(w.library, { recursive: true });
    const preview = await w.mover.preview(w.id('Old Finished'));
    assert.match(check(preview, 'drives').message, /Library HDD isn't connected/);
    w.db.close();
  });

  it('a stale empty folder in /Volumes is not a connected drive', async () => {
    const volumes = path.join(base, 'Volumes');
    fs.mkdirSync(path.join(volumes, 'BRIGSMEDIA LIBRARY'), { recursive: true });
    // Same disk as "/Volumes" itself: a leftover folder, not a mounted drive.
    assert.match(await driveProblem(path.join(volumes, 'BRIGSMEDIA LIBRARY'), 'Library HDD', { volumesDir: volumes }), /leftover empty folder/);
    assert.match(await driveProblem(path.join(volumes, 'Gone'), 'Library HDD', { volumesDir: volumes }), /isn't connected/);
    // Outside /Volumes (e.g. ~/VeriCopyAPITest): it only has to exist.
    assert.equal(await driveProblem(base, 'Library HDD', { volumesDir: volumes }), null);
  });
});

describe('after a restart', () => {
  it('picks up unfinished jobs, and a move that never got its job id is "lost"', async () => {
    const w = await world();
    const started = await w.mover.start(w.id('Old Finished'));
    // A new mover over the same database = the dashboard was restarted.
    const restarted = createMover({ db: w.db, getConfig: () => w.config, getSpaces: fakeSpaces(92), getSpace: async () => ({ freeBytes: TB }) });
    for (let i = 0; i < 5; i += 1) await restarted.tick();
    assert.equal(getMove(w.db, started.move.id).state, 'copied');

    const orphan = createMove(w.db, {
      projectId: w.id('Fresh Edit'),
      projectPath: 'Fresh Edit',
      projectName: 'Fresh Edit',
      fromDrive: 'working',
      toDrive: 'library',
      sourcePath: path.join(w.ssd, 'Fresh Edit'),
      destinationParent: w.library,
      destinationPath: path.join(w.library, 'Fresh Edit'),
      vericopyUrl: fake.url,
      sizeBytes: 1000,
      fileCount: 1,
    });
    await restarted.tick();
    assert.equal(getMove(w.db, orphan.id).state, 'lost');
    assert.match(getMove(w.db, orphan.id).error, /never learned the job id/);
    w.db.close();
  });
});

describe('the routes', () => {
  it('preview, Start (only with confirm), Recent jobs, cancel', async () => {
    const w = await world();
    const quiet = { error() {} };
    const syncer = createNotionSyncer({ db: w.db, getConfig: () => w.config, makeClient: () => fakeNotion().client, log: quiet });
    const runner = createScanRunner({ db: w.db, getConfig: () => w.config, notion: syncer, log: quiet });
    const app = createApp({ db: w.db, runner, notion: syncer, getConfig: () => w.config, getSpaces: fakeSpaces(92), mover: w.mover });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, { method = 'GET', body } = {}) => {
      const response = await fetch(url + route, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      const id = w.id('Old Finished');
      const health = await call('/api/vericopy');
      assert.deepEqual([health.body.running, health.body.version], [true, '1.0']);

      const preview = await call(`/api/projects/${id}/move`);
      assert.equal(preview.status, 200);
      assert.equal(preview.body.canStart, true);
      assert.equal(preview.body.canEdit, true);

      const unconfirmed = await call(`/api/projects/${id}/move`, { method: 'POST' });
      assert.equal(unconfirmed.status, 400, 'nothing starts without the click');
      assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM archive_log').get().n, 0);

      const started = await call(`/api/projects/${id}/move`, { method: 'POST', body: { confirm: true } });
      assert.equal(started.status, 202);
      assert.equal(started.body.move.state, 'queued');

      const blocked = await call(`/api/projects/${w.id('Fresh Edit')}/move`, { method: 'POST', body: { confirm: true } });
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error, /pre-check failed/);

      await w.mover.tick();
      const list = await call('/api/moves');
      assert.equal(list.body.activeCount, 1);
      assert.equal(list.body.moves[0].label, 'Copying');
      assert.equal((await call(`/api/moves?projectId=${id}`)).body.moves.length, 1);

      const cancelled = await call(`/api/moves/${started.body.move.id}/cancel`, { method: 'POST' });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.move.state, 'cancelled');
      const again = await call(`/api/moves/${started.body.move.id}/cancel`, { method: 'POST' });
      assert.equal(again.status, 409);

      assert.equal((await call('/api/moves/999')).status, 404);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      w.db.close();
    }
  });
});

describe('what was sent to VeriCopy (every test above)', () => {
  it('no request ever carried an Origin header, and only the four allowed routes were used', () => {
    assert.ok(fake.requests.length > 20, 'the tests above talked to the fake');
    for (const request of fake.requests) {
      assert.equal('origin' in request.headers, false, `${request.method} ${request.path} carried an Origin header`);
      assert.match(
        `${request.method} ${request.path}`,
        /^(GET \/api\/health|POST \/api\/jobs|GET \/api\/jobs\/[0-9A-F-]{36}|POST \/api\/jobs\/[0-9A-F-]{36}\/cancel)$/,
      );
    }
    const starts = fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/jobs');
    assert.ok(starts.every((r) => r.headers['content-type'] === 'application/json'));
  });
});
