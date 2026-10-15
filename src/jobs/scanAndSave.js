'use strict';

// One full scan of a drive, saved to the database. `npm run scan`, the
// nightly job (nightly.js) and the dashboard's Scan now button all use this,
// so they always behave the same way.
//
// The scan itself only READS the drive (src/scanner/scan.js); the only writing
// is to the database in data/ (src/db.js).

const { scanDrive, ScanError } = require('../scanner/scan');
const { driveSpace } = require('../scanner/space');
const { DRIVE_LABELS } = require('../config');
const { saveScan, recordFailedScan, SAVED_DRIVES } = require('../db');

// Scans one whole drive, saves the results, and returns
// { scan, scanId, drive, projects, added, updated, returned, markedMissing }.
// If the scan fails (drive unplugged, ...), the failure is recorded in the
// `scans` table and the error is passed on to the caller.
//   drive      – 'working' (the default: scanned and scored) or 'library'
//   now        – the scan's start time; file ages are measured from it
//   onProgress – called after each folder with { name, filesScanned, foldersDone, foldersTotal }
async function scanAndSave({ config, db, drive = 'working', now = Date.now(), onProgress }) {
  if (!SAVED_DRIVES.includes(drive)) throw new Error(`Only these drives can be scanned and saved: ${SAVED_DRIVES.join(', ')}`);
  const root = config.drives[drive];
  // An empty path would mean "the current folder" — never scan that by accident.
  if (typeof root !== 'string' || root.trim() === '') {
    throw new ScanError(`No path is set for your ${DRIVE_LABELS[drive]} ("drives.${drive}" in config.json).`);
  }
  try {
    const scan = await scanDrive(config, { root, now, onProgress });
    // How full the drive is right now, so the dashboard can still show it
    // after the drive is unplugged. (statfs: read-only, see space.js.)
    const space = await driveSpace(root);
    return { scan, ...saveScan(db, scan, config, { finishedAt: Date.now(), space }) };
  } catch (error) {
    // If the database itself is locked, recording would just wait and fail too.
    if (error?.code !== 'SQLITE_BUSY') {
      try {
        recordFailedScan(db, { root, startedAt: now, error, drive });
      } catch {
        // The database itself is the problem; the original error says more.
      }
    }
    throw error;
  }
}

module.exports = { scanAndSave };
