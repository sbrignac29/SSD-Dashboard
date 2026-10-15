'use strict';

// Runs the dashboard's scans: one at a time, in the background, keeping a
// progress report the page can ask for.
//
// How the page and the server share a scan:
//   1. The Scan now button sends POST /api/scan. The server checks which
//      drives are plugged in, starts scanning, and answers straight away
//      ("started") — a scan can take minutes, far longer than a browser waits
//      for one answer.
//   2. While it runs, the page asks GET /api/scan twice a second. Each answer
//      is status(): which drive, how many files so far, and a percentage.
//   3. When status() says it's finished, the page reloads its numbers.
//
// Scan now reads the Working SSD (saved and scored) and the Library HDD
// (saved for the Done HDD page), whichever are connected, then refreshes the
// Notion statuses (if there's a Notion token in config.json). The nightly scan
// doesn't touch Notion: Notion is only read when you press a button. Unplugged drives
// are skipped, not reported as errors. The Archive is never read: nothing
// needs its folders yet, and walking 28 TB would make every scan slow.
//
// Scans only READ the drives (src/scanner/scan.js). The only writing is to the
// database in data/ (src/db.js), through scanAndSave.

const fsp = require('node:fs/promises');
const { DRIVE_LABELS, assertSafeLocations, notionSettings, ConfigError } = require('../config');
const { latestScan, describeDatabaseError, SAVED_DRIVES } = require('../db');
const { ScanError } = require('../scanner/scan');
const { scanAndSave: realScanAndSave } = require('../jobs/scanAndSave');

// True if the drive's folder is there (plugged in). stat only reads.
async function folderExists(folder) {
  try {
    return (await fsp.stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

function plural(n, word) {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

// Expected problems (drive unplugged mid-scan, database busy, bad settings)
// get their plain message; anything else is a bug, described generally (the
// details go to the Terminal).
function friendlyMessage(error) {
  if (error instanceof ScanError || error instanceof ConfigError) return error.message;
  return describeDatabaseError(error) ?? `Something went wrong: ${error.message}. The Terminal window has the details.`;
}

// How far one drive's scan is, from 0 to 1. Uses the file count of that
// drive's last scan as the expected total when there is one (smooth, and
// usually close), otherwise how many of its top-level folders are done.
function stepFraction(step) {
  if (step.state === 'saved' || step.state === 'failed') return 1;
  if (step.state !== 'scanning') return 0;
  if (step.expectedFiles > 0) return Math.min(0.99, step.filesScanned / step.expectedFiles);
  if (step.foldersTotal > 0) return Math.min(0.99, step.foldersDone / step.foldersTotal);
  return 0;
}

// The whole run's percentage: drives weighted by their expected file counts
// (when every drive has one), so a big drive counts for more.
function overallPercent(steps) {
  const active = steps.filter((s) => s.state !== 'skipped');
  if (active.length === 0) return 0;
  const weighted = active.every((s) => s.expectedFiles > 0);
  const weightOf = (s) => (weighted ? s.expectedFiles : 1);
  const total = active.reduce((sum, s) => sum + weightOf(s), 0);
  const done = active.reduce((sum, s) => sum + weightOf(s) * stepFraction(s), 0);
  return Math.round((done / total) * 1000) / 10;
}

//   db            – the open database (shared with the rest of the server)
//   getConfig     – returns the current settings (re-read for every scan)
//   scanAndSave   – the scan + save step (tests pass a slow or failing fake)
//   notion        – the Notion syncer (notion/sync.js), or null for none
//   log           – where unexpected errors go
function createScanRunner({ db, getConfig, scanAndSave = realScanAndSave, notion = null, log = console }) {
  let state = {
    running: false,
    trigger: null,
    startedAt: null,
    finishedAt: null,
    outcome: null,
    error: null,
    steps: [],
    notion: null,
  };
  // The last full result per drive (used by the nightly job's log message).
  const results = new Map();

  function message() {
    if (state.error) return state.error;
    if (state.running) {
      if (state.notion?.state === 'syncing') return 'Refreshing Notion statuses…';
      const step = state.steps.find((s) => s.state === 'scanning');
      if (!step) return 'Starting…';
      const where = step.current ? ` · ${step.current}` : '';
      return `Scanning ${step.label} · ${plural(step.filesScanned, 'file')}${where}`;
    }
    if (state.outcome === 'nothing-connected') {
      return 'Nothing to scan: plug in the Working SSD or the Library HDD, then press Scan now.';
    }
    const parts = state.steps.map((s) => `${s.label}: ${s.message}`);
    if (state.notion) parts.push(state.notion.message);
    return parts.join(' · ');
  }

  // A copy of the progress for GET /api/scan (a copy, so nothing outside can change it).
  function status() {
    return {
      running: state.running,
      trigger: state.trigger,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      outcome: state.outcome, // null while running; then 'saved' | 'partly' | 'failed' | 'nothing-connected'
      // (While Notion is read, the drives are done: hold at 99%.)
      percent: state.running ? Math.min(99, overallPercent(state.steps)) : state.outcome ? 100 : 0,
      message: message(),
      steps: state.steps.map(({ drive, label, state: stepState, message: stepMessage, filesScanned, current, summary }) => ({
        drive,
        label,
        state: stepState, // waiting | scanning | saved | failed | skipped
        message: stepMessage,
        filesScanned,
        current,
        summary,
      })),
      // Notion, after the drives: { state: syncing | synced | failed | skipped, message }
      notion: state.notion ? { ...state.notion } : null,
    };
  }

  function finish(outcome) {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.outcome = outcome;
  }

  async function scanStep(step, config) {
    step.state = 'scanning';
    step.message = 'Scanning…';
    try {
      const result = await scanAndSave({
        config,
        db,
        drive: step.drive,
        now: Date.now(),
        onProgress: (update) => {
          step.filesScanned = update.filesScanned;
          step.current = update.name ?? null;
          if (update.foldersTotal !== undefined) {
            step.foldersDone = update.foldersDone;
            step.foldersTotal = update.foldersTotal;
          }
        },
      });
      results.set(step.drive, result);
      step.state = 'saved';
      step.summary = {
        projects: result.scan.projects.length,
        shared: result.scan.shared.length,
        files: result.scan.filesScanned,
        added: result.added,
        returned: result.returned,
        markedMissing: result.markedMissing,
      };
      step.message = `saved ${plural(result.scan.projects.length, 'project')}`;
    } catch (error) {
      step.state = 'failed';
      step.message = friendlyMessage(error);
      const expected = error instanceof ScanError || error instanceof ConfigError || describeDatabaseError(error);
      if (!expected) log.error(error);
    } finally {
      step.current = null;
    }
  }

  // Scan now also refreshes Notion; the nightly scan never does.
  async function notionStep(config) {
    if (!notion) return;
    if (state.trigger === 'nightly') {
      state.notion = { state: 'skipped', message: 'Notion: not read by the nightly scan (only by Scan now or Refresh Notion)' };
      return;
    }
    if (!notionSettings(config).configured) {
      state.notion = { state: 'skipped', message: 'Notion: not connected (no token in config.json)' };
      return;
    }
    state.notion = { state: 'syncing', message: 'Refreshing Notion…' };
    try {
      const outcome = await notion.sync({ triggeredBy: 'scan' });
      state.notion = { state: outcome.ok ? 'synced' : 'failed', message: outcome.ok ? `Notion: ${outcome.message}` : outcome.message };
    } catch (error) {
      // Bad settings (ConfigError); the drives were scanned all the same.
      state.notion = { state: 'failed', message: `Notion: ${friendlyMessage(error)}` };
    }
  }

  async function runSteps(config) {
    for (const step of state.steps) {
      if (step.state === 'waiting') await scanStep(step, config);
    }
    await notionStep(config);
    const states = state.steps.map((s) => s.state);
    if (!states.includes('failed')) finish('saved');
    else finish(states.includes('saved') ? 'partly' : 'failed');
    return status();
  }

  // Starts a scan of every connected drive, unless one is already running.
  // Returns { started: true, status, done } (done: a promise of the final
  // status), or { started: false, reason: 'already-running' | 'nothing-connected', status }.
  // Throws a ConfigError if the settings are broken or unsafe.
  async function start({ trigger = 'button' } = {}) {
    if (state.running) return { started: false, reason: 'already-running', status: status() };
    // Claim "running" before anything that waits, so two quick presses can't both start a scan.
    state = {
      running: true,
      trigger,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: null,
      error: null,
      steps: [],
      notion: null,
    };
    let config;
    try {
      config = getConfig();
      // SAFETY: the same checks as `npm run scan` before anything is written.
      assertSafeLocations(config);
      for (const drive of SAVED_DRIVES) {
        const folder = config.drives[drive];
        if (typeof folder !== 'string' || folder.trim() === '') continue;
        const connected = await folderExists(folder);
        state.steps.push({
          drive,
          label: DRIVE_LABELS[drive],
          state: connected ? 'waiting' : 'skipped',
          message: connected ? 'waiting' : 'not connected (skipped)',
          filesScanned: 0,
          foldersDone: 0,
          foldersTotal: 0,
          current: null,
          expectedFiles: latestScan(db, 'finished', { drive })?.fileCount ?? null,
          summary: null,
        });
      }
    } catch (error) {
      state.error = friendlyMessage(error);
      finish('failed');
      throw error;
    }
    if (!state.steps.some((s) => s.state === 'waiting')) {
      finish('nothing-connected');
      return { started: false, reason: 'nothing-connected', status: status() };
    }
    const done = runSteps(config);
    return { started: true, status: status(), done };
  }

  return {
    start,
    status,
    lastResult: (drive) => results.get(drive),
  };
}

module.exports = { createScanRunner, overallPercent };
