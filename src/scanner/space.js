'use strict';

// How full each drive is. Uses the operating system's "statfs" call, which
// reports a drive's total size and free space (the same numbers Finder shows
// in Get Info for a drive). Read-only: it doesn't look at any files.

const fsp = require('node:fs/promises');
const { DRIVE_LABELS, configuredDrives } = require('../config');

// Returns { totalBytes, freeBytes, usedBytes, usedPercent } for the drive
// that `drivePath` is on, or null if the path isn't there (drive unplugged).
async function driveSpace(drivePath) {
  let stats;
  try {
    stats = await fsp.statfs(drivePath);
  } catch {
    return null;
  }
  const totalBytes = stats.blocks * stats.bsize;
  // bavail = blocks free for normal use (what Finder calls "Available").
  const freeBytes = stats.bavail * stats.bsize;
  const usedBytes = totalBytes - freeBytes;
  return { totalBytes, freeBytes, usedBytes, usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0 };
}

// Space on every drive that has a path in config:
//   [{ drive: 'working', label: 'Working SSD', path, space: {...} | null }, ...]
async function allDriveSpace(config) {
  return Promise.all(
    configuredDrives(config).map(async ([drive, drivePath]) => ({
      drive,
      label: DRIVE_LABELS[drive],
      path: drivePath,
      space: await driveSpace(drivePath),
    })),
  );
}

module.exports = { driveSpace, allDriveSpace };
