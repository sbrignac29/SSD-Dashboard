#!/usr/bin/env node
'use strict';

// The `npm run scan` command: loads settings, scans the SSD (read-only),
// scores each project, and prints them best offload candidates first.
//
//   npm run scan                         scan the SSD from config
//   npm run scan:details                 same, with per-project details
//   npm run scan -- --root "/a/folder"   scan a different folder instead
//
// (With npm, options for the script go after `--`.)

const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadConfig, assertSafeLocations, ConfigError } = require('../config');
const { scanDrive, ScanError } = require('../scanner/scan');
const { scoreProjects, byScoreThenSize } = require('../scoring/score');
const { renderReport } = require('./report');

const HELP = `Usage: npm run scan [-- options]

Scans your SSD (read-only — nothing on it is ever changed) and prints its projects.

Options:
  -d, --details       Also show size by type, newest file, and score math for each project
      --root <path>   Scan this folder instead of "ssdPath" from config
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
  const root = options.root ? resolveUserPath(options.root) : config.ssdPath;
  assertSafeLocations(config);
  assertSafeLocations({ ...config, ssdPath: root });

  console.error(`Scanning ${root} (read-only)…`);
  const startedAt = Date.now();
  const progressLine = createProgressLine(process.stderr);
  let scan;
  try {
    scan = await scanDrive(config, { root, now: startedAt, onProgress: progressLine.update });
  } finally {
    progressLine.clear();
  }

  // Phase 1 has no Notion connection yet, so every project's status is
  // unknown and "Done" comes from exports alone.
  const projects = scoreProjects(scan.projects, config, startedAt).sort(byScoreThenSize);

  process.stdout.write(
    renderReport({
      scan,
      projects,
      scored: true,
      weights: config.weights,
      configSource: source,
      elapsedMs: Date.now() - startedAt,
      details: options.details,
      color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
      // In a terminal, fit the window. Saved to a file, never cut names short.
      width: process.stdout.isTTY ? process.stdout.columns || 100 : Infinity,
    }),
  );
}

main(process.argv.slice(2)).catch((error) => {
  // Expected problems (bad settings, SSD not plugged in) get a plain message;
  // anything else is a bug, so show the full details.
  if (error instanceof ConfigError || error instanceof ScanError) {
    console.error(`\n${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
