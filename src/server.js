#!/usr/bin/env node
'use strict';

// The dashboard's web server: `npm start`, then open http://localhost:7744.
//
// A web server is a program that waits for requests from a browser and
// answers them. It uses Express, a small library that does the HTTP work for
// us. Each request has a METHOD (GET = "give me something", POST = "do
// something") and a PATH ("/api/projects"). A ROUTE pairs one method + path
// with the function that answers it:
//
//   GET  /api/drives             each drive: connected or not, used/free, last scanned
//   GET  /api/summary            the headline: space you could free on the SSD
//   GET  /api/projects           Working SSD (or Library) projects, sorted by score, with filters
//   GET  /api/projects/:id       one project: every scoring signal, its biggest subfolders
//   POST /api/projects/:id/pin   toggle its Keep pin
//   GET  /api/library            the Done HDD page: Library projects + the Archive move list
//   POST /api/scan               scan the connected drives now (answers at once; the scan keeps going)
//   GET  /api/scan               how far the scan is (the page asks twice a second)
//
// (":id" is a placeholder: /api/projects/12 runs the same route with id = 12.)
// Everything else is a file from public/: the pages, their JavaScript and CSS.
//
// How the page talks to the server: the browser loads public/index.html, its
// JavaScript calls fetch('/api/projects'), and the server answers with JSON —
// text JavaScript turns straight back into objects and lists. The page never
// touches the drives or the database itself; it can only ask the server.
//
// SAFETY (see CLAUDE.md): the server only READS the drives (scans, and statfs
// for free space) and only WRITES to data/ (the database: scans and pins).
// Starting it never scans anything; only the Scan now button does (or the
// nightly scan, if you turn it on in config.json: server.nightlyScan).

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ROOT_DIR, loadConfig, assertSafeLocations, ConfigError } = require('./config');
const { openDatabase, describeDatabaseError, togglePinById, displayPath } = require('./db');
const { allDriveSpace } = require('./scanner/space');
const { ScanError } = require('./scanner/scan');
const { scheduleNightlyScan } = require('./jobs/nightly');
const views = require('./web/views');
const { createScanRunner } = require('./web/scanRunner');

// Express is installed by `npm install`. If it's missing (e.g. right after
// pulling this update), say so plainly instead of crashing.
let express = null;
try {
  express = require('express');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
const NPM_INSTALL_ADVICE = "The dashboard's packages aren't installed yet. Run `npm install` in the app folder, then `npm start` again.";

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
// The two browser libraries, served from node_modules (installed by
// `npm install`), so the dashboard works offline and their versions are
// locked in package-lock.json.
const VENDOR_FILES = new Map([
  ['alpine.min.js', path.join(ROOT_DIR, 'node_modules', 'alpinejs', 'dist', 'cdn.min.js')],
  ['chart.umd.min.js', path.join(ROOT_DIR, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js')],
]);

// --- Two guards for a server on your own Mac ---------------------------------

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopback(host) {
  return LOCAL_NAMES.has(host) || host === '::1';
}

// 1. Only answer requests addressed to localhost. Other web pages you visit
//    can't then trick your browser into reading this dashboard (a trick called
//    "DNS rebinding"). Turned off when you open the dashboard to your phone
//    (server.host "0.0.0.0").
function onlyLocalhost(req, res, next) {
  const hostname = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (LOCAL_NAMES.has(hostname)) return next();
  res.status(403).type('text').send('This dashboard only answers at http://localhost.');
}

// 2. Buttons (POST requests) must send JSON. The dashboard's own page always
//    does; a form on another website can't, so it can't press Scan or Pin for you.
function postsMustBeJson(req, res, next) {
  if (req.method !== 'POST') return next();
  if (String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return next();
  res.status(415).json({ error: 'Requests that change something must send JSON (Content-Type: application/json).' });
}

// --- The app -----------------------------------------------------------------

// "12" -> 12; anything else (abc, 1.5, -3) -> a 404 answer.
function readId(text) {
  if (!/^\d+$/.test(text)) throw new views.RequestError(404, "There's no project with that id.");
  return Number(text);
}

// Builds the Express app (without starting it, so tests can run it on any port).
//   db         – the open database
//   runner     – the scan runner (web/scanRunner.js)
//   getConfig  – returns the current settings; re-read for every request, so
//                edits to config.json show up without restarting
//   getSpaces  – how full each drive is (tests pass fake numbers)
//   localOnly  – turn the localhost guard on (off for phone access)
function createApp({ db, runner, getConfig = () => loadConfig().config, getSpaces = allDriveSpace, localOnly = true }) {
  if (!express) throw new ConfigError(NPM_INSTALL_ADVICE);
  const app = express();
  app.disable('x-powered-by');
  if (localOnly) app.use(onlyLocalhost);
  app.use(postsMustBeJson);
  // API answers are always fresh: tell the browser not to keep old copies.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/drives', async (req, res) => {
    const config = getConfig();
    res.json(views.drivesView({ db, config, spaces: await getSpaces(config) }));
  });

  app.get('/api/summary', async (req, res) => {
    const config = getConfig();
    res.json(views.summaryView({ db, config, spaces: await getSpaces(config) }));
  });

  app.get('/api/projects', (req, res) => {
    res.json(views.projectsView({ db, config: getConfig(), query: req.query }));
  });

  app.get('/api/projects/:id', (req, res) => {
    res.json(views.projectDetailView({ db, config: getConfig(), id: readId(req.params.id) }));
  });

  app.post('/api/projects/:id/pin', (req, res) => {
    const config = getConfig();
    // SAFETY: a pin writes to the database, so run the same checks as `npm run pin`.
    assertSafeLocations(config);
    const answer = views.pinResultView(togglePinById(db, config, readId(req.params.id)));
    res.status(answer.result === 'not-found' ? 404 : 200).json(answer);
  });

  app.get('/api/library', async (req, res) => {
    const config = getConfig();
    res.json(views.libraryView({ db, config, spaces: await getSpaces(config) }));
  });

  app.get('/api/scan', (req, res) => {
    res.json(runner.status());
  });

  app.post('/api/scan', async (req, res) => {
    const outcome = await runner.start({ trigger: 'button' });
    // 202 = "accepted: working on it". When it can't start (already scanning,
    // or no drive plugged in) that's not an error: a normal 200 answer whose
    // `started: false` and message say why, which the page shows calmly.
    res.status(outcome.started ? 202 : 200).json({ ...outcome.status, started: outcome.started, reason: outcome.reason ?? null });
  });

  app.get('/vendor/:file', (req, res, next) => {
    const file = VENDOR_FILES.get(req.params.file);
    if (!file) return next();
    res.sendFile(file);
  });

  app.use(express.static(PUBLIC_DIR));

  // An /api/ address that matched no route above.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `There's no ${req.method} ${req.originalUrl} here.` });
  });

  // When a route throws, Express skips to this "error handler" (it takes
  // four arguments; that's how Express tells it apart).
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof views.RequestError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    const plain = error instanceof ConfigError || error instanceof ScanError ? error.message : describeDatabaseError(error);
    if (!plain) console.error(error);
    res.status(500).json({ error: plain ?? 'Something went wrong. The Terminal window running `npm start` has the details.' });
  });

  return app;
}

// --- Starting and stopping ---------------------------------------------------

// The nightly job's work, done through the runner so it shows on the page as
// it happens and can't overlap with a Scan now press.
function nightlyScanThrough(runner) {
  return async () => {
    const outcome = await runner.start({ trigger: 'nightly' });
    if (!outcome.started) {
      throw new Error(
        outcome.reason === 'already-running' ? 'a scan was already running' : 'the Working SSD and Library HDD are both unplugged',
      );
    }
    const final = await outcome.done;
    const working = final.steps.find((s) => s.drive === 'working');
    if (working?.state !== 'saved') throw new Error(`Working SSD ${working ? working.message : 'is not set up'}`);
    return runner.lastResult('working');
  };
}

function main() {
  // Without these the page would load blank, so check before starting.
  if (!express || [...VENDOR_FILES.values()].some((file) => !fs.existsSync(file))) throw new ConfigError(NPM_INSTALL_ADVICE);
  const { config, source } = loadConfig();
  // SAFETY: refuse to start if the app or its data/ folder is on a media drive.
  assertSafeLocations(config);
  // Opens (or creates) data/dashboard.db and upgrades its layout if needed.
  // This is not a scan: nothing on any drive is read yet.
  const db = openDatabase();
  const runner = createScanRunner({ db, getConfig: () => loadConfig().config });
  const { port, host, nightlyScan } = config.server;
  const app = createApp({ db, runner, localOnly: isLoopback(host) });
  const server = http.createServer(app);

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `\nPort ${port} is already in use — is the dashboard already running in another Terminal window?\n` +
          'Close that one (Ctrl+C), or set a different "server.port" in config.json.',
      );
    } else {
      console.error(`\nThe server couldn't start: ${error.message}`);
    }
    db.close();
    process.exitCode = 1;
  });

  let nightlyTask = null;
  server.listen(port, host, () => {
    // Built in Phase 2; started only if you turned it on.
    if (nightlyScan) nightlyTask = scheduleNightlyScan({ run: nightlyScanThrough(runner) });
    const url = `http://localhost:${port}`;
    console.log('SSD Offload Dashboard is running.');
    console.log(`  Open ${url} in your browser.`);
    if (!isLoopback(host)) {
      console.log(`  On your phone (same Wi-Fi): http://<this Mac's name>.local:${port}`);
    }
    console.log('  Nothing is scanned until you press "Scan now".');
    console.log(
      nightlyScan
        ? '  Nightly scan: on, at 2:00 AM while this Terminal window keeps running (server.nightlyScan in config.json).'
        : '  Nightly scan: off (turn on with "nightlyScan": true under "server" in config.json).',
    );
    console.log(`  Settings: ${source} · Database: ${displayPath()}`);
    console.log('  Press Ctrl+C to stop.');
  });

  // Ctrl+C sends SIGINT. Stop the schedule, stop answering, close the
  // database, and exit. (A scan in progress just stops: it only reads, and
  // its results are saved in one transaction, so nothing is half-saved.)
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping the dashboard…');
    nightlyTask?.stop();
    server.close();
    server.closeAllConnections();
    db.close();
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    // Expected problems (bad settings, app on a media drive, database
    // library missing) get a plain message; anything else is a bug.
    const plain = error instanceof ConfigError ? error.message : describeDatabaseError(error);
    console.error(plain ? `\n${plain}` : error);
    process.exitCode = 1;
  }
}

module.exports = { createApp, isLoopback, nightlyScanThrough };
