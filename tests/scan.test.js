'use strict';

// Tests the scanner against a small fake drive. The fake drive is built
// inside data/ (the one folder the app may write to) and deleted afterwards.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, withDefaults, isInside } = require('../src/config');
const { scanDrive, ScanError } = require('../src/scanner/scan');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-15T12:00:00Z');

let root;

// Creates a file of `size` bytes whose modified time is `ageDays` before NOW.
function file(rel, size, ageDays, base = root) {
  const abs = path.join(base, rel);
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

// Deletes a test folder, but only ever inside data/.
function removeTestFolder(dir) {
  if (dir && isInside(dir, DATA_DIR) && dir !== DATA_DIR) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('scanner on a fake drive', () => {
  before(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    root = fs.mkdtempSync(path.join(DATA_DIR, '.test-fake-ssd-'));

    file('Soccer 8-24/Footage/A001.mov', 5000, 60);
    file('Soccer 8-24/Footage/A002.mov', 3000, 58);
    file('Soccer 8-24/Exports/Soccer v1.mp4', 1000, 50);
    file('Soccer 8-24/Soccer.prproj', 200, 49);
    file('Soccer 8-24/.DS_Store', 10, 0); // touched "today" by Finder
    file('Soccer 8-24/Footage/._A001.mov', 4, 0);
    file('Soccer 8-24/.hidden-app-folder/state', 7, 0);

    file('Soccer Finals Temp/Footage/game.mov', 2000, 200);
    file('Soccer Finals Temp/Media Cache Files/game.pek', 100, 199);

    file('NCHS Football/Week 1/Footage/clip.mov', 4000, 130);
    file('NCHS Football/Week 1/Proxy/clip_Proxy.mov', 400, 129);
    file('NCHS Football/Week 2/Renders/highlights.mov', 1000, 3);
    file('NCHS Football/season-logo.png', 50, 100);

    file('NCHS Football Working Proxies/clip.mov', 800, 90);
    file('Resolve Project Library/Projects/QB Era/Project.db', 300, 1);
    file('Future Cam/clip.mov', 600, -2000); // camera clock set ~5 years ahead
    file('Future Cam/old.mov', 600, 300);
    file('$RECYCLE.BIN/junk.mov', 10, 5);
    file('.Spotlight-V100/store', 10, 0);
    file('SUNBURNED.mp4', 700, 300);
    file("Veteran's Day Video/Footage/a.mov", 100, 200);
    fs.mkdirSync(path.join(root, 'untitled folder'));
    fs.symlinkSync(path.join(root, 'Soccer 8-24'), path.join(root, 'Shortcut'));
    fs.symlinkSync(path.join(root, 'Soccer Finals Temp'), path.join(root, 'Soccer 8-24', 'link'));
  });

  after(() => removeTestFolder(root));

  function testConfig() {
    return withDefaults({
      ssdPath: root,
      folders: {
        ignore: ['$RECYCLE.BIN', 'Folder That Does Not Exist'],
        shared: ['Resolve Project Library'],
        containers: ['NCHS Football'],
        keepPinned: ['nchs football/week 1'], // matching ignores upper/lower case
      },
    });
  }

  async function runScan(options = {}) {
    return scanDrive(testConfig(), { now: NOW, ...options });
  }

  function byName(list, name) {
    const found = list.find((p) => p.name === name);
    assert.ok(found, `expected to find "${name}"`);
    return found;
  }

  it('a scan changes nothing on the drive', async () => {
    const before = snapshot(root);
    await runScan();
    assert.deepEqual(snapshot(root), before);
  });

  it('sizes add up, split by type', async () => {
    const soccer = byName((await runScan()).projects, 'Soccer 8-24');
    assert.equal(soccer.sizeBytes, 5000 + 3000 + 1000 + 200 + 10 + 4 + 7);
    assert.equal(soccer.fileCount, 7);
    assert.deepEqual(soccer.bytesByType, { raw: 8000, proxy: 0, export: 1000, cache: 0, project: 200, other: 21 });
    assert.equal(soccer.hasExport, true);
  });

  it('last edited ignores .DS_Store and other hidden files', async () => {
    const soccer = byName((await runScan()).projects, 'Soccer 8-24');
    assert.equal(soccer.lastEditedMs, NOW - 49 * DAY);
    assert.equal(soccer.lastEditedFile, 'Soccer.prproj');
    assert.equal(soccer.lastProjectSaveMs, NOW - 49 * DAY);
    assert.equal(soccer.lastProjectSaveFile, 'Soccer.prproj');
  });

  it('shortcuts (symlinks) are never followed', async () => {
    const scan = await runScan();
    const soccer = byName(scan.projects, 'Soccer 8-24');
    assert.equal(soccer.skippedLinks, 1);
    assert.ok(scan.skipped.some((s) => s.relPath === 'Shortcut'));
    assert.ok(!scan.projects.some((p) => p.name === 'Shortcut'));
  });

  it('"Finals" in a project name does not count as an export', async () => {
    const finals = byName((await runScan()).projects, 'Soccer Finals Temp');
    assert.equal(finals.hasExport, false);
    assert.equal(finals.bytesByType.raw, 2000);
    assert.equal(finals.bytesByType.cache, 100);
  });

  it('container subfolders become separate projects', async () => {
    const scan = await runScan();
    const week1 = byName(scan.projects, 'NCHS Football / Week 1');
    const week2 = byName(scan.projects, 'NCHS Football / Week 2');
    assert.equal(week1.relPath, 'NCHS Football/Week 1');
    assert.equal(week1.bytesByType.proxy, 400);
    assert.equal(week1.hasExport, false);
    assert.equal(week2.hasExport, true);
    assert.ok(!scan.projects.some((p) => p.name === 'NCHS Football'));
    assert.ok(scan.looseFiles.some((f) => f.relPath === 'NCHS Football/season-logo.png'));
  });

  it('pinned projects are marked (case-insensitive match)', async () => {
    const scan = await runScan();
    assert.equal(byName(scan.projects, 'NCHS Football / Week 1').pinnedKeep, true);
    assert.equal(byName(scan.projects, 'NCHS Football / Week 2').pinnedKeep, false);
  });

  it('a project named "...Proxies" counts as proxies', async () => {
    const proxies = byName((await runScan()).projects, 'NCHS Football Working Proxies');
    assert.equal(proxies.bytesByType.proxy, 800);
  });

  it('shared, ignored, hidden and loose items are sorted out', async () => {
    const scan = await runScan();
    assert.deepEqual(
      scan.shared.map((s) => s.name),
      ['Resolve Project Library'],
    );
    assert.ok(!scan.projects.some((p) => p.name === 'Resolve Project Library'));
    assert.ok(scan.skipped.some((s) => s.relPath === '$RECYCLE.BIN'));
    assert.equal(scan.hiddenCount, 1); // .Spotlight-V100
    assert.deepEqual(scan.looseFiles.map((f) => f.relPath).sort(), ['NCHS Football/season-logo.png', 'SUNBURNED.mp4']);
  });

  it('future-dated files are ignored for dates and reported', async () => {
    const cam = byName((await runScan()).projects, 'Future Cam');
    assert.equal(cam.futureDatedFiles, 1);
    assert.equal(cam.lastEditedMs, NOW - 300 * DAY);
    assert.ok(cam.warnings.some((w) => w.includes('dated in the future')));
  });

  it('an empty folder has no last-edited date', async () => {
    const empty = byName((await runScan()).projects, 'untitled folder');
    assert.equal(empty.sizeBytes, 0);
    assert.equal(empty.lastEditedMs, null);
  });

  it('config names that match nothing produce a warning', async () => {
    const scan = await runScan();
    assert.ok(scan.warnings.some((w) => w.includes('Folder That Does Not Exist')));
  });

  it('a missing drive gives a friendly error', async () => {
    const config = withDefaults({ ssdPath: path.join(root, 'not-plugged-in') });
    await assert.rejects(scanDrive(config, { now: NOW }), /Is the SSD plugged in\?/);
  });

  it('names the file that made "Export: yes", so you can find it in Finder', async () => {
    const soccer = byName((await runScan()).projects, 'Soccer 8-24');
    assert.equal(soccer.exportExampleFile, 'Exports/Soccer v1.mp4');
  });

  it('pinning a container pins every project inside it', async () => {
    const config = testConfig();
    config.folders.keepPinned = ['NCHS Football'];
    const scan = await scanDrive(config, { now: NOW });
    assert.equal(byName(scan.projects, 'NCHS Football / Week 1').pinnedKeep, true);
    assert.equal(byName(scan.projects, 'NCHS Football / Week 2').pinnedKeep, true);
    assert.equal(byName(scan.projects, 'Soccer 8-24').pinnedKeep, false);
    assert.equal(scan.warnings.filter((w) => w.includes('keepPinned')).length, 0);
  });

  it('--root on a folder inside the SSD keeps full names, pins, and no false warnings', async () => {
    const scan = await runScan({ root: path.join(root, 'NCHS Football') });
    assert.equal(scan.scope, 'inside-ssd');
    const week1 = byName(scan.projects, 'NCHS Football / Week 1');
    assert.equal(week1.relPath, 'NCHS Football/Week 1');
    assert.equal(week1.pinnedKeep, true);
    assert.deepEqual(scan.warnings, []);
    assert.ok(scan.looseFiles.some((f) => f.relPath === 'NCHS Football/season-logo.png'));
  });

  it('--root inside a shared folder lists everything as shared, never as projects', async () => {
    const scan = await runScan({ root: path.join(root, 'Resolve Project Library') });
    assert.deepEqual(scan.projects, []);
    assert.deepEqual(
      scan.shared.map((s) => s.name),
      ['Resolve Project Library / Projects'],
    );
  });

  it('--root inside an ignored folder skips everything in it', async () => {
    const scan = await runScan({ root: path.join(root, '$RECYCLE.BIN') });
    assert.deepEqual(scan.projects, []);
    assert.deepEqual(scan.looseFiles, []);
    assert.ok(scan.skipped.some((s) => s.relPath === '$RECYCLE.BIN/junk.mov'));
  });

  it('a curly apostrophe in config (from TextEdit or an iPhone) still matches the folder', async () => {
    const config = testConfig();
    config.folders.keepPinned = ['Veteran’s Day Video'];
    const scan = await scanDrive(config, { now: NOW });
    assert.equal(byName(scan.projects, "Veteran's Day Video").pinnedKeep, true);
    assert.equal(scan.warnings.filter((w) => w.includes('keepPinned')).length, 0);
  });

  it('a whole-SSD scan reports its scope', async () => {
    assert.equal((await runScan()).scope, 'ssd');
  });
});

describe('scanner when the drive disappears mid-scan', () => {
  let base;
  before(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    base = fs.mkdtempSync(path.join(DATA_DIR, '.test-unplug-'));
    for (const project of ['A', 'B']) {
      file(`ssd/${project}/Footage/clip.mov`, 100, 30, base);
      file(`ssd/${project}/Exports/v1.mp4`, 100, 30, base);
    }
  });
  after(() => removeTestFolder(base));

  // "Unplugs" the drive (by renaming it away) right after folder number
  // `unplugAt` has been read, and expects the scan to stop with a clear error.
  async function expectUnplugError(unplugAt) {
    const ssd = path.join(base, 'ssd');
    const unplugged = path.join(base, 'unplugged');
    const config = withDefaults({ ssdPath: ssd, folders: { ignore: [], shared: [], containers: [], keepPinned: [] } });
    let calls = 0;
    const onProgress = () => {
      calls += 1;
      if (calls === unplugAt) fs.renameSync(ssd, unplugged);
    };
    try {
      await assert.rejects(
        scanDrive(config, { now: NOW, onProgress }),
        (error) => error instanceof ScanError && /disconnected during the scan/.test(error.message),
      );
    } finally {
      if (fs.existsSync(unplugged)) fs.renameSync(unplugged, ssd);
    }
  }

  it('stops with a clear error instead of reporting 0 GB projects', async () => {
    await expectUnplugError(1);
  });

  it('also notices when the drive goes away after the very last folder', async () => {
    // A, A/Footage, A/Exports, B, B/Footage, B/Exports = 6 folders
    await expectUnplugError(6);
  });
});
