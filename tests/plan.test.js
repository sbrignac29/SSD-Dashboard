'use strict';

// Tests for the move plan: does Move 1 fit on the Library, and does the
// Library need some of its oldest projects moved to the Archive?

const test = require('node:test');
const assert = require('node:assert/strict');
const { planMoves } = require('../src/scoring/plan');

const GB = 1e9;
const TB = 1e12;
const libraryFull = { startAtPercent: 90, targetPercent: 70 };

function space(totalBytes, usedBytes) {
  return { totalBytes, usedBytes, freeBytes: totalBytes - usedBytes, usedPercent: (usedBytes / totalBytes) * 100 };
}

function project(bucket, sizeBytes) {
  return { sizeBytes, scoring: { bucket } };
}

const projects = [project('Ready', 300 * GB), project('Ready', 100 * GB), project('Review', 500 * GB)];

test('adds up the Ready projects and what moving them does to the SSD', () => {
  const plan = planMoves({
    projects,
    spaces: [{ drive: 'working', space: space(2 * TB, 1.6 * TB) }],
    libraryFull,
  });
  assert.equal(plan.readyCount, 2);
  assert.equal(plan.readyBytes, 400 * GB);
  assert.equal(plan.workingPercentNow, 80);
  assert.equal(plan.workingPercentAfter, 60); // (1.6 − 0.4) / 2
  assert.equal(plan.libraryConnected, false);
});

test('fits on the Library and stays under 90%', () => {
  // Library 2 TB with 1 TB used: + 400 GB = 1.4 TB = 70%
  const plan = planMoves({ projects, spaces: [{ drive: 'library', space: space(2 * TB, 1 * TB) }], libraryFull });
  assert.equal(plan.fitsOnLibrary, true);
  assert.equal(plan.libraryPercentAfter, 70);
  assert.equal(plan.libraryStatus, 'ok');
  assert.equal(plan.archiveBytesNeeded, 0);
});

test('fits, but pushes the Library past 90%: says how much to archive to get back to 70%', () => {
  // 1.5 TB used + 0.4 TB = 1.9 TB = 95%; target 70% = 1.4 TB → archive 0.5 TB
  const plan = planMoves({ projects, spaces: [{ drive: 'library', space: space(2 * TB, 1.5 * TB) }], libraryFull });
  assert.equal(plan.fitsOnLibrary, true);
  assert.equal(plan.libraryStatus, 'full-after');
  assert.equal(plan.archiveBytesNeeded, 500 * GB);
});

test("doesn't fit: reports how far short it is", () => {
  // 1.8 TB used → 200 GB free, 400 GB to move → 200 GB short
  const plan = planMoves({ projects, spaces: [{ drive: 'library', space: space(2 * TB, 1.8 * TB) }], libraryFull });
  assert.equal(plan.fitsOnLibrary, false);
  assert.equal(plan.libraryFreeAfterBytes, -200 * GB);
  assert.equal(plan.libraryStatus, 'full-now'); // already 90%
  assert.equal(plan.archiveBytesNeeded, 800 * GB); // 2.2 TB − 1.4 TB
});

test('a Library already at 90% is flagged even with nothing Ready', () => {
  const plan = planMoves({
    projects: [project('Keep', 10 * GB)],
    spaces: [{ drive: 'library', space: space(2 * TB, 1.84 * TB) }],
    libraryFull,
  });
  assert.equal(plan.readyCount, 0);
  assert.equal(plan.libraryStatus, 'full-now');
  assert.equal(plan.archiveBytesNeeded, 440 * GB); // 1.84 − 1.4
});
