'use strict';

// Tests for the scoring formula:
//   Score = 0.45 × Done + 0.35 × Age + 0.20 × Size
// Every expected number below is worked out by hand in the comments.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withDefaults } = require('../src/config');
const {
  scoreProject,
  scoreProjects,
  byScoreThenSize,
  donePart,
  agePart,
  sizePart,
  bucketFor,
  DAY_MS,
} = require('../src/scoring/score');

const settings = withDefaults(); // 0.45 / 0.35 / 0.20, 14 → 120 days, 70 / 40
const NOW = Date.parse('2026-10-15T12:00:00Z');
const GB = 1e9;

function daysAgo(days) {
  return NOW - days * DAY_MS;
}

// Scores a single project with sensible defaults; override what the test cares about.
function score(overrides, largestBytes = 100 * GB) {
  const project = { sizeBytes: 100 * GB, lastEditedMs: daysAgo(200), hasExport: false, ...overrides };
  return scoreProject(project, settings, { now: NOW, largestBytes });
}

// --- Done ---------------------------------------------------------------------

test('Done: 100 when Notion says Complete or Delivered (any capitalization)', () => {
  assert.equal(donePart({ notionStatus: 'Complete' }, settings.doneStatuses), 100);
  assert.equal(donePart({ notionStatus: 'delivered ' }, settings.doneStatuses), 100);
});

test('Done: 70 when a final export exists', () => {
  assert.equal(donePart({ hasExport: true }, settings.doneStatuses), 70);
  assert.equal(donePart({ hasExport: true, notionStatus: 'In Progress' }, settings.doneStatuses), 70);
});

test('Done: 0 otherwise', () => {
  assert.equal(donePart({ hasExport: false }, settings.doneStatuses), 0);
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

test('Age: 100 at 120 days and beyond', () => {
  assert.equal(agePart(120, settings.ageDays), 100);
  assert.equal(agePart(900, settings.ageDays), 100);
});

test('Age: 0 when there are no dated files (cautious)', () => {
  assert.equal(agePart(null, settings.ageDays), 0);
});

// --- Size ---------------------------------------------------------------------

test('Size: percentage of the largest project', () => {
  assert.equal(sizePart(100 * GB, 100 * GB), 100);
  assert.equal(sizePart(25 * GB, 100 * GB), 25);
  assert.equal(sizePart(0, 100 * GB), 0);
});

test('Size: 0 when every project is empty (no dividing by zero)', () => {
  assert.equal(sizePart(0, 0), 0);
});

// --- Buckets ------------------------------------------------------------------

test('Buckets: Ready 70+, Review 40–69.9, Keep under 40', () => {
  assert.equal(bucketFor(100, settings.buckets), 'Ready');
  assert.equal(bucketFor(70, settings.buckets), 'Ready');
  assert.equal(bucketFor(69.9, settings.buckets), 'Review');
  assert.equal(bucketFor(40, settings.buckets), 'Review');
  assert.equal(bucketFor(39.9, settings.buckets), 'Keep');
  assert.equal(bucketFor(0, settings.buckets), 'Keep');
});

// --- The whole formula ------------------------------------------------------

test('perfect candidate: done, old, largest → 100, Ready', () => {
  const result = score({ notionStatus: 'Complete' });
  assert.deepEqual(result.parts, { done: 100, age: 100, size: 100 });
  assert.equal(result.score, 100);
  assert.equal(result.bucket, 'Ready');
});

test('worked example: export + 67 days + half size → 59, Review', () => {
  // 0.45 × 70 + 0.35 × 50 + 0.20 × 50 = 31.5 + 17.5 + 10 = 59
  const result = score({ hasExport: true, lastEditedMs: daysAgo(67), sizeBytes: 50 * GB });
  assert.deepEqual(result.parts, { done: 70, age: 50, size: 50 });
  assert.equal(result.score, 59);
  assert.equal(result.bucket, 'Review');
});

test('worked example: export + 120 days + 25% size → 71.5, Ready', () => {
  // 0.45 × 70 + 0.35 × 100 + 0.20 × 25 = 31.5 + 35 + 5 = 71.5
  const result = score({ hasExport: true, lastEditedMs: daysAgo(120), sizeBytes: 25 * GB });
  assert.equal(result.score, 71.5);
  assert.equal(result.bucket, 'Ready');
});

test('old but unfinished, small → Review or Keep, never Ready', () => {
  // 0 + 0.35 × 100 + 0.20 × 10 = 37 → Keep
  assert.equal(score({ sizeBytes: 10 * GB }).bucket, 'Keep');
  // 0 + 35 + 0.20 × 100 = 55 → Review
  assert.equal(score({}).bucket, 'Review');
});

test('the score is rounded to 1 decimal before picking the bucket', () => {
  // size 99.8% → 0.45 × 70 + 0.35 × 100 + 0.20 × 99.8 = 86.46 → 86.5
  assert.equal(score({ hasExport: true, sizeBytes: 99.8 * GB }).score, 86.5);
  // size 17.3% → 31.5 + 35 + 3.46 = 69.96 → shown as 70.0, so it must be Ready
  const edge = score({ hasExport: true, sizeBytes: 17.3 * GB });
  assert.equal(edge.score, 70);
  assert.equal(edge.bucket, 'Ready');
});

// --- Safety overrides ------------------------------------------------------

test('never Ready when edited in the last 14 days, even with weights that would allow it', () => {
  const doneHeavy = { ...settings, weights: { done: 0.8, age: 0.1, size: 0.1 } };
  const project = { sizeBytes: 100 * GB, lastEditedMs: daysAgo(3), notionStatus: 'Delivered' };
  // 0.8 × 100 + 0.1 × 0 + 0.1 × 100 = 90, but edited 3 days ago
  const result = scoreProject(project, doneHeavy, { now: NOW, largestBytes: 100 * GB });
  assert.equal(result.score, 90);
  assert.equal(result.bucket, 'Review');
  assert.match(result.notes[0], /edited 3 day\(s\) ago/);
});

test('with the default weights a recent project tops out at 65 anyway', () => {
  // 0.45 × 100 + 0.35 × 0 + 0.20 × 100 = 65
  const result = score({ notionStatus: 'Complete', lastEditedMs: daysAgo(1) });
  assert.equal(result.score, 65);
  assert.equal(result.bucket, 'Review');
});

test('pinned as Keep always means Keep', () => {
  const result = score({ notionStatus: 'Complete', pinnedKeep: true });
  assert.equal(result.score, 100);
  assert.equal(result.bucket, 'Keep');
  assert.match(result.notes[0], /Pinned as Keep/);
});

test('no dated files: age counts as 0 and it can never be Ready', () => {
  const doneHeavy = { ...settings, weights: { done: 0.8, age: 0.1, size: 0.1 } };
  const project = { sizeBytes: 100 * GB, lastEditedMs: null, notionStatus: 'Complete' };
  const result = scoreProject(project, doneHeavy, { now: NOW, largestBytes: 100 * GB });
  assert.equal(result.daysSinceEdit, null);
  assert.equal(result.parts.age, 0);
  assert.equal(result.bucket, 'Review');
});

test('files with future dates (wrong camera clock) block Ready', () => {
  // 31.5 + 35 + 20 = 86.5 would be Ready
  const result = score({ hasExport: true, futureDatedFiles: 2 });
  assert.equal(result.score, 86.5);
  assert.equal(result.bucket, 'Review');
  assert.match(result.notes[0], /future dates/);
});

test("folders that couldn't be read block Ready", () => {
  const result = score({ hasExport: true, incomplete: true });
  assert.equal(result.bucket, 'Review');
  assert.match(result.notes[0], /couldn't be read/);
});

test('several reasons are all listed in one note', () => {
  const result = score({ hasExport: true, incomplete: true, futureDatedFiles: 1 });
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /future dates.*couldn't be read/);
});

test('a last-edited date in the future counts as edited just now', () => {
  const result = score({ lastEditedMs: NOW + 30 * DAY_MS });
  assert.equal(result.daysSinceEdit, 0);
  assert.equal(result.parts.age, 0);
});

// --- Scoring a whole drive ---------------------------------------------------

test('scoreProjects measures size against the largest project and keeps the facts', () => {
  const projects = [
    { name: 'Big', sizeBytes: 200 * GB, lastEditedMs: daysAgo(200), hasExport: true },
    { name: 'Small', sizeBytes: 50 * GB, lastEditedMs: daysAgo(200), hasExport: false },
  ];
  const [big, small] = scoreProjects(projects, settings, NOW);
  assert.equal(big.name, 'Big');
  assert.equal(big.scoring.parts.size, 100);
  assert.equal(small.scoring.parts.size, 25);
  // Big:   31.5 + 35 + 20 = 86.5 → Ready
  // Small: 0 + 35 + 5     = 40   → Review
  assert.equal(big.scoring.score, 86.5);
  assert.equal(small.scoring.score, 40);
  assert.equal(small.scoring.bucket, 'Review');
});

test('scoreProjects handles an empty drive', () => {
  assert.deepEqual(scoreProjects([], settings, NOW), []);
});

test('sorting: Ready, then Review, then Keep; highest score then biggest within each', () => {
  const list = [
    { name: 'a', sizeBytes: 1, scoring: { score: 50, bucket: 'Review' } },
    { name: 'b', sizeBytes: 9, scoring: { score: 80, bucket: 'Ready' } },
    { name: 'c', sizeBytes: 5, scoring: { score: 50, bucket: 'Review' } },
    { name: 'pinned', sizeBytes: 9, scoring: { score: 95, bucket: 'Keep' } },
    { name: 'recent', sizeBytes: 9, scoring: { score: 75, bucket: 'Review' } },
  ];
  assert.deepEqual(list.sort(byScoreThenSize).map((p) => p.name), ['b', 'recent', 'c', 'a', 'pinned']);
});
