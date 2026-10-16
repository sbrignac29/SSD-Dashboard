'use strict';

// Tests for the Settings page (src/settings.js and its routes in
// src/server.js).
//
// Like the other tests, the fake Working SSD and the test databases live in
// data/.test-settings-* and are deleted afterwards. "config.json" is faked
// (loadFileConfig), so these tests never read or depend on your real one,
// and they check that the real one is never written.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DATA_DIR, ROOT_DIR, withDefaults, isInside, ConfigError } = require('../src/config');
const { openDatabase, readSavedSettings, listProjects } = require('../src/db');
const { scanAndSave } = require('../src/jobs/scanAndSave');
const { createSettingsStore, loadAppConfig, SettingsError, FIELDS } = require('../src/settings');
const { createApp } = require('../src/server');
const { createScanRunner } = require('../src/web/scanRunner');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let base;
let ssd;
let dbCount = 0;

function file(rel, size, ageDays) {
  const abs = path.join(ssd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(size));
  const time = new Date(NOW - ageDays * DAY);
  fs.utimesSync(abs, time, time);
}

// What a config.json would give: the defaults plus the test drive.
function fileSettings(extra = {}) {
  return withDefaults({
    drives: { working: ssd, library: '', archive: '' },
    folders: { ignore: [], shared: ['Resolve Project Library'], containers: ['NCHS Football'], keepPinned: [] },
    ...extra,
  });
}

// A fresh test database with one saved scan, and a store whose "config.json"
// is whatever fileConfig() returns at the time (tests change it mid-way).
async function setup({ scan = true } = {}) {
  dbCount += 1;
  const db = openDatabase({ file: path.join(base, `settings-${dbCount}.db`) });
  const state = { file: fileSettings() };
  const loadFileConfig = () => ({ config: state.file, source: 'config.json' });
  if (scan) await scanAndSave({ config: state.file, db, now: NOW });
  const store = createSettingsStore({ db, loadFileConfig });
  return { db, state, store, loadFileConfig };
}

function bucketOf(db, name) {
  return listProjects(db).find((p) => p.name === name).scoring.bucket;
}

before(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  base = fs.mkdtempSync(path.join(DATA_DIR, '.test-settings-'));
  ssd = path.join(base, 'ssd');
  file('Old Finished/Footage/a.mov', 5000, 200); // Ready: finished, untouched 200 days
  file('Old Finished/Exports/Old FD.mp4', 1000, 200);
  file('Fresh Edit/b.mov', 1000, 2); // Keep
});

after(() => {
  if (base && isInside(base, DATA_DIR) && base !== DATA_DIR) fs.rmSync(base, { recursive: true, force: true });
});

describe('the settings store', () => {
  it('starts with nothing changed: the settings are config.json', async () => {
    const { db, store, state } = await setup({ scan: false });
    assert.deepEqual(store.current(), state.file);
    const view = store.view();
    assert.equal(view.changedCount, 0);
    assert.equal(view.savedAt, null);
    assert.equal(view.source, 'config.json');
    const recent = view.sections.flatMap((s) => s.fields).find((f) => f.key === 'ageDays.recent');
    assert.equal(recent.value, 14);
    assert.equal(recent.changedHere, false);
    db.close();
  });

  it('saves only what differs from config.json, and re-scores at once', async () => {
    const { db, store, state } = await setup();
    assert.equal(bucketOf(db, 'Old Finished'), 'Ready');

    const outcome = store.save({ 'ageDays.recent': 365, 'ageDays.max': 400 });
    assert.deepEqual(outcome.changed.sort(), ['ageDays.max', 'ageDays.recent']);
    assert.equal(outcome.needsScan, false, 'scoring settings need no scan');
    // Edited 200 days ago is now "recent", so it can't be Ready.
    assert.equal(bucketOf(db, 'Old Finished'), 'Review');

    assert.deepEqual(readSavedSettings(db).overrides, { ageDays: { recent: 365, max: 400 } });
    assert.equal(store.current().ageDays.recent, 365);
    assert.equal(store.current().weights.done, state.file.weights.done, 'untouched settings still follow config.json');
    db.close();
  });

  it('grouped settings are saved together, so a later config.json edit can\'t split them', async () => {
    const { db, store, state } = await setup({ scan: false });
    store.save({ 'weights.done': 0.5, 'weights.age': 0.3 });
    assert.deepEqual(readSavedSettings(db).overrides, { weights: { done: 0.5, age: 0.3, size: 0.2 } });
    // config.json changes its weights afterwards: the saved group still adds up to 1.
    state.file = fileSettings({ weights: { done: 0.4, age: 0.4, size: 0.2 } });
    assert.deepEqual(store.current().weights, { done: 0.5, age: 0.3, size: 0.2 });
    db.close();
  });

  it('a value set back to config.json\'s is no longer saved', async () => {
    const { db, store } = await setup({ scan: false });
    store.save({ 'buckets.review': 55 });
    assert.deepEqual(readSavedSettings(db).overrides, { 'buckets.review': 55 });
    store.save({ 'buckets.review': 40 });
    assert.deepEqual(readSavedSettings(db).overrides, {});
    assert.equal(store.view().changedCount, 0);
    db.close();
  });

  it('cleans up lists: trims, drops blank lines and repeats', async () => {
    const { db, store } = await setup({ scan: false });
    store.save({ 'folders.ignore': ['  Old Stuff ', '', 'Old Stuff', 'Temp'] });
    assert.deepEqual(store.current().folders.ignore, ['Old Stuff', 'Temp']);
    store.save({ 'folders.ignore': 'A\n\nB\n' });
    assert.deepEqual(store.current().folders.ignore, ['A', 'B']);
    db.close();
  });

  it('says folder and file-type changes need a scan', async () => {
    const { db, store } = await setup({ scan: false });
    assert.equal(store.save({ 'folders.containers': ['NCHS Football', 'Weddings'] }).needsScan, true);
    assert.equal(store.save({ 'fileTypes.finalExportWords': ['final', 'fd', 'master'] }).needsScan, true);
    db.close();
  });

  it('refuses bad values with the same checks as config.json, and saves nothing', async () => {
    const { db, store } = await setup({ scan: false });
    const refuses = (values, pattern) => {
      assert.throws(() => store.save(values), (error) => error instanceof SettingsError && pattern.test(error.message));
    };
    refuses({ 'weights.done': 0.9 }, /must add up to 1/);
    refuses({ 'ageDays.recent': 200 }, /ageDays.max/); // max (120) must stay bigger
    refuses({ 'libraryFull.targetPercent': 95 }, /targetPercent/);
    refuses({ 'drives.working': '' }, /drives.working/);
    refuses({ 'ageDays.recent': 'soon' }, /must be a number/);
    refuses({ 'server.nightlyScan': true }, /can't change "server.nightlyScan"/); // removed with the nightly scan
    refuses({ 'folders.ignore': [1, 2] }, /list of text/);
    refuses({ 'server.port': 8000 }, /can't change "server.port"/);
    refuses({ 'server.host': '0.0.0.0' }, /can't change "server.host"/);
    refuses({}, /Nothing to save/);
    refuses(null, /Nothing to save/);
    assert.deepEqual(readSavedSettings(db).overrides, {});
    db.close();
  });

  it('SAFETY: refuses drive paths that overlap or contain the app', async () => {
    const { db, store } = await setup({ scan: false });
    assert.throws(() => store.save({ 'drives.library': path.join(ssd, 'inside') }), (e) => e instanceof SettingsError && /overlap/.test(e.message));
    assert.throws(() => store.save({ 'drives.archive': path.dirname(ROOT_DIR) }), (e) => e instanceof SettingsError && /stored inside/.test(e.message));
    assert.deepEqual(readSavedSettings(db).overrides, {});
    db.close();
  });

  it('reset forgets every change and re-scores', async () => {
    const { db, store, state } = await setup();
    store.save({ 'ageDays.recent': 365, 'ageDays.max': 400, 'folders.keepPinned': ['Fresh Edit'] });
    assert.equal(bucketOf(db, 'Old Finished'), 'Review');
    const outcome = store.reset();
    assert.ok(outcome.changed.includes('ageDays.recent'));
    assert.deepEqual(readSavedSettings(db).overrides, {});
    assert.deepEqual(store.current(), state.file);
    assert.equal(bucketOf(db, 'Old Finished'), 'Ready');
    db.close();
  });

  it('a saved value that no longer fits config.json is reported, and can be fixed without losing the others', async () => {
    const { db, store } = await setup({ scan: false });
    // Saved changes that contradict each other (e.g. after editing the
    // database by hand): the target is above the start.
    db.prepare('UPDATE settings SET overrides = ? WHERE id = 1').run(
      JSON.stringify({ ageDays: { recent: 30, max: 120 }, 'buckets.review': 50, libraryFull: { startAtPercent: 60, targetPercent: 80 } }),
    );
    assert.throws(() => store.current(), (e) => e instanceof ConfigError && /Settings page/.test(e.message));
    const view = store.view();
    assert.match(view.problem, /targetPercent/);
    // Fixing the one bad value keeps the other changes.
    store.save({ 'libraryFull.targetPercent': 50 });
    assert.equal(store.current().buckets.review, 50);
    assert.equal(store.current().ageDays.recent, 30);
    assert.equal(store.view().problem, null);
    db.close();
  });

  it('every field points at a real setting', () => {
    const defaults = withDefaults();
    for (const field of FIELDS) {
      const value = field.key.split('.').reduce((o, k) => o?.[k], defaults);
      assert.notEqual(value, undefined, `${field.key} isn't in config.example.json`);
    }
  });
});

describe('loadAppConfig (what the Terminal commands use)', () => {
  it('puts the Settings page\'s changes on top of config.json', async () => {
    const { db, store, loadFileConfig } = await setup({ scan: false });
    store.save({ 'buckets.review': 60 });
    const { config, source } = loadAppConfig({ db, loadFileConfig });
    assert.equal(config.buckets.review, 60);
    assert.equal(source, 'config.json + 1 change from the Settings page');
    db.close();
  });
});

describe('the settings routes', () => {
  async function startServer({ scanAndSave: scanStep } = {}) {
    const { db, store, state } = await setup();
    const runner = createScanRunner({ db, getConfig: () => store.current(), scanAndSave: scanStep, log: { error() {} } });
    const app = createApp({ db, runner, settings: store, getSpaces: async () => [] });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, { method = 'GET', body, type = 'application/json' } = {}) => {
      const response = await fetch(url + route, {
        method,
        headers: method === 'POST' ? { 'Content-Type': type } : {},
        body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body ?? {})) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };
    const stop = async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    };
    return { db, state, call, stop };
  }

  it('GET /api/settings lists the sections and the config.json-only settings', async () => {
    const { call, stop } = await startServer();
    try {
      const { status, body } = await call('/api/settings');
      assert.equal(status, 200);
      assert.equal(body.canEdit, true);
      assert.deepEqual(
        body.sections.map((s) => s.id),
        ['drives', 'libraryFull', 'scoring', 'folders', 'vericopy', 'fileTypes'],
      );
      assert.deepEqual(body.fixed.map((f) => f.key), ['server.port', 'server.host']);
    } finally {
      await stop();
    }
  });

  it('POST /api/settings saves and re-scores at once; reset undoes it', async () => {
    const { db, call, stop } = await startServer();
    const configJsonBefore = fs.existsSync(path.join(ROOT_DIR, 'config.json'))
      ? fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8')
      : null;
    try {
      const { status, body } = await call('/api/settings', {
        method: 'POST',
        body: { values: { 'buckets.review': 50, 'ageDays.recent': 365, 'ageDays.max': 400 } },
      });
      assert.equal(status, 200);
      assert.equal(body.needsScan, false);
      assert.equal(body.settings.changedCount, 2); // buckets.review + the ageDays group
      assert.equal(bucketOf(db, 'Old Finished'), 'Review');

      const projects = await call('/api/projects');
      assert.equal(projects.body.projects.find((p) => p.name === 'Old Finished').tag, 'check');

      const reset = await call('/api/settings/reset', { method: 'POST' });
      assert.equal(reset.status, 200);
      assert.equal(reset.body.settings.changedCount, 0);
      assert.equal(bucketOf(db, 'Old Finished'), 'Ready');
    } finally {
      await stop();
    }
    // SAFETY: config.json is never written.
    const configJsonAfter = fs.existsSync(path.join(ROOT_DIR, 'config.json'))
      ? fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8')
      : null;
    assert.equal(configJsonAfter, configJsonBefore);
  });

  it('bad values are a 400 with the reason; nothing is saved', async () => {
    const { db, call, stop } = await startServer();
    try {
      const bad = await call('/api/settings', { method: 'POST', body: { values: { 'weights.done': 0.9 } } });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /add up to 1/);
      const notJson = await call('/api/settings', { method: 'POST', body: '{oops' });
      assert.equal(notJson.status, 400);
      assert.match(notJson.body.error, /JSON/);
      assert.deepEqual(readSavedSettings(db).overrides, {});
    } finally {
      await stop();
    }
  });

  it('refuses a save that isn\'t sent as JSON (another website\'s form)', async () => {
    const { db, call, stop } = await startServer();
    try {
      const { status } = await call('/api/settings', { method: 'POST', body: 'values=1', type: 'application/x-www-form-urlencoded' });
      assert.equal(status, 415);
      assert.deepEqual(readSavedSettings(db).overrides, {});
    } finally {
      await stop();
    }
  });

  it('refuses to save while a scan is running (it would re-score with the old settings)', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { db, call, stop } = await startServer({
      scanAndSave: async (options) => {
        await gate;
        return scanAndSave(options);
      },
    });
    try {
      const started = await call('/api/scan', { method: 'POST' });
      assert.equal(started.status, 202);
      const busy = await call('/api/settings', { method: 'POST', body: { values: { 'buckets.review': 50 } } });
      assert.equal(busy.status, 409);
      assert.match(busy.body.error, /scan is running/);
      assert.deepEqual(readSavedSettings(db).overrides, {});
    } finally {
      release();
      for (let i = 0; i < 200 && (await call('/api/scan')).body.running; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await stop();
    }
  });
});
