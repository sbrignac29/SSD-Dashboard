#!/usr/bin/env node
'use strict';

// The `npm run scan` command: loads settings, scans the working SSD
// (read-only), saves the results to the database (data/dashboard.db), scores
// each project, and prints them best candidates first, with drive space and
// the move plan.
//
//   npm run scan                         scan the SSD from config, and save
//   npm run scan:details                 same, with per-project details
//   npm run scan -- --root "/a/folder"   scan a different folder instead (not saved)
//
// (With npm, options for the script go after `--`.)

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadConfig, assertSafeLocations, assertAppNotInside, ConfigError } = require('../config');
const { scanDrive, folderKey, ScanError } = require('../scanner/scan');
const { allDriveSpace } = require('../scanner/space');
const { scoreProjects, byOffloadOrder } = require('../scoring/score');
const { planMoves } = require('../scoring/plan');
const { openDatabase, pinnedPathKeys, displayPath, describeDatabaseError, DEFAULT_DB_PATH } = require('../db');
const { scanAndSave } = require('../jobs/scanAndSave');
const { renderReport } = require('./format');

const HELP = `Usage: npm run scan [-- options]

Scans your working SSD (read-only — nothing on any drive is ever changed), saves the
results to data/dashboard.db, ranks its projects for moving to the Library HDD, and
shows how full each drive is.

Options:
  -d, --details       Also show size by type, newest file, and score math for each project
      --root <path>   Scan this folder instead of your working SSD ("drives.working" in config).
                      A preview: not saved to the database
  -h, --help          Show this help`;

function readOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      details: { type: 'boolean', short: 'd', default: false },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return values;
}

// npm runs scripts from the project folder, so a relative --root like
// "../Footage" should be measured from where YOU typed the command
// (npm saves that in INIT_CWD). "~" means your home folder.
function resolveUserPath(input) {
  const expanded = input === '~' || input.startsWith('~/') ? path.join(os.homedir(), input.slice(1)) : input;
  return path.resolve(process.env.INIT_CWD || process.cwd(), expanded);
}

// A one-line progress counter that rewrites itself ("\r" jumps back to the
// start of the line). Only shown when you're watching in a terminal.
function createProgressLine(stream) {
  if (!stream.isTTY) return { update() {}, clear() {} };
  let lastDrawn = 0;
  return {
    update({ name, filesScanned }) {
      const now = Date.now();
      if (now - lastDrawn < 100) return;
      lastDrawn = now;
      const line = `  ${filesScanned.toLocaleString('en-US')} files… ${name}`;
      stream.write(`\r\x1b[K${line.slice(0, (stream.columns || 80) - 1)}`);
    },
    clear() {
      stream.write('\r\x1b[K');
    },
  };
}

// A mistyped --root shouldn't trigger the "is the SSD plugged in?" message,
// which would point at the wrong setting.
async function assertRootExists(root) {
  try {
    await fsp.stat(root);
  } catch {
    throw new ScanError(
      `Can't find the folder "${root}" given with --root.\n` +
        'Check the spelling and use the full path, e.g. --root "/Volumes/BRIGSMEDIA/NCHS Football" ' +
        '(a relative path is measured from the folder you ran the command in).',
    );
  }
}

// The pins you've made with `npm run pin`, for --root scans (which read the
// database but never save to it). No database yet = no pins.
function readSavedPins() {
  if (!fs.existsSync(DEFAULT_DB_PATH)) return new Set();
  const db = openDatabase({ readonly: true });
  try {
    return pinnedPathKeys(db);
  } finally {
    db.close();
  }
}

// The saved scores belong to the scan's projects; put them together so the
// report has both the scan's details and the scores (which include your pins).
function withSavedScores(scanned, scored) {
  const byPath = new Map(scored.map((p) => [p.relPath, p]));
  return scanned.map((p) => {
    const saved = byPath.get(p.relPath);
    return {
      ...p,
      pinnedKeep: saved.pinnedKeep,
      pinnedInConfig: saved.pinnedInConfig,
      pinnedInDatabase: saved.pinnedInDatabase,
      scoring: saved.scoring,
    };
  });
}

async function main(argv) {
  let options;
  try {
    options = readOptions(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  const { config, source } = loadConfig();
  const root = options.root ? resolveUserPath(options.root) : config.drives.working;
  if (options.root) await assertRootExists(root);
  assertSafeLocations(config);
  assertAppNotInside(root, 'the folder being scanned');

  // Only full scans of the Working SSD are saved (a --root scan sees one
  // folder, or another drive, and saving it would mark everything else
  // missing). Open the database BEFORE the scan, so a database problem shows
  // up now, not after a long scan.
  const db = options.root ? null : openDatabase();
  const savedPins = options.root ? readSavedPins() : null;

  console.error(`Scanning ${root} (read-only)…`);
  const startedAt = Date.now();
  const progressLine = createProgressLine(process.stderr);
  let scan;
  let saved = null;
  let projects;
  try {
    if (db) {
      saved = await scanAndSave({ config, db, now: startedAt, onProgress: progressLine.update });
      scan = saved.scan;
      projects = withSavedScores(scan.projects, saved.projects);
    } else {
      scan = await scanDrive(config, { root, now: startedAt, onProgress: progressLine.update });
      // No Notion connection yet, so "Done" comes from exports alone.
      const withPins = scan.projects.map((p) => {
        const pinnedInDatabase = savedPins.has(folderKey(p.relPath));
        return { ...p, pinnedInConfig: p.pinnedKeep, pinnedInDatabase, pinnedKeep: p.pinnedKeep || pinnedInDatabase };
      });
      projects = scoreProjects(withPins, config, startedAt);
    }
  } finally {
    progressLine.clear();
    db?.close();
  }
  projects.sort(byOffloadOrder);

  // How full each drive is. The move plan only makes sense for a scan of the
  // whole working SSD (a partial scan would undercount the Ready projects).
  const spaces = await allDriveSpace(config);
  const plan = scan.scope === 'working' ? planMoves({ projects, spaces, libraryFull: config.libraryFull }) : null;

  process.stdout.write(
    renderReport({
      scan,
      projects,
      scored: true,
      weights: config.weights,
      configSource: source,
      elapsedMs: Date.now() - startedAt,
      details: options.details,
      saved,
      dbPath: displayPath(),
      color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
      // In a terminal, fit the window. Saved to a file, never cut names short.
      width: process.stdout.isTTY ? process.stdout.columns || 100 : Infinity,
      spaces,
      plan,
      libraryFull: config.libraryFull,
    }),
  );
}

main(process.argv.slice(2)).catch((error) => {
  // Expected problems (bad settings, SSD not plugged in, database busy or not
  // installed) get a plain message; anything else is a bug, so show the full details.
  const plain = error instanceof ConfigError || error instanceof ScanError ? error.message : describeDatabaseError(error);
  console.error(plain ? `\n${plain}` : error);
  process.exitCode = 1;
});
