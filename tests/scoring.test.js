'use strict';

// Tests for the scoring formula and the Move 1 bucket rule:
//   Score = 0.45 × Done + 0.35 × Age + 0.20 × Size
//   Ready = finished (final export or Notion done) + not edited in 14 days + nothing uncertain
// Every expected number below is worked out by hand in the comments.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withDefaults } = require('../src/config');
const {
  scoreProject,
  scoreProjects,
  byOffloadOrder,
  donePart,
  agePart,
  sizePart,
  scoreBucket,
  DAY_MS,
} = require('../src/scoring/score');

const settings = withDefaults(); // 0.45 / 0.35 / 0.20, 14 → 120 days, Review at 40
const NOW = Date.parse('2026-10-15T12:00:00Z');
const GB = 1e9;

function daysAgo(days) {
  return NOW - days * DAY_MS;
}

// Scores a single project with sensible defaults; override what the test cares about.
function score(overrides, largestBytes = 100 * GB) {
  const project = {
    sizeBytes: 100 * GB,
    lastEditedMs: daysAgo(200),
    hasExport: false,
    hasFinalExport: false,
    ...overrides,
  };
  return scoreProject(project, settings, { now: NOW, largestBytes });
}

// --- Done ---------------------------------------------------------------------

test('Done: 100 when Notion says Complete or Delivered (any capitalization)', () => {
  assert.equal(donePart({ notionStatus: 'Complete' }, settings.doneStatuses), 100);
  assert.equal(donePart({ notionStatus: 'delivered ' }, settings.doneStatuses), 100);
});

test('Done: 70 for a FINAL export (a video named "Final" or "FD")', () => {
  assert.equal(donePart({ hasFinalExport: true }, settings.doneStatuses), 70);
  assert.equal(donePart({ hasFinalExport: true, notionStatus: 'In Progress' }, settings.doneStatuses), 70);
});

test('Done: 0 for draft exports — they may still be in revisions', () => {
  assert.equal(donePart({ hasExport: true, hasFinalExport: false }, settings.doneStatuses), 0);
  assert.equal(donePart({ hasExport: false, notionStatus: 'Editing' }, settings.doneStatuses), 0);
});

// --- Age ----------------------------------------------------------------------

test('Age: 0 within the 14-day window, including exactly 14 days', () => {
  assert.equal(agePart(0, settings.ageDays), 0);
  assert.equal(agePart(13.9, settings.ageDays), 0);
  assert.equal(agePart(14, settings.ageDays), 0);
});

test('Age: rises in a straight line from 14 to 120 days', () => {
  // 67 days is halfway: (67 − 14) / (120 − 14) = 53 / 106 = 0.5
  assert.equal(agePart(67, settings.ageDays), 50);
  // 40 days: (40 − 14) / 106 × 100 = 24.528...
  assert.ok(Math.abs(agePart(40, settings.ageDays) - 24.528) < 0.001);
});

test('Age: 100 at 120 days and beyond; 0 when there are no dated files', () => {
  assert.equal(agePart(120, settings.ageDays), 100);
  assert.equal(agePart(900, settings.ageDays), 100);
  assert.equal(agePart(null, settings.ageDays), 0);
});

// --- Size ---------------------------------------------------------------------

test('Size: percentage of the largest project (0 when every project is empty)', () => {
  assert.equal(sizePart(100 * GB, 100 * GB), 100);
  assert.equal(sizePart(25 * GB, 100 * GB), 25);
  assert.equal(sizePart(0, 100 * GB), 0);
  assert.equal(sizePart(0, 0), 0);
});

// --- The formula -------------------------------------------------------------

test('worked example: final export + 67 days + half size → 59', () => {
  // 0.45 × 70 + 0.35 × 50 + 0.20 × 50 = 31.5 + 17.5 + 10 = 59
  const result = score({ hasFinalExport: true, lastEditedMs: daysAgo(67), sizeBytes: 50 * GB });
  assert.deepEqual(result.parts, { done: 70, age: 50, size: 50 });
  assert.equal(result.score, 59);
});

test('perfect candidate: Notion done, old, largest → 100', () => {
  const result = score({ notionStatus: 'Complete' });
  assert.deepEqual(result.parts, { done: 100, age: 100, size: 100 });
  assert.equal(result.score, 100);
});

test('the score is rounded to 1 decimal', () => {
  // size 99.8% → 0.45 × 70 + 0.35 × 100 + 0.20 × 99.8 = 86.46 → 86.5
  assert.equal(score({ hasFinalExport: true, sizeBytes: 99.8 * GB }).score, 86.5);
});

// --- Buckets: the Move 1 rule -------------------------------------------------

test('finished and untouched for 14+ days → Ready, however low the score', () => {
  // Small and only 20 days old: 31.5 + 0.35 × 5.7 + 0.20 × 5 = 34.5 — still Ready
  const result = score({ hasFinalExport: true, lastEditedMs: daysAgo(20), sizeBytes: 5 * GB });
  assert.equal(result.score, 34.5);
  assert.equal(result.finished, true);
  assert.equal(result.bucket, 'Ready');
  assert.deepEqual(result.notes, []);
});

test('finished but edited in the last 14 days → Review, with how long to wait', () => {
  const result = score({ hasFinalExport: true, lastEditedMs: daysAgo(3.2) });
  assert.equal(result.bucket, 'Review');
  assert.match(result.notes[0], /edited 3 day\(s\) ago \(Ready in 11 day\(s\)/);
});

test('exactly 14 days counts as untouched for 14 days', () => {
  assert.equal(score({ hasFinalExport: true, lastEditedMs: daysAgo(14) }).bucket, 'Ready');
});

test('unfinished is never Ready: Review at 40+, Keep below', () => {
  // Draft export, very old, largest: 0 + 35 + 20 = 55 → Review
  const big = score({ hasExport: true });
  assert.equal(big.score, 55);
  assert.equal(big.bucket, 'Review');
  // Draft export, very old, 10% size: 0 + 35 + 2 = 37 → Keep
  assert.equal(score({ hasExport: true, sizeBytes: 10 * GB }).bucket, 'Keep');
});

test('unfinished is never Ready, even with weights that would score it 70+', () => {
  const ageHeavy = { ...settings, weights: { done: 0.1, age: 0.6, size: 0.3 } };
  const project = { sizeBytes: 100 * GB, lastEditedMs: daysAgo(300), hasFinalExport: false };
  const result = scoreProject(project, ageHeavy, { now: NOW, largestBytes: 100 * GB });
  assert.equal(result.score, 90);
  assert.equal(result.bucket, 'Review');
});

test('scoreBucket splits unfinished projects at the Review threshold', () => {
  assert.equal(scoreBucket(40, settings.buckets), 'Review');
  assert.equal(scoreBucket(39.9, settings.buckets), 'Keep');
  // 39.96 rounds to 40.0 before bucketing, so the shown number and the bucket agree
  const edge = score({ hasExport: true, sizeBytes: 24.8 * GB, lastEditedMs: daysAgo(120) }); // 0 + 35 + 4.96 = 39.96
  assert.equal(edge.score, 40);
  assert.equal(edge.bucket, 'Review');
});

// --- Safety overrides ------------------------------------------------------

test('pinned as Keep always means Keep, and says what it would have been', () => {
  const result = score({ notionStatus: 'Complete', pinnedKeep: true });
  assert.equal(result.bucket, 'Keep');
  assert.match(result.notes[0], /Pinned as Keep \(would be Ready\)/);
});

test('a pinned project is never Ready, whatever its exports, status, age, size or dates', () => {
  let readyWhenUnpinned = 0;
  for (const hasFinalExport of [false, true]) {
    for (const notionStatus of [undefined, 'Editing', 'Complete']) {
      for (const days of [null, 0, 13, 14, 60, 120, 1000]) {
        for (const sizeBytes of [0, 50 * GB, 100 * GB]) {
          for (const uncertain of [{}, { incomplete: true }, { futureDatedFiles: 2 }]) {
            const project = {
              hasExport: hasFinalExport,
              hasFinalExport,
              notionStatus,
              sizeBytes,
              lastEditedMs: days === null ? null : daysAgo(days),
              ...uncertain,
            };
            const label = JSON.stringify({ hasFinalExport, notionStatus, days, sizeBytes, ...uncertain });
            assert.equal(score({ ...project, pinnedKeep: true }).bucket, 'Keep', label);
            if (score(project).bucket === 'Ready') readyWhenUnpinned += 1;
          }
        }
      }
    }
  }
  // Without the pin, some of these really are Ready, so the pin is what keeps them out.
  assert.ok(readyWhenUnpinned > 0);
});

test("no dated files: a finished project still isn't Ready", () => {
  const result = score({ notionStatus: 'Complete', lastEditedMs: null });
  assert.equal(result.daysSinceEdit, null);
  assert.equal(result.parts.age, 0);
  assert.equal(result.bucket, 'Review');
  assert.match(result.notes[0], /no file dates/);
});

test('files with future dates (wrong camera clock) block Ready', () => {
  const result = score({ hasFinalExport: true, futureDatedFiles: 2 });
  assert.equal(result.bucket, 'Review');
  assert.match(result.notes[0], /future dates/);
});

test('footage newer than the final export blocks Ready, naming the file', () => {
  const result = score({ hasFinalExport: true, newerFootageFile: 'Game 2/Footage/clip.mov' });
  assert.equal(result.bucket, 'Review');
  assert.match(result.notes[0], /newer than its final export \(Game 2\/Footage\/clip\.mov\)/);
  assert.match(result.notes[0], /another shoot may still need editing/);
});

test("folders that couldn't be read block Ready", () => {
  const result = score({ hasFinalExport: true, incomplete: true });
  assert.equal(result.bucket, 'Review');
  assert.match(result.notes[0], /couldn't be read/);
});

test('several reasons are all listed in one note', () => {
  const result = score({ hasFinalExport: true, incomplete: true, futureDatedFiles: 1 });
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /future dates.*couldn't be read/);
});

test('a last-edited date slightly in the future counts as edited just now', () => {
  const result = score({ lastEditedMs: NOW + 2 * 60 * 60 * 1000 });
  assert.equal(result.daysSinceEdit, 0);
  assert.equal(result.parts.age, 0);
});

// --- Scoring a whole drive ---------------------------------------------------

test('scoreProjects measures size against the largest project and keeps the facts', () => {
  const projects = [
    { name: 'Big', sizeBytes: 200 * GB, lastEditedMs: daysAgo(200), hasFinalExport: true },
    { name: 'Small', sizeBytes: 50 * GB, lastEditedMs: daysAgo(200), hasFinalExport: false },
  ];
  const [big, small] = scoreProjects(projects, settings, NOW);
  assert.equal(big.name, 'Big');
  assert.equal(big.scoring.parts.size, 100);
  assert.equal(small.scoring.parts.size, 25);
  // Big:   31.5 + 35 + 20 = 86.5 → Ready
  // Small: 0 + 35 + 5     = 40   → Review
  assert.equal(big.scoring.score, 86.5);
  assert.equal(big.scoring.bucket, 'Ready');
  assert.equal(small.scoring.score, 40);
  assert.equal(small.scoring.bucket, 'Review');
});

test('scoreProjects handles an empty drive', () => {
  assert.deepEqual(scoreProjects([], settings, NOW), []);
});

test('report order: Ready biggest first, then Review and Keep by score, pinned never on top', () => {
  const list = [
    { name: 'review-low', sizeBytes: 1, scoring: { score: 45, bucket: 'Review' } },
    { name: 'ready-small', sizeBytes: 5, scoring: { score: 90, bucket: 'Ready' } },
    { name: 'pinned', sizeBytes: 9, scoring: { score: 95, bucket: 'Keep' } },
    { name: 'ready-big', sizeBytes: 50, scoring: { score: 40, bucket: 'Ready' } },
    { name: 'review-high', sizeBytes: 2, scoring: { score: 60, bucket: 'Review' } },
    { name: 'keep', sizeBytes: 3, scoring: { score: 10, bucket: 'Keep' } },
  ];
  assert.deepEqual(
    list.sort(byOffloadOrder).map((p) => p.name),
    ['ready-big', 'ready-small', 'review-high', 'review-low', 'pinned', 'keep'],
  );
});
