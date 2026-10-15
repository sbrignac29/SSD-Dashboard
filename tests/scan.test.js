'use strict';

// Tests the scanner against a small fake drive. The fake drive is built
// inside data/ (the one folder the app may write to) and deleted afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, withDefaults, isInside } = require('../src/config');
const { scanDrive } = require('../src/scanner/scan');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-15T12:00:00Z');

let root;

// Creates a file of `size` bytes whose modified time is `ageDays` before NOW.
function file(rel, size, ageDays) {
  const abs = path.join(root, rel);
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

test.before(() => {
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
  fs.mkdirSync(path.join(root, 'untitled folder'));
  fs.symlinkSync(path.join(root, 'Soccer 8-24'), path.join(root, 'Shortcut'));
  fs.symlinkSync(path.join(root, 'Soccer Finals Temp'), path.join(root, 'Soccer 8-24', 'link'));
});

test.after(() => {
  // Belt and braces: only ever delete inside data/.
  if (root && isInside(root, DATA_DIR) && root !== DATA_DIR) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

async function runScan() {
  return scanDrive(testConfig(), { now: NOW });
}

function byName(list, name) {
  const found = list.find((p) => p.name === name);
  assert.ok(found, `expected to find "${name}"`);
  return found;
}

test('a scan changes nothing on the drive', async () => {
  const before = snapshot(root);
  await runScan();
  assert.deepEqual(snapshot(root), before);
});

test('sizes add up, split by type', async () => {
  const soccer = byName((await runScan()).projects, 'Soccer 8-24');
  assert.equal(soccer.sizeBytes, 5000 + 3000 + 1000 + 200 + 10 + 4 + 7);
  assert.equal(soccer.fileCount, 7);
  assert.deepEqual(soccer.bytesByType, { raw: 8000, proxy: 0, export: 1000, cache: 0, project: 200, other: 21 });
  assert.equal(soccer.hasExport, true);
});

test('last edited ignores .DS_Store and other hidden files', async () => {
  const soccer = byName((await runScan()).projects, 'Soccer 8-24');
  assert.equal(soccer.lastEditedMs, NOW - 49 * DAY);
  assert.equal(soccer.lastEditedFile, 'Soccer.prproj');
  assert.equal(soccer.lastProjectSaveMs, NOW - 49 * DAY);
  assert.equal(soccer.lastProjectSaveFile, 'Soccer.prproj');
});

test('shortcuts (symlinks) are never followed', async () => {
  const scan = await runScan();
  const soccer = byName(scan.projects, 'Soccer 8-24');
  assert.equal(soccer.skippedLinks, 1);
  assert.ok(scan.skipped.some((s) => s.relPath === 'Shortcut'));
  assert.ok(!scan.projects.some((p) => p.name === 'Shortcut'));
});

test('"Finals" in a project name does not count as an export', async () => {
  const finals = byName((await runScan()).projects, 'Soccer Finals Temp');
  assert.equal(finals.hasExport, false);
  assert.equal(finals.bytesByType.raw, 2000);
  assert.equal(finals.bytesByType.cache, 100);
});

test('container subfolders become separate projects', async () => {
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

test('pinned projects are marked (case-insensitive match)', async () => {
  const scan = await runScan();
  assert.equal(byName(scan.projects, 'NCHS Football / Week 1').pinnedKeep, true);
  assert.equal(byName(scan.projects, 'NCHS Football / Week 2').pinnedKeep, false);
});

test('a project named "...Proxies" counts as proxies', async () => {
  const proxies = byName((await runScan()).projects, 'NCHS Football Working Proxies');
  assert.equal(proxies.bytesByType.proxy, 800);
});

test('shared, ignored, hidden and loose items are sorted out', async () => {
  const scan = await runScan();
  assert.deepEqual(scan.shared.map((s) => s.name), ['Resolve Project Library']);
  assert.ok(!scan.projects.some((p) => p.name === 'Resolve Project Library'));
  assert.ok(scan.skipped.some((s) => s.relPath === '$RECYCLE.BIN'));
  assert.equal(scan.hiddenCount, 1); // .Spotlight-V100
  assert.deepEqual(
    scan.looseFiles.map((f) => f.relPath).sort(),
    ['NCHS Football/season-logo.png', 'SUNBURNED.mp4'],
  );
});

test('future-dated files are ignored for dates and reported', async () => {
  const cam = byName((await runScan()).projects, 'Future Cam');
  assert.equal(cam.futureDatedFiles, 1);
  assert.equal(cam.lastEditedMs, NOW - 300 * DAY);
  assert.ok(cam.warnings.some((w) => w.includes('dated in the future')));
});

test('an empty folder has no last-edited date', async () => {
  const empty = byName((await runScan()).projects, 'untitled folder');
  assert.equal(empty.sizeBytes, 0);
  assert.equal(empty.lastEditedMs, null);
});

test('config names that match nothing produce a warning', async () => {
  const scan = await runScan();
  assert.ok(scan.warnings.some((w) => w.includes('Folder That Does Not Exist')));
});

test('a missing drive gives a friendly error', async () => {
  const config = withDefaults({ ssdPath: path.join(root, 'not-plugged-in') });
  await assert.rejects(scanDrive(config, { now: NOW }), /Is the SSD plugged in\?/);
});
