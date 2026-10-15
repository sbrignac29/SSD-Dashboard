'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTable, renderSavedReport, shortenText, shortenPath, formatGB } = require('../src/cli/format');

test('formatGB uses decimal gigabytes, like Finder', () => {
  assert.equal(formatGB(87_512_345_678), '87.51');
  assert.equal(formatGB(0), '0.00');
});

test('shortenText cuts from the end with an ellipsis', () => {
  assert.equal(shortenText('Covenant Classical Update Content', 12), 'Covenant Cl…');
  assert.equal(shortenText('Short', 12), 'Short');
});

test('shortenPath keeps the last part, so container subprojects stay distinguishable', () => {
  // 26 wide: "Session 2" (9) + " / " (3) leaves 14 for the container name
  assert.equal(shortenPath('Next Elite Soccer Training / Session 2', 26), 'Next Elite So… / Session 2');
  assert.equal(shortenPath('Next Elite Soccer Training / 2026-08-24 Drills', 26), 'Next … / 2026-08-24 Drills');
  assert.equal(shortenPath('NCHS Football/Season Intro.mov', 24, '/'), 'NCHS F…/Season Intro.mov');
  assert.equal(shortenPath('Covenant Classical Update Content', 12), 'Covenant Cl…');
  // When even the subfolder name is too long, keep as much of IT as fits
  assert.equal(shortenPath('Next Elite Soccer Training / 2026-06-14 Passing Drills', 26), '… / 2026-06-14 Passing Dr…'); // 1 + 3 + 22 = 26
});

test('renderTable never shortens when width is Infinity (report saved to a file)', () => {
  const longName = 'Next Elite Soccer Training / A Very Long Session Name That Keeps Going';
  const lines = renderTable([{ header: 'Project', align: 'left', flex: true }], [[longName]], { width: Infinity });
  assert.ok(lines[1].includes(longName));
});

test('renderTable lines up right-aligned numbers', () => {
  const lines = renderTable(
    [
      { header: 'Name', align: 'left' },
      { header: 'GB', align: 'right' },
    ],
    [
      ['a', '1.00'],
      ['b', '100.00'],
    ],
  );
  assert.deepEqual(lines, ['  Name      GB', '  a       1.00', '  b     100.00']);
});

test('the saved report shows the last scan, your pins, missing projects, and a later failed scan', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-10-18T12:00:00Z');
  const scanned = now - 3 * day;
  const text = renderSavedReport({
    lastScan: {
      id: 7, root: '/Volumes/BRIGSMEDIA', startedMs: scanned, finishedMs: scanned + 2500,
      projectCount: 1, fileCount: 1234, totalBytes: 7e9, errors: ['Old Finished: Couldn\'t open folder "Cache" (EACCES).'],
    },
    lastAttempt: { id: 8, status: 'failed', startedMs: now - day, errors: ['Can\'t find "/Volumes/BRIGSMEDIA". Is the SSD plugged in?\nRun `ls /Volumes`…'] },
    projects: [
      {
        name: 'Old Finished', sizeBytes: 6e9, lastEditedMs: now - 200 * day, hasExport: true, pinnedInDatabase: true,
        scoring: { score: 86.5, bucket: 'Keep', notes: ['Pinned as Keep (would be Ready at 86.5).'] },
      },
    ],
    shared: [{ name: 'Resolve Project Library', sizeBytes: 1e9, lastEditedMs: now - day }],
    missing: [{ name: 'Gone Soon', sizeBytes: 5e8, lastScannedMs: now - 10 * day, scoring: { bucket: 'Ready' } }],
    dbPath: 'data/dashboard.db',
    now,
    color: false,
    width: Infinity,
  });
  assert.match(text, /saved results \(no rescan\)/);
  assert.match(text, /Last scan .*\(3 days ago\) · 1 project \+ 1 shared folder · 1,234 files · 7\.00 GB/);
  assert.match(text, /A later scan, .* failed: Can't find "\/Volumes\/BRIGSMEDIA"\. Is the SSD plugged in\?\n/);
  assert.match(text, /Your pins \(npm run pin\)[^\n]*\n  • Old Finished/);
  assert.match(text, /Pinned as Keep \(would be Ready at 86\.5\)/);
  assert.match(text, /No longer found on the SSD/);
  assert.match(text, /Gone Soon +0\.50 +\d{4}-\d{2}-\d{2} +Ready/);
  assert.match(text, /Resolve Project Library/);
  assert.match(text, /Old Finished: Couldn't open folder "Cache"/);
});
