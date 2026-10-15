#!/usr/bin/env node
'use strict';

// The `npm run pin` command: pins a project as Keep, or unpins it.
//
//   npm run pin -- "NCHS Football / Week 1"   pin it (or unpin it, if it's pinned)
//   npm run pin                               list what's pinned
//
// A pinned project is always Keep, however old or finished it is. Your pins
// are saved in the database (data/dashboard.db), because the app only ever
// writes inside data/; it never edits config.json. Pins you put in
// config.json (folders.keepPinned) work too.
// Nothing on the SSD changes.

const { parseArgs } = require('node:util');
const { loadConfig, assertSafeLocations, ConfigError } = require('../config');
const { isPinnedByConfig } = require('../scanner/scan');
const { openDatabase, latestScan, listProjects, togglePin, describeDatabaseError } = require('../db');

const HELP = `Usage: npm run pin -- "<project name>"

Pins a project as Keep, so it's never marked Ready to offload. If it's
already pinned, unpins it. Use the name the report shows, in quotes, e.g.
  npm run pin -- "NCHS Football / Week 1"

With no name, lists the pinned projects.
Only the database (data/dashboard.db) changes, never anything on the SSD.`;

function listPins(db, config) {
  const pinned = listProjects(db)
    .filter((p) => p.kind === 'project')
    .map((p) => ({ ...p, pinnedInConfig: isPinnedByConfig(p.relPath, config.folders.keepPinned) }))
    .filter((p) => p.pinnedInDatabase || p.pinnedInConfig);
  if (pinned.length === 0) {
    console.log('Nothing is pinned yet.');
  } else {
    console.log('Pinned as Keep:');
    for (const p of pinned) {
      const sources = [p.pinnedInDatabase && 'npm run pin', p.pinnedInConfig && 'config.json'].filter(Boolean).join(' + ');
      console.log(`  • ${p.name}  (${sources})${p.missing ? '  — not on the SSD in the last scan' : ''}`);
    }
  }
  console.log(`\n${HELP}`);
}

function describeBucket(project) {
  const { scoring } = project;
  if (!scoring) return '';
  // When a pin changed the bucket, the note says what it would have been.
  return scoring.notes.length > 0 ? `  ${scoring.notes.join(' ')}` : `  Bucket: ${scoring.bucket} (score ${scoring.score.toFixed(1)}).`;
}

function explain(outcome, typedName) {
  const { result, project } = outcome;
  const name = project ? `"${project.name}"` : `"${typedName}"`;
  const lines = [];
  if (result === 'not-found') {
    lines.push(`No project called ${name} in the database.`);
    if (outcome.suggestions.length > 0) {
      lines.push('Did you mean:', ...outcome.suggestions.map((s) => `  npm run pin -- "${s}"`));
    }
    lines.push('Names come from the last scan; `npm run report` lists them.');
    return { lines, failed: true };
  }
  if (result === 'shared') {
    lines.push(`${name} is a shared folder (folders.shared in config). Shared folders are never ranked, so there's nothing to pin.`);
    return { lines, failed: true };
  }
  if (result === 'pinned-in-config') {
    lines.push(
      project.missing
        ? `${name} is pinned in config.json (folders.keepPinned), so it's always Keep.`
        : `${name} is pinned in config.json (folders.keepPinned), so it's always Keep (the saved results now show that too).`,
      'The app never edits config.json. To unpin it, remove it from that list in config.json, then run `npm run scan`.',
    );
    if (project.missing) {
      lines.push(`Note: ${name} wasn't on the Working SSD in the last scan, so it has no current bucket.`);
    }
    return { lines, failed: false };
  }
  if (result === 'pinned') {
    lines.push(`Pinned ${name} as Keep.`, describeBucket(project), '  Run the same command again to unpin it.');
  } else if (outcome.stillPinnedByConfig) {
    lines.push(
      `Removed your pin from ${name}, but config.json also pins it (folders.keepPinned), so it stays Keep.`,
      'To unpin it completely, remove it from that list in config.json, then run `npm run scan`.',
    );
  } else {
    lines.push(`Unpinned ${name}.`, describeBucket(project));
  }
  if (project.missing) {
    lines.push(
      result === 'pinned'
        ? `Note: ${name} wasn't on the Working SSD in the last scan. The pin is saved and applies if it comes back.`
        : `Note: ${name} wasn't on the Working SSD in the last scan, so it has no current bucket.`,
    );
  }
  return { lines: lines.filter(Boolean), failed: false };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h', default: false } },
      allowPositionals: true,
    });
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  if (parsed.values.help) {
    console.log(HELP);
    return;
  }
  // Forgot the quotes? `npm run pin -- Soccer 8-24` arrives as two words.
  const typedName = parsed.positionals.join(' ').trim();

  const { config } = loadConfig();
  if (typedName === '') {
    const db = openDatabase({ readonly: true });
    try {
      listPins(db, config);
    } finally {
      db.close();
    }
    return;
  }

  // Pinning writes to the database, so run the same safety checks as a scan.
  assertSafeLocations(config);
  const db = openDatabase({ mustExist: true });
  try {
    if (!latestScan(db, 'finished')) {
      console.error('No finished scan saved yet. Run `npm run scan` first.');
      process.exitCode = 1;
      return;
    }
    const { lines, failed } = explain(togglePin(db, config, typedName), typedName);
    (failed ? console.error : console.log)(lines.join('\n'));
    if (failed) process.exitCode = 1;
  } finally {
    db.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  // Expected problems get a plain message; anything else is a bug.
  const plain = error instanceof ConfigError ? error.message : describeDatabaseError(error);
  console.error(plain ? `\n${plain}` : error);
  process.exitCode = 1;
}
