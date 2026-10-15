'use strict';

// LATER PHASE — stub only.
//
// Will use node-cron (a scheduler) to run a scan every night while the
// dashboard server is running, and save the results to the database.
// Scans are read-only, so this can never change the SSD.

function scheduleNightlyScan() {
  throw new Error('Nightly scans are not built yet (later phase).');
}

module.exports = { scheduleNightlyScan };
