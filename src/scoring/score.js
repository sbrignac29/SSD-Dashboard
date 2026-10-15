'use strict';

// Scores and buckets for Move 1 of the workflow: working SSD → Library HDD
// ("move recent projects that are done").
//
//   Score = 0.45 × Done + 0.35 × Age + 0.20 × Size     (each part 0–100)
//
//   Done: 100 if Notion says Complete/Delivered, 70 if there's a FINAL export
//         (named "Final"/"FD" or in a "Final Exports" folder), else 0.
//         Draft exports don't count.
//   Age:  0 if edited in the last 14 days, rising in a straight line to 100 at 120+ days
//   Size: the project's size as a percentage of the largest project
//
// Buckets follow the workflow rule, not just the score:
//   Ready  – finished (Done > 0) AND safe to move: not edited in the last 14
//            days, no footage newer than the final export, and nothing
//            uncertain about when it was last edited.
//   Review – finished but not safe to move yet, or unfinished with a score of 40+
//   Keep   – unfinished with a score under 40, or pinned in folders.keepPinned
// The score orders Review and Keep; Ready is ordered biggest first, because
// moving those frees the most space.
//
// The weights, day counts, threshold and "done" statuses come from the
// config. This file is pure math — it never touches the disk.

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo1(value) {
  return Math.round(value * 10) / 10;
}

// Done (0, 70 or 100).
function donePart({ notionStatus, hasFinalExport }, doneStatuses) {
  if (notionStatus) {
    const status = String(notionStatus).trim().toLowerCase();
    if (doneStatuses.some((done) => done.trim().toLowerCase() === status)) return 100;
  }
  return hasFinalExport ? 70 : 0;
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

// For unfinished projects: Review at the threshold or above, else Keep.
function scoreBucket(score, { review }) {
  return score >= review ? 'Review' : 'Keep';
}

// Reasons a finished project isn't safe to move yet, as short phrases.
function readyBlockers(project, daysSinceEdit, ageDays) {
  const reasons = [];
  if (daysSinceEdit === null) {
    reasons.push('no file dates were found');
  } else if (daysSinceEdit < ageDays.recent) {
    const daysLeft = Math.max(1, Math.ceil(ageDays.recent - daysSinceEdit));
    reasons.push(`it was edited ${Math.floor(daysSinceEdit)} day(s) ago (Ready in ${daysLeft} day(s) if left alone)`);
  }
  if (project.futureDatedFiles > 0) {
    reasons.push(`${project.futureDatedFiles} file(s) have future dates (camera clock?), so the real last edit is unknown`);
  }
  if (project.incomplete) {
    reasons.push("some of its folders couldn't be read");
  }
  if (project.newerFootageFile) {
    reasons.push(
      `it has a video or photo newer than its final export (${project.newerFootageFile}): if that's new ` +
        "footage, another shoot may still need editing; if it's a cut-down or re-export, move it into " +
        'Exports or name it Final/FD',
    );
  }
  return reasons;
}

// Scores one project.
//   project:  { sizeBytes, lastEditedMs, hasFinalExport, notionStatus?, pinnedKeep?,
//               futureDatedFiles?, incomplete?, newerFootageFile? }
//   settings: { weights, ageDays, buckets, doneStatuses } — i.e. the config
//   context:  { now, largestBytes }
// Returns { score, bucket, finished, parts: { done, age, size }, daysSinceEdit, notes }.
function scoreProject(project, settings, { now, largestBytes }) {
  const { weights, ageDays, buckets, doneStatuses } = settings;

  // The scanner already ignores files dated more than a day ahead. Anything
  // left that's slightly in the future counts as "just now" (age 0).
  const daysSinceEdit =
    project.lastEditedMs === null || project.lastEditedMs === undefined
      ? null
      : Math.max(0, (now - project.lastEditedMs) / DAY_MS);

  const parts = {
    done: donePart(project, doneStatuses),
    age: agePart(daysSinceEdit, ageDays),
    size: sizePart(project.sizeBytes, largestBytes),
  };
  // Round first, so the number you see is the number the buckets use.
  const score = roundTo1(weights.done * parts.done + weights.age * parts.age + weights.size * parts.size);
  const finished = parts.done > 0;

  // The bucket the workflow rule gives, before any pin.
  let bucket;
  let waitingNote = null;
  if (finished) {
    const reasons = readyBlockers(project, daysSinceEdit, ageDays);
    bucket = reasons.length === 0 ? 'Ready' : 'Review';
    if (reasons.length > 0) waitingNote = `Finished, but ${reasons.join('; ')} — not Ready yet.`;
  } else {
    bucket = scoreBucket(score, buckets);
  }

  const notes = [];
  if (project.pinnedKeep) {
    if (bucket !== 'Keep') notes.push(`Pinned as Keep (would be ${bucket}).`);
    bucket = 'Keep';
  } else if (waitingNote) {
    notes.push(waitingNote);
  }

  return {
    score,
    bucket,
    finished,
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

const BUCKET_ORDER = { Ready: 0, Review: 1, Keep: 2 };

// The report's order: Ready first (biggest first — frees the most space),
// then Review, then Keep (highest score first, then biggest). Sorting by
// bucket first keeps a pinned project from showing up at the top.
function byOffloadOrder(a, b) {
  const byBucket = BUCKET_ORDER[a.scoring.bucket] - BUCKET_ORDER[b.scoring.bucket];
  if (byBucket !== 0) return byBucket;
  if (a.scoring.bucket === 'Ready') return b.sizeBytes - a.sizeBytes;
  return b.scoring.score - a.scoring.score || b.sizeBytes - a.sizeBytes;
}

module.exports = {
  scoreProject,
  scoreProjects,
  byOffloadOrder,
  donePart,
  agePart,
  sizePart,
  scoreBucket,
  readyBlockers,
  DAY_MS,
};
