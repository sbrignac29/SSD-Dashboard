#!/usr/bin/env node
'use strict';

// The `npm run report` command: prints the results saved by the last
// `npm run scan` (or nightly scan), straight from the database. It doesn't
// touch the SSD at all, so it works even when the SSD isn't plugged in.
//
// The database is opened read-only: this command can't change anything.

const { parseArgs } = require('node:util');
const { openDatabase, latestScan, listProjects, displayPath, describeDatabaseError } = require('../db');
const { byScoreThenSize } = require('../scoring/score');
const { renderSavedReport } = require('./format');

const HELP = `Usage: npm run report

Prints the results saved by the last scan, without scanning again.
(Run \`npm run scan\` to refresh them.)`;

function main(argv) {
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

  const db = openDatabase({ readonly: true });
  try {
    const lastScan = latestScan(db, 'finished');
    const lastAttempt = latestScan(db);
    if (!lastScan) {
      const why = lastAttempt ? `\nThe last attempt failed: ${lastAttempt.errors[0]}` : '';
      console.log(`No finished scan saved yet. Run \`npm run scan\` first.${why}`);
      return;
    }

    const all = listProjects(db);
    const present = all.filter((p) => !p.missing);
    process.stdout.write(
      renderSavedReport({
        lastScan,
        lastAttempt,
        projects: present.filter((p) => p.kind === 'project').sort(byScoreThenSize),
        shared: present.filter((p) => p.kind === 'shared').sort((a, b) => b.sizeBytes - a.sizeBytes),
        missing: all.filter((p) => p.missing),
        dbPath: displayPath(),
        color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
        width: process.stdout.isTTY ? process.stdout.columns || 100 : Infinity,
      }),
    );
  } finally {
    db.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  // Expected problems get a plain message; anything else is a bug.
  const plain = describeDatabaseError(error);
  console.error(plain ? `\n${plain}` : error);
  process.exitCode = 1;
}
