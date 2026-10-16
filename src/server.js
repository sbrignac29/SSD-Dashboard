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
//   GET  /api/notion             "Notion: connected / not connected", last sync, link counts
//   POST /api/notion/sync        the Refresh Notion button: read the Projects board now
//   GET  /api/notion/links       the Link to Notion page: folders + suggested Notion pages
//   POST /api/notion/links       Confirm / No Notion page / undo, for one or more folders
//   GET  /api/settings           the Settings page: every setting, and where its value comes from
//   POST /api/settings           save changed settings (in data/dashboard.db, never config.json)
//   POST /api/settings/reset     forget the Settings page's changes: use config.json again
//   GET  /api/vericopy           is VeriCopy open? (asks its /api/health)
//   GET  /api/projects/:id/move  the move preview + pre-checks (read-only; nothing starts)
//   POST /api/projects/:id/move  Start: ask VeriCopy to copy it (only after your click)
//   GET  /api/moves              the Recent jobs list (?projectId= for one project)
//   GET  /api/moves/:id          one move, with live progress
//   POST /api/moves/:id/cancel   ask VeriCopy to cancel it
//   POST /api/moves/:id/recheck  run the spot check again (after it failed)
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
// for free space) and only WRITES to data/ (the database: scans, pins, Notion
// links and the Settings page's changes). It only READS Notion
// (src/notion/sync.js), and only when you press Refresh Notion or Scan now.
// Starting it never scans or syncs anything; only the Scan now button does.
// Moves (Phase 5): the server asks VeriCopy (src/offload/) to COPY a project,
// only after you press Start; VeriCopy does the copying, the dashboard writes
// nothing on any drive and deletes nothing. When it starts, it resumes
// following any move that was still running (polling VeriCopy every 2 s).

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ROOT_DIR, loadConfig, assertSafeLocations, notionSettings, ConfigError } = require('./config');
const { createSettingsStore, loadAppConfig, SettingsError } = require('./settings');
const { openDatabase, describeDatabaseError, togglePinById, setNotionLinks, displayPath, getMove } = require('./db');
const { allDriveSpace } = require('./scanner/space');
const { ScanError } = require('./scanner/scan');
const views = require('./web/views');
const { createScanRunner } = require('./web/scanRunner');
const { createNotionSyncer } = require('./notion/sync');
const { createMover } = require('./offload/moves');
const { createVericopyClient, VericopyError } = require('./offload/vericopy');

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

// 3. With phone access on (server.host "0.0.0.0"), other devices on your Wi-Fi
//    can open the dashboard, but only this Mac can change its settings
//    (a request from this Mac comes from a "loopback" address like 127.0.0.1).
function fromThisMac(req) {
  const address = String(req.socket.remoteAddress ?? '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// --- The app -----------------------------------------------------------------

// "12" -> 12; anything else (abc, 1.5, -3) -> a 404 answer.
function readId(text) {
  if (!/^\d+$/.test(text)) throw new views.RequestError(404, "There's no project with that id.");
  return Number(text);
}

// The body of POST /api/notion/links: { projectIds: [12], action, pageId? }.
function readLinkRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new views.RequestError(400, 'Send { "projectIds": [...], "action": "confirm" | "none" | "clear", "pageId": "..." }.');
  }
  const { projectIds, action, pageId } = body;
  if (!Array.isArray(projectIds) || projectIds.length > 1000) {
    throw new views.RequestError(400, '"projectIds" must be a list of project ids.');
  }
  return { projectIds, action, pageId: pageId ?? null };
}

// Builds the Express app (without starting it, so tests can run it on any port).
//   db         – the open database
//   runner     – the scan runner (web/scanRunner.js)
//   settings   – the Settings page's store (settings.js → createSettingsStore)
//   getConfig  – returns the current settings (config.json + the Settings
//                page); re-read for every request, so edits to config.json
//                show up without restarting
//   notion     – the Notion syncer (notion/sync.js); one is made if not given
//   getSpaces  – how full each drive is (tests pass fake numbers)
//   mover      – moves through VeriCopy (offload/moves.js); one is made if not given
//   localOnly  – turn the localhost guard on (off for phone access)
function createApp({
  db,
  runner,
  settings = createSettingsStore({ db }),
  getConfig = () => settings.current(),
  notion,
  getSpaces = allDriveSpace,
  mover,
  localOnly = true,
}) {
  if (!express) throw new ConfigError(NPM_INSTALL_ADVICE);
  const syncer = notion ?? createNotionSyncer({ db, getConfig });
  const moves = mover ?? createMover({ db, getConfig, getSpaces, isScanning: () => runner.status().running });
  const app = express();
  app.disable('x-powered-by');
  if (localOnly) app.use(onlyLocalhost);
  app.use(postsMustBeJson);
  // Turns the JSON a POST sends into req.body (the Settings page's values,
  // the Link buttons' choices).
  app.use(express.json({ limit: '200kb' }));
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

  app.get('/api/notion', (req, res) => {
    res.json(views.notionView({ db, config: getConfig(), syncing: syncer.isRunning() }));
  });

  app.post('/api/notion/sync', async (req, res) => {
    // Waits for the sync (a few seconds at most). Notion problems aren't
    // errors here: `ok: false` and the message say what's wrong, and the
    // dashboard keeps using the last synced statuses.
    const outcome = await syncer.sync({ triggeredBy: 'button' });
    res.json({ ...outcome, notion: views.notionView({ db, config: getConfig(), syncing: syncer.isRunning() }) });
  });

  app.get('/api/notion/links', (req, res) => {
    res.json(views.notionLinksView({ db, config: getConfig(), query: req.query, syncing: syncer.isRunning() }));
  });

  app.post('/api/notion/links', (req, res) => {
    const config = getConfig();
    // SAFETY: saving a link writes to the database, so the same checks as a pin.
    assertSafeLocations(config);
    const request = readLinkRequest(req.body);
    const outcome = setNotionLinks(db, config, request);
    const answer = views.notionLinkResultView(outcome, { action: request.action, count: new Set(request.projectIds).size });
    const status = { ok: 200, 'not-found': 404, 'unknown-page': 409 }[outcome.result] ?? 400;
    res.status(status).json(answer);
  });

  app.get('/api/settings', (req, res) => {
    res.json({ ...settings.view(), canEdit: localOnly || fromThisMac(req) });
  });

  // Saving settings writes to the database, so only from this Mac (see
  // fromThisMac); settings.js runs the same safety checks as a scan first.
  function settingsChange(change) {
    return (req, res) => {
      if (!localOnly && !fromThisMac(req)) {
        res.status(403).json({ error: 'Settings can only be changed on the Mac running the dashboard.' });
        return;
      }
      // A running scan uses the settings it started with, and re-scores with
      // them when it saves, which would quietly undo a change made meanwhile.
      if (runner.status().running) {
        res.status(409).json({ error: 'A scan is running. Save your settings once it has finished (your changes are still on the page).' });
        return;
      }
      const outcome = change(req);
      res.json({ changed: outcome.changed, needsScan: outcome.needsScan, settings: { ...settings.view(), canEdit: true } });
    };
  }
  app.post('/api/settings', settingsChange((req) => settings.save(req.body?.values)));
  app.post('/api/settings/reset', settingsChange(() => settings.reset()));

  // --- Moves (Phase 5) ---

  // Moves change things, so with phone access on (server.host 0.0.0.0) only
  // this Mac can start or cancel one; other devices can watch.
  function refuseFromOtherDevices(req, res) {
    if (localOnly || fromThisMac(req)) return false;
    res.status(403).json({ error: 'Moves can only be started or cancelled on the Mac running the dashboard.' });
    return true;
  }

  app.get('/api/vericopy', async (req, res) => {
    const client = createVericopyClient({ url: getConfig().vericopy.url });
    try {
      const health = await client.health();
      res.json({ url: client.url, running: health.ok, version: health.version, busy: health.queueActive, message: null });
    } catch (error) {
      if (!(error instanceof VericopyError)) throw error;
      res.json({
        url: client.url,
        running: false,
        version: null,
        busy: false,
        message: `VeriCopy isn't open: nothing answered at ${client.url}. Open VeriCopy to move projects.`,
      });
    }
  });

  app.get('/api/projects/:id/move', async (req, res) => {
    const answer = await moves.preview(readId(req.params.id));
    if (!answer.found) throw new views.RequestError(404, "There's no project with that id.");
    res.json({ ...answer, canEdit: localOnly || fromThisMac(req) });
  });

  app.post('/api/projects/:id/move', async (req, res) => {
    if (refuseFromOtherDevices(req, res)) return;
    // The click itself: the page sends { confirm: true }. Nothing starts without it.
    if (req.body?.confirm !== true) {
      throw new views.RequestError(400, 'Send { "confirm": true } to start a move (the Start button does).');
    }
    const outcome = await moves.start(readId(req.params.id));
    const move = outcome.move ? views.moveView(outcome.move) : null;
    if (outcome.started) {
      res.status(202).json({ started: true, message: 'VeriCopy accepted the copy.', move });
      return;
    }
    // Not started: a pre-check failed, VeriCopy said no, or a scan is running.
    // 409 = "conflict": the request was fine, but things aren't ready for it.
    res.status(outcome.reason === 'not-found' ? 404 : 409).json({
      started: false,
      reason: outcome.reason,
      code: outcome.code ?? null,
      error: outcome.message,
      preview: outcome.preview ?? null,
      move,
    });
  });

  app.get('/api/moves', (req, res) => {
    const projectId = req.query.projectId === undefined ? null : readId(String(req.query.projectId));
    res.json(views.movesView({ db, status: moves.status(), projectId }));
  });

  app.get('/api/moves/:id', (req, res) => {
    const move = getMove(db, readId(req.params.id));
    if (!move) throw new views.RequestError(404, "There's no move with that id.");
    res.json({ move: views.moveView(move), vericopy: moves.status().vericopy });
  });

  function moveAction(action) {
    return async (req, res) => {
      if (refuseFromOtherDevices(req, res)) return;
      const outcome = await action(readId(req.params.id));
      const status = outcome.ok ? 200 : outcome.reason === 'not-found' ? 404 : 409;
      res.status(status).json({
        ok: outcome.ok,
        reason: outcome.reason ?? null,
        message: outcome.message,
        error: outcome.ok ? undefined : outcome.message,
        move: outcome.move ? views.moveView(outcome.move) : null,
      });
    };
  }
  app.post('/api/moves/:id/cancel', moveAction((id) => moves.cancel(id)));
  app.post('/api/moves/:id/recheck', moveAction((id) => moves.recheck(id)));

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
    if (error instanceof SettingsError) {
      res.status(400).json({ error: error.message });
      return;
    }
    // express.json() couldn't read the request (not JSON, or far too big).
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      res.status(error.status).json({ error: "The request couldn't be read as JSON." });
      return;
    }
    const plain = error instanceof ConfigError || error instanceof ScanError ? error.message : describeDatabaseError(error);
    if (!plain) console.error(error);
    res.status(500).json({ error: plain ?? 'Something went wrong. The Terminal window running `npm start` has the details.' });
  });

  return app;
}

// --- Starting and stopping ---------------------------------------------------

function main() {
  // Without these the page would load blank, so check before starting.
  if (!express || [...VENDOR_FILES.values()].some((file) => !fs.existsSync(file))) throw new ConfigError(NPM_INSTALL_ADVICE);
  // SAFETY: refuse to start if the app or its data/ folder is on a media drive.
  assertSafeLocations(loadConfig().config);
  // Opens (or creates) data/dashboard.db and upgrades its layout if needed.
  // This is not a scan: nothing on any drive is read yet.
  const db = openDatabase();
  // The settings: config.json plus any changes made on the Settings page
  // (saved in the database), checked again now that both are known.
  const settings = createSettingsStore({ db });
  let config;
  let source;
  try {
    ({ config, source } = loadAppConfig({ db }));
    assertSafeLocations(config);
  } catch (error) {
    db.close();
    throw error;
  }
  const getConfig = () => settings.current();
  // Reads Notion only when asked (Refresh Notion, or Scan now).
  const notion = createNotionSyncer({ db, getConfig });
  const runner = createScanRunner({ db, getConfig, notion });
  // Moves: follows any move that was still running when the dashboard last
  // stopped (asks VeriCopy every 2 s while one runs; nothing else).
  const mover = createMover({ db, getConfig, isScanning: () => runner.status().running });
  // Port and host only come from config.json (the Settings page shows them, read-only).
  const { port, host } = config.server;
  const app = createApp({ db, runner, settings, notion, mover, localOnly: isLoopback(host) });
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

  server.listen(port, host, () => {
    const url = `http://localhost:${port}`;
    console.log('SSD Offload Dashboard is running.');
    console.log(`  Open ${url} in your browser.`);
    if (!isLoopback(host)) {
      console.log(`  On your phone (same Wi-Fi): http://<this Mac's name>.local:${port}`);
    }
    console.log('  Nothing is scanned until you press "Scan now".');
    console.log(
      notionSettings(config).configured
        ? '  Notion: read when you press "Refresh Notion" or "Scan now" (never on its own).'
        : '  Notion: not connected (no notion.token in config.json yet; see the README).',
    );
    console.log(`  Moves: through VeriCopy at ${config.vericopy.url} (copies only; nothing is deleted).`);
    console.log(`  Settings: ${source} · Database: ${displayPath()}`);
    mover.startPolling();
    console.log('  Press Ctrl+C to stop.');
  });

  // Ctrl+C sends SIGINT. Stop answering, close the
  // database, and exit. (A scan in progress just stops: it only reads, and
  // its results are saved in one transaction, so nothing is half-saved.)
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping the dashboard…');
    mover.stopPolling();
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

module.exports = { createApp, isLoopback };
