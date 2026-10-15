'use strict';

// Tests for the move plan: does Move 1 fit on the Library, and does the
// Library need some of its oldest projects moved to the Archive?

const test = require('node:test');
const assert = require('node:assert/strict');
const { planMoves, planArchiveMoves } = require('../src/scoring/plan');

const GB = 1e9;
const TB = 1e12;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-15T12:00:00Z');
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

// --- Move 2: Library → Archive, oldest first ---------------------------------

function libraryProject(name, sizeGB, ageDays, extra = {}) {
  return { id: name, name, relPath: name, kind: 'project', missing: false, sizeBytes: sizeGB * GB, lastEditedMs: NOW - ageDays * DAY, ...extra };
}

const library = [
  libraryProject('Newer', 300, 30),
  libraryProject('Oldest', 200, 400),
  libraryProject('Middle', 250, 200),
  libraryProject('No dates', 500, 0, { lastEditedMs: null }), // can't be placed in order: never suggested
  libraryProject('Shared folder', 100, 999, { kind: 'shared' }), // never moved
  libraryProject('Already gone', 100, 999, { missing: true }),
];

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
}

test('Library past 90%: lists its oldest projects until it would be back at 70%', () => {
  // 1.84 TB of 2 TB = 92%. Down to 70% = 1.4 TB → free 440 GB: Oldest 200 + Middle 250.
  const plan = planArchiveMoves({ libraryProjects: library, space: space(2 * TB, 1.84 * TB), libraryFull, incomingBytes: 100 * GB });
  assert.equal(plan.status, 'full-now');
  near(plan.bytesToFree, 440 * GB);
  assert.deepEqual(plan.moves.map((p) => p.name), ['Oldest', 'Middle']);
  assert.equal(plan.movesBytes, 450 * GB);
  assert.equal(plan.enough, true);
  near(plan.percentAfterMoves, 69.5);
  // The Ready projects waiting on the SSD (100 GB) are counted after the moves.
  near(plan.percentAfterIncoming, 74.5);
});

test('Library under 90%, but the Ready projects would push it past: makes room for them first', () => {
  // 1.7 TB used (85%) + 200 GB Ready = 1.9 TB (95%). Down to 1.4 TB → free 500 GB.
  const plan = planArchiveMoves({ libraryProjects: library, space: space(2 * TB, 1.7 * TB), libraryFull, incomingBytes: 200 * GB });
  assert.equal(plan.status, 'full-after');
  near(plan.bytesToFree, 500 * GB);
  assert.deepEqual(plan.moves.map((p) => p.name), ['Oldest', 'Middle', 'Newer']);
  near(plan.percentAfterMoves, 57.5); // (1.9 TB − 750 GB) / 2 TB
});

test('Library with room: nothing to move, and says how much room is left before 90%', () => {
  const plan = planArchiveMoves({ libraryProjects: library, space: space(2 * TB, 1 * TB), libraryFull, incomingBytes: 200 * GB });
  assert.equal(plan.status, 'ok');
  assert.deepEqual(plan.moves, []);
  assert.equal(plan.roomBeforeLimitBytes, 600 * GB); // 1.8 TB limit − 1.2 TB
});

test("says so when moving every dated project still isn't enough", () => {
  const plan = planArchiveMoves({ libraryProjects: library, space: space(10 * TB, 9.5 * TB), libraryFull });
  assert.equal(plan.enough, false);
  assert.deepEqual(plan.moves.map((p) => p.name), ['Oldest', 'Middle', 'Newer']);
});

test('unknown Library space (never scanned, unplugged): no plan', () => {
  assert.equal(planArchiveMoves({ libraryProjects: library, space: null, libraryFull }), null);
});
