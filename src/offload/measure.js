'use strict';

// Counts what's in one folder, live, for moves (Phase 5): how many files, how
// many bytes, and when anything in it last changed.
//
// Used three times per move:
//   1. the preview: size and file count of the project you're about to move
//   2. the pre-check "not changed in the last 10 minutes"
//   3. the spot check after VeriCopy says "verified": the copy must have the
//      same number of files and the same total bytes as the original
//
// SAFETY: read-only, like the scanner: only readdir and lstat. It never
// follows shortcuts (symlinks), so it can't wander off the folder.
//
// Two kinds of Mac housekeeping files are left out of the counts, on both
// sides, and counted separately instead:
//   .DS_Store  Finder writes one into any folder you merely LOOK at. Opening the
//              half-copied folder in Finder during the copy would add one to
//              the destination and make a perfect copy look wrong.
//   ._name     "AppleDouble" files: when a Mac writes to a drive that can't
//              store Mac file extras (exFAT, like many external HDDs), it keeps
//              them in a hidden ._ file next to each file. The copy can gain or
//              lose these depending on the drive format, not on whether the
//              media was copied.
// Neither holds any of your media, and VeriCopy's checksums already verified
// every file it copied. Every other file counts, hidden or not.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { isHousekeepingName } = require('../scanner/classify');

function isMacClutter(name) {
  return name === '.DS_Store' || name.startsWith('._');
}

// Premiere Pro (with project locking on) keeps a "<project>.prlock" file next to
// a project while it's open.
function isPremiereLock(name) {
  return name.toLowerCase().endsWith('.prlock');
}

// Walks `folder` and returns
//   { files, bytes, clutterFiles, clutterBytes, symlinks, unreadable: [relative paths],
//     newestMs, newestFile (relative), premiereLocks: [relative paths] }
// newestMs ignores housekeeping files (like the scanner: Finder rewrites them
// just from browsing) and impossible dates more than a day after `now` (a
// camera with a wrong clock). Throws if `folder` itself can't be read.
async function measureFolder(folder, { now = Date.now() } = {}) {
  const latestBelievable = now + 24 * 60 * 60 * 1000;
  const result = {
    files: 0,
    bytes: 0,
    clutterFiles: 0,
    clutterBytes: 0,
    symlinks: 0,
    unreadable: [],
    newestMs: null,
    newestFile: null,
    premiereLocks: [],
  };
  const pending = [''];
  while (pending.length > 0) {
    const relDir = pending.pop();
    let entries;
    try {
      entries = await fsp.readdir(path.join(folder, relDir), { withFileTypes: true });
    } catch (error) {
      if (relDir === '') throw error;
      result.unreadable.push(relDir);
      continue;
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      let stats;
      try {
        stats = await fsp.lstat(path.join(folder, rel));
      } catch {
        result.unreadable.push(rel);
        continue;
      }
      if (stats.isSymbolicLink()) {
        result.symlinks += 1;
      } else if (stats.isDirectory()) {
        pending.push(rel);
      } else if (stats.isFile()) {
        if (isMacClutter(entry.name)) {
          result.clutterFiles += 1;
          result.clutterBytes += stats.size;
          continue;
        }
        result.files += 1;
        result.bytes += stats.size;
        if (isPremiereLock(entry.name)) result.premiereLocks.push(rel);
        const dated = !isHousekeepingName(entry.name) && stats.mtimeMs <= latestBelievable;
        if (dated && (result.newestMs === null || stats.mtimeMs > result.newestMs)) {
          result.newestMs = stats.mtimeMs;
          result.newestFile = rel;
        }
      }
    }
  }
  return result;
}

module.exports = { measureFolder, isMacClutter };
