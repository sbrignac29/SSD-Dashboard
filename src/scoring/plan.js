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

module.exports = { planMoves };
