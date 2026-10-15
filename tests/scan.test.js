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
    file('Soccer 8-24/Exports/Soccer FD.mp4', 1000, 50);
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
    // One FD for Game 1, but Game 2 was shot later and isn't edited yet
    file('Hoops/Game 1/Exports/Game 1 Highlights FD.mp4', 300, 35);
    file('Hoops/Game 2/Footage/clip.mov', 900, 20);
    // A photo shoot: finished when a photo export says Final
    file('Senior Portraits/Raw/IMG_0001.CR3', 500, 60);
    file('Senior Portraits/Exports/Senior Portraits FINAL 001.jpg', 50, 40);
    // A video project with a final thumbnail but only draft videos: NOT finished
    file('Promo Spot/Exports/Promo v3.mp4', 400, 30);
    file('Promo Spot/Exports/Thumbnail FINAL.jpg', 10, 30);
    // A video project with footage but no video export yet, and a final thumbnail: NOT finished
    file('Rowdies Promo/Footage/C0001.MP4', 700, 60);
    file('Rowdies Promo/Exports/Thumbnail FINAL.jpg', 10, 40);
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
      drives: { working: root, library: '', archive: '' },
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
    assert.equal(soccer.sizeBytes, 5000 + 3000 + 1000 + 1000 + 200 + 10 + 4 + 7);
    assert.equal(soccer.fileCount, 8);
    assert.deepEqual(soccer.bytesByType, { raw: 8000, proxy: 0, export: 2000, cache: 0, project: 200, other: 21 });
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
    // "Renders/highlights.mov" is an export, but not named Final/FD: a draft
    assert.equal(week2.hasFinalExport, false);
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
    const config = withDefaults({ drives: { working: path.join(root, 'not-plugged-in'), library: '', archive: '' } });
    await assert.rejects(scanDrive(config, { now: NOW }), /Is the drive plugged in\?/);
  });

  it('names the file that made "Export: yes", so you can find it in Finder', async () => {
    const soccer = byName((await runScan()).projects, 'Soccer 8-24');
    assert.equal(soccer.exportExampleFile, 'Exports/Soccer FD.mp4');
  });

  it('a video export named "FD" or "Final" marks the project finished, and says which file', async () => {
    const soccer = byName((await runScan()).projects, 'Soccer 8-24');
    assert.equal(soccer.hasFinalExport, true);
    assert.equal(soccer.finalExportFile, 'Exports/Soccer FD.mp4');
    const finals = byName((await runScan()).projects, 'Soccer Finals Temp');
    assert.equal(finals.hasFinalExport, false);
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
    assert.equal(scan.scope, 'partial');
    assert.equal(scan.drive, 'working');
    assert.equal(scan.wholeDrive, false);
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

  it('footage newer than the final export is flagged (another shoot still to edit)', async () => {
    const hoops = byName((await runScan()).projects, 'Hoops');
    assert.equal(hoops.hasFinalExport, true);
    assert.equal(hoops.finalExportFile, 'Game 1/Exports/Game 1 Highlights FD.mp4');
    assert.equal(hoops.newerFootageFile, 'Game 2/Footage/clip.mov');
    const soccer = byName((await runScan()).projects, 'Soccer 8-24');
    assert.equal(soccer.newerFootageFile, null); // its footage is older than its FD
  });

  it('a photo-only project is finished by a final photo export; a video project is not', async () => {
    const scan = await runScan();
    const portraits = byName(scan.projects, 'Senior Portraits');
    assert.equal(portraits.hasFinalExport, true);
    assert.equal(portraits.finalExportFile, 'Exports/Senior Portraits FINAL 001.jpg');
    const promo = byName(scan.projects, 'Promo Spot');
    assert.equal(promo.hasExport, true);
    assert.equal(promo.hasFinalExport, false); // a final thumbnail doesn't finish a video project
    const rowdies = byName(scan.projects, 'Rowdies Promo');
    assert.equal(rowdies.hasFinalExport, false); // video footage makes it a video project
  });

  it('a whole-SSD scan reports its scope', async () => {
    const scan = await runScan();
    assert.equal(scan.scope, 'working');
    assert.equal(scan.drive, 'working');
    assert.equal(scan.driveLabel, 'Working SSD');
    assert.equal(scan.wholeDrive, true);
  });

  it('a scan of the Library drive knows it is the Library, with no false "name not found" warnings', async () => {
    const library = fs.mkdtempSync(path.join(DATA_DIR, '.test-fake-library-'));
    try {
      file('Old Shoot/Exports/Old Shoot FD.mp4', 100, 400, library);
      const config = testConfig();
      config.drives.library = library;
      const scan = await scanDrive(config, { root: library, now: NOW });
      assert.equal(scan.drive, 'library');
      assert.equal(scan.wholeDrive, true);
      assert.equal(scan.scope, 'partial');
      assert.deepEqual(scan.warnings, []);
      assert.equal(byName(scan.projects, 'Old Shoot').hasFinalExport, true);
    } finally {
      removeTestFolder(library);
    }
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
    const config = withDefaults({
      drives: { working: ssd, library: '', archive: '' },
      folders: { ignore: [], shared: [], containers: [], keepPinned: [] },
    });
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

describe('folder tree and progress', () => {
  let drive;

  before(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    drive = fs.mkdtempSync(path.join(DATA_DIR, '.test-tree-ssd-'));
    file('Deep/Footage/Card A/Clips/Day 1/a.mov', 400, 10, drive);
    file('Deep/Footage/Card A/b.mov', 100, 10, drive);
    file('Deep/Footage/Card B/c.mov', 300, 10, drive);
    file('Deep/Exports/final.mp4', 50, 10, drive);
    file('Deep/notes.txt', 5, 10, drive);
    file('Other/x.mov', 10, 10, drive);
  });

  after(() => removeTestFolder(drive));

  function treeConfig() {
    return withDefaults({ drives: { working: drive, library: '', archive: '' } });
  }

  it("records each project's biggest subfolders, three levels deep, biggest first", async () => {
    const scan = await scanDrive(treeConfig(), { now: NOW });
    const deep = scan.projects.find((p) => p.name === 'Deep');
    assert.deepEqual(deep.subfolders, [
      { path: 'Footage', sizeBytes: 800, fileCount: 3 },
      { path: 'Footage/Card A', sizeBytes: 500, fileCount: 2 },
      { path: 'Footage/Card A/Clips', sizeBytes: 400, fileCount: 1 }, // "Day 1" is a 4th level: left out
      { path: 'Footage/Card B', sizeBytes: 300, fileCount: 1 },
      { path: 'Exports', sizeBytes: 50, fileCount: 1 },
    ]);
  });

  it('reports how many top-level folders are done, for a progress bar', async () => {
    const updates = [];
    await scanDrive(treeConfig(), { now: NOW, onProgress: (update) => updates.push(update) });
    assert.ok(updates.length > 0);
    assert.ok(updates.every((u) => u.foldersTotal === 2));
    assert.deepEqual(
      { done: updates.at(-1).foldersDone, files: updates.at(-1).filesScanned },
      { done: 2, files: 6 },
    );
  });
});
