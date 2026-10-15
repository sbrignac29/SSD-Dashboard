'use strict';

// One full scan of the SSD, saved to the database. Both `npm run scan` and the
// nightly job (nightly.js) use this, so they always behave the same way.
//
// The scan itself only READS the SSD (src/scanner/scan.js); the only writing
// is to the database in data/ (src/db.js).

const { scanDrive } = require('../scanner/scan');
const { saveScan, recordFailedScan } = require('../db');

// Scans config.ssdPath, saves the results, and returns
// { scan, scanId, projects (scored), added, updated, returned, markedMissing }.
// If the scan fails (SSD unplugged, ...), the failure is recorded in the
// `scans` table and the error is passed on to the caller.
//   now        – the scan's start time; file ages are measured from it
//   onProgress – called after each folder with { name, filesScanned }
async function scanAndSave({ config, db, now = Date.now(), onProgress }) {
  try {
    const scan = await scanDrive(config, { now, onProgress });
    return { scan, ...saveScan(db, scan, config, { finishedAt: Date.now() }) };
  } catch (error) {
    // If the database itself is locked, recording would just wait and fail too.
    if (error?.code !== 'SQLITE_BUSY') {
      try {
        recordFailedScan(db, { root: config.ssdPath, startedAt: now, error });
      } catch {
        // The database itself is the problem; the original error says more.
      }
    }
    throw error;
  }
}

module.exports = { scanAndSave };
