#!/usr/bin/env node
'use strict';

// The `npm run report` command: prints the results saved by the last
// `npm run scan` (or Scan now), straight from the database. It doesn't
// scan anything, so it's instant and works even when the SSD isn't plugged in.
// The only thing it asks the drives is how full they are (read-only), for the
// move plan; unplugged drives show as "not connected".
//
// The database is opened read-only: this command can't change anything.

const { parseArgs } = require('node:util');
const { loadConfig, ConfigError } = require('../config');
const { allDriveSpace } = require('../scanner/space');
const { byOffloadOrder } = require('../scoring/score');
const { planMoves } = require('../scoring/plan');
const { openDatabase, latestScan, listProjects, displayPath, describeDatabaseError } = require('../db');
const { renderSavedReport } = require('./format');

const HELP = `Usage: npm run report

Prints the results saved by the last scan, without scanning again.
(Run \`npm run scan\` to refresh them.)`;

async function main(argv) {
  let options;
  try {
    ({ values: options } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h', default: false } } }));
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  const { config } = loadConfig();
  const db = openDatabase({ readonly: true });
  let saved;
  try {
    const lastScan = latestScan(db, 'finished');
    const lastAttempt = latestScan(db);
    if (!lastScan) {
      const why = lastAttempt ? `\nThe last attempt failed: ${lastAttempt.errors[0]}` : '';
      console.log(`No finished scan saved yet. Run \`npm run scan\` first.${why}`);
      return;
    }
    const all = listProjects(db);
    saved = { lastScan, lastAttempt, all };
  } finally {
    db.close();
  }

  const present = saved.all.filter((p) => !p.missing);
  const projects = present.filter((p) => p.kind === 'project').sort(byOffloadOrder);
  // Drive space is read now; the Ready projects come from the last scan.
  const spaces = await allDriveSpace(config);
  process.stdout.write(
    renderSavedReport({
      lastScan: saved.lastScan,
      lastAttempt: saved.lastAttempt,
      projects,
      shared: present.filter((p) => p.kind === 'shared').sort((a, b) => b.sizeBytes - a.sizeBytes),
      missing: saved.all.filter((p) => p.missing),
      dbPath: displayPath(),
      spaces,
      plan: planMoves({ projects, spaces, libraryFull: config.libraryFull }),
      libraryFull: config.libraryFull,
      color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
      width: process.stdout.isTTY ? process.stdout.columns || 100 : Infinity,
    }),
  );
}

main(process.argv.slice(2)).catch((error) => {
  // Expected problems get a plain message; anything else is a bug.
  const plain = error instanceof ConfigError ? error.message : describeDatabaseError(error);
  console.error(plain ? `\n${plain}` : error);
  process.exitCode = 1;
});
