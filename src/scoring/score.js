'use strict';

// The offload score: how good a candidate a project is for moving to archive.
//
//   Score = 0.45 × Done + 0.35 × Age + 0.20 × Size     (each part 0–100)
//
//   Done: 100 if Notion says Complete/Delivered, 70 if a final export exists, else 0
//   Age:  0 if edited in the last 14 days, rising in a straight line to 100 at 120+ days
//   Size: the project's size as a percentage of the largest project
//
//   Buckets: Ready (70+), Review (40–69.9), Keep (under 40)
//   Safety overrides: never Ready if edited in the last 14 days (or if we
//   can't tell when it was edited); pinned projects are always Keep.
//
// The weights, day counts, thresholds and "done" statuses come from the
// config. This file is pure math — it never touches the disk.

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo1(value) {
  return Math.round(value * 10) / 10;
}

// Done (0, 70 or 100).
function donePart({ notionStatus, hasExport }, doneStatuses) {
  if (notionStatus) {
    const status = String(notionStatus).trim().toLowerCase();
    if (doneStatuses.some((done) => done.trim().toLowerCase() === status)) return 100;
  }
  return hasExport ? 70 : 0;
}

// Age (0–100) from days since the last edit.
//   null (no dated files) → 0, the cautious answer.
function agePart(daysSinceEdit, { recent, max }) {
  if (daysSinceEdit === null || daysSinceEdit <= recent) return 0;
  if (daysSinceEdit >= max) return 100;
  return ((daysSinceEdit - recent) / (max - recent)) * 100;
}

// Size (0–100) relative to the largest project.
function sizePart(sizeBytes, largestBytes) {
  if (!(largestBytes > 0)) return 0;
  return clamp((sizeBytes / largestBytes) * 100, 0, 100);
}

function bucketFor(score, { ready, review }) {
  if (score >= ready) return 'Ready';
  if (score >= review) return 'Review';
  return 'Keep';
}

// Scores one project.
//   project:  { sizeBytes, lastEditedMs, hasExport, notionStatus?, pinnedKeep? }
//   settings: { weights, ageDays, buckets, doneStatuses } — i.e. the config
//   context:  { now, largestBytes }
// Returns { score, bucket, parts: { done, age, size }, daysSinceEdit, notes }.
function scoreProject(project, settings, { now, largestBytes }) {
  const { weights, ageDays, buckets, doneStatuses } = settings;

  // A date in the future (wrong clock) counts as "just now": the cautious answer.
  const daysSinceEdit =
    project.lastEditedMs === null || project.lastEditedMs === undefined
      ? null
      : Math.max(0, (now - project.lastEditedMs) / DAY_MS);

  const parts = {
    done: donePart(project, doneStatuses),
    age: agePart(daysSinceEdit, ageDays),
    size: sizePart(project.sizeBytes, largestBytes),
  };
  const raw = weights.done * parts.done + weights.age * parts.age + weights.size * parts.size;

  // Round first, then pick the bucket, so the number you see and the bucket
  // always agree (a 69.96 shows as 70.0, so it's Ready).
  const score = roundTo1(raw);
  let bucket = bucketFor(score, buckets);
  const notes = [];

  if (project.pinnedKeep) {
    if (bucket !== 'Keep') notes.push(`Pinned as Keep (would be ${bucket} at ${score.toFixed(1)}).`);
    bucket = 'Keep';
  } else if (bucket === 'Ready' && daysSinceEdit === null) {
    bucket = 'Review';
    notes.push('Would be Ready, but no file dates were found — capped at Review.');
  } else if (bucket === 'Ready' && daysSinceEdit < ageDays.recent) {
    bucket = 'Review';
    notes.push(
      `Would be Ready, but was edited ${Math.floor(daysSinceEdit)} day(s) ago ` +
        `(within ${ageDays.recent}) — capped at Review.`,
    );
  }

  return {
    score,
    bucket,
    parts: { done: parts.done, age: roundTo1(parts.age), size: roundTo1(parts.size) },
    daysSinceEdit,
    notes,
  };
}

// Scores a list of projects against each other (the Size part needs the
// largest). Returns new objects: each project's facts plus `scoring`.
function scoreProjects(projects, settings, now) {
  const largestBytes = projects.reduce((largest, p) => Math.max(largest, p.sizeBytes || 0), 0);
  return projects.map((project) => ({
    ...project,
    scoring: scoreProject(project, settings, { now, largestBytes }),
  }));
}

// Best offload candidates first: highest score, then biggest.
function byScoreThenSize(a, b) {
  return b.scoring.score - a.scoring.score || b.sizeBytes - a.sizeBytes;
}

module.exports = { scoreProject, scoreProjects, byScoreThenSize, donePart, agePart, sizePart, bucketFor, DAY_MS };
