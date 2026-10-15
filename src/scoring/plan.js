'use strict';

// The move plan, in numbers:
//   - how much space moving the Ready projects frees on the working SSD
//   - whether they fit on the Library HDD
//   - whether the Library is (or would become) full enough that its oldest
//     projects should go to the Archive (libraryFull.startAtPercent, e.g. 90%),
//     and roughly how much to move to get back down to targetPercent (e.g. 70%)
//
// Pure math on numbers the scanner and space.js already collected. Sizes are
// file sizes, so on-disk numbers can differ a little.

function percentOf(part, whole) {
  return whole > 0 ? (part / whole) * 100 : 0;
}

//   projects:    scored projects (with .scoring.bucket)
//   spaces:      from space.allDriveSpace(): [{ drive, space: {...} | null }]
//   libraryFull: { startAtPercent, targetPercent } from config
function planMoves({ projects, spaces, libraryFull }) {
  const ready = projects.filter((p) => p.scoring.bucket === 'Ready');
  const readyBytes = ready.reduce((total, p) => total + p.sizeBytes, 0);
  const spaceOf = (drive) => spaces.find((s) => s.drive === drive)?.space ?? null;
  const working = spaceOf('working');
  const library = spaceOf('library');

  const plan = {
    readyCount: ready.length,
    readyBytes,
    workingPercentNow: working ? working.usedPercent : null,
    workingPercentAfter: working ? percentOf(Math.max(0, working.usedBytes - readyBytes), working.totalBytes) : null,
    libraryConnected: Boolean(library),
    libraryPercentNow: null,
    libraryPercentAfter: null,
    libraryFreeAfterBytes: null,
    fitsOnLibrary: null,
    // 'ok' | 'full-now' | 'full-after' (only after moving the Ready projects)
    libraryStatus: null,
    archiveBytesNeeded: 0,
  };

  if (library) {
    const usedAfter = library.usedBytes + readyBytes;
    plan.libraryPercentNow = library.usedPercent;
    plan.libraryPercentAfter = percentOf(usedAfter, library.totalBytes);
    plan.libraryFreeAfterBytes = library.freeBytes - readyBytes;
    plan.fitsOnLibrary = plan.libraryFreeAfterBytes >= 0;
    if (plan.libraryPercentNow >= libraryFull.startAtPercent) plan.libraryStatus = 'full-now';
    else if (plan.libraryPercentAfter >= libraryFull.startAtPercent) plan.libraryStatus = 'full-after';
    else plan.libraryStatus = 'ok';
    if (plan.libraryStatus !== 'ok') {
      const targetUsed = (libraryFull.targetPercent / 100) * library.totalBytes;
      plan.archiveBytesNeeded = Math.max(0, usedAfter - targetUsed);
    }
  }
  return plan;
}

// Move 2: which Library projects to move to the Archive, oldest first, once
// the Library is past libraryFull.startAtPercent — enough to bring it down to
// libraryFull.targetPercent. (The dashboard's Done HDD page shows this.)
//   libraryProjects: the Library's saved projects (relPath, sizeBytes, lastEditedMs, kind, missing)
//   space:           the Library's { totalBytes, freeBytes } (now, or from its last scan); null if unknown
//   incomingBytes:   the Ready projects waiting on the Working SSD (Move 1 lands on the Library)
// Two cases need moves:
//   'full-now'   – the Library is past the limit already: the list brings what's
//                  on it now down to the target (percentAfterIncoming then says
//                  where the Ready projects would take it)
//   'full-after' – it's under the limit, but the Ready projects would take it
//                  past: the list makes room for them first
// Returns null if the space is unknown, else
//   { status: 'ok' | 'full-now' | 'full-after', usedPercent, incomingBytes, percentAfterIncoming,
//     bytesToFree, moves: [projects, oldest first], movesBytes, percentAfterMoves,
//     enough (false if moving every dated project still isn't enough), roomBeforeLimitBytes }
function planArchiveMoves({ libraryProjects, space, libraryFull, incomingBytes = 0 }) {
  if (!space || !(space.totalBytes > 0)) return null;
  const usedBytes = space.totalBytes - space.freeBytes;
  const limitBytes = (libraryFull.startAtPercent / 100) * space.totalBytes;
  const result = {
    status: 'ok',
    usedPercent: percentOf(usedBytes, space.totalBytes),
    incomingBytes,
    percentAfterIncoming: percentOf(usedBytes + incomingBytes, space.totalBytes),
    bytesToFree: 0,
    moves: [],
    movesBytes: 0,
    percentAfterMoves: null,
    enough: true,
    roomBeforeLimitBytes: Math.max(0, limitBytes - usedBytes - incomingBytes),
  };
  if (result.usedPercent >= libraryFull.startAtPercent) result.status = 'full-now';
  else if (incomingBytes > 0 && result.percentAfterIncoming >= libraryFull.startAtPercent) result.status = 'full-after';
  if (result.status === 'ok') return result;

  const usedToPlanFor = result.status === 'full-now' ? usedBytes : usedBytes + incomingBytes;
  result.bytesToFree = Math.max(0, usedToPlanFor - (libraryFull.targetPercent / 100) * space.totalBytes);
  // Oldest = least recently edited. Projects with no dated files can't be
  // placed in that order, so they're never suggested.
  const oldestFirst = libraryProjects
    .filter((p) => p.kind === 'project' && !p.missing && p.lastEditedMs !== null && p.lastEditedMs !== undefined)
    .sort((a, b) => a.lastEditedMs - b.lastEditedMs || b.sizeBytes - a.sizeBytes);
  for (const project of oldestFirst) {
    if (result.movesBytes >= result.bytesToFree) break;
    result.moves.push(project);
    result.movesBytes += project.sizeBytes;
  }
  result.enough = result.movesBytes >= result.bytesToFree;
  result.percentAfterMoves = percentOf(Math.max(0, usedToPlanFor - result.movesBytes), space.totalBytes);
  if (result.status === 'full-now') {
    result.percentAfterIncoming = percentOf(Math.max(0, usedBytes - result.movesBytes) + incomingBytes, space.totalBytes);
  }
  return result;
}

module.exports = { planMoves, planArchiveMoves };
