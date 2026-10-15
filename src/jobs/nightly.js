'use strict';

// The nightly scan: at 2:00 AM every night, scan the SSD and save the results
// to the database, so the dashboard has fresh numbers each morning.
//
// Phase 2 builds the job; nothing starts it yet. In Phase 3 the dashboard
// server will call scheduleNightlyScan() when it starts, and the scans run
// for as long as the server is running.
//
// It uses node-cron, a library that runs a function on a schedule written as
// a "cron expression": five fields, separated by spaces.
//
//   minute  hour  day-of-month  month  day-of-week
//     0      2         *          *         *        → 2:00 AM, every day
//
// (* means "every".) The time is your Mac's own clock and time zone.
//
// Good to know:
//   - If the Mac is asleep at 2 AM, that night's scan is skipped (node-cron
//     only runs while the computer is awake).
//   - If the SSD isn't plugged in, the scan fails safely: it's recorded as
//     "failed" in the scans table and nothing in the database is changed.
//   - Scans only READ the SSD, so this can never change anything on it.

const cron = require('node-cron');
const { loadConfig, assertSafeLocations } = require('../config');
const { openDatabase, describeDatabaseError } = require('../db');
const { scanAndSave } = require('./scanAndSave');

const NIGHTLY_SCHEDULE = '0 2 * * *';

// One nightly scan. Settings are re-read every night, so edits to
// config.json apply without restarting the server.
async function runSavedScan() {
  const { config } = loadConfig();
  assertSafeLocations(config);
  const db = openDatabase();
  try {
    return await scanAndSave({ config, db });
  } finally {
    db.close();
  }
}

// Starts the nightly schedule and returns the node-cron task (the server can
// call task.stop() when it shuts down).
//   schedule – cron expression; defaults to 2:00 AM every day
//   run      – the work to do; defaults to a full scan + save (tests pass a fake)
//   log      – where messages go; defaults to the terminal
function scheduleNightlyScan({ schedule = NIGHTLY_SCHEDULE, run = runSavedScan, log = console } = {}) {
  async function nightlyScan() {
    try {
      const result = await run();
      log.info(
        `Nightly scan saved: ${result.projects.length} projects ` +
          `(${result.added} new, ${result.markedMissing} no longer found).`,
      );
    } catch (error) {
      // A failed night (SSD unplugged, bad config.json) must never crash the
      // server. The scan is recorded as failed; try again tomorrow.
      log.error(`Nightly scan failed: ${describeDatabaseError(error) ?? error.message}`);
    }
  }

  // noOverlap: if a scan is somehow still running when the next one is due,
  // skip the new one instead of running two at once.
  return cron.schedule(schedule, nightlyScan, { name: 'nightly-scan', noOverlap: true });
}

module.exports = { scheduleNightlyScan, runSavedScan, NIGHTLY_SCHEDULE };
