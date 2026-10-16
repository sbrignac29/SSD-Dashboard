'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  ROOT_DIR,
  withDefaults,
  deepMerge,
  isInside,
  assertSafeLocations,
  assertAppNotInside,
  notionId,
  notionSettings,
} = require('../src/config');

test('the shipped defaults are valid and match the plan', () => {
  const config = withDefaults();
  assert.deepEqual(config.drives, {
    working: '/Volumes/BRIGSMEDIA',
    library: '/Volumes/BRIGSMEDIA LIBRARY',
    archive: '/Volumes/Expansion/BRIGSMEDIA ARCHIVE',
  });
  assert.deepEqual(config.libraryFull, { startAtPercent: 90, targetPercent: 70 });
  assert.deepEqual(config.weights, { done: 0.45, age: 0.35, size: 0.2 });
  assert.deepEqual(config.ageDays, { recent: 14, max: 120 });
  assert.deepEqual(config.buckets, { review: 40 });
  assert.deepEqual(config.fileTypes.finalExportWords, ['final', 'fd']);
});

test('an old config.json with "ssdPath" gets a clear message about the new "drives" section', () => {
  assert.throws(
    () => withDefaults({ ssdPath: '/Volumes/BRIGSMEDIA' }),
    /"ssdPath" was replaced by the "drives" section/,
  );
});

test('libraryFull: the target must be below the start', () => {
  assert.throws(() => withDefaults({ libraryFull: { startAtPercent: 90, targetPercent: 95 } }), /targetPercent/);
});

test('your settings override defaults; lists are replaced, sections merged', () => {
  const merged = deepMerge(
    { weights: { done: 0.45, age: 0.35 }, folders: { shared: ['A', 'B'], ignore: ['X'] } },
    { weights: { age: 0.5 }, folders: { shared: ['C'] } },
  );
  assert.deepEqual(merged, { weights: { done: 0.45, age: 0.5 }, folders: { shared: ['C'], ignore: ['X'] } });
});

test('weights must add up to 1', () => {
  assert.throws(() => withDefaults({ weights: { done: 0.5, age: 0.5, size: 0.5 } }), /add up to 1/);
});

test('every problem is listed at once', () => {
  assert.throws(
    () => withDefaults({ drives: { working: '' }, buckets: { review: 140 } }),
    (error) => error.message.includes('drives.working') && error.message.includes('buckets.review'),
  );
});

test('isInside', () => {
  assert.equal(isInside('/Volumes/SSD/Projects', '/Volumes/SSD'), true);
  assert.equal(isInside('/Volumes/SSD', '/Volumes/SSD'), true);
  assert.equal(isInside('/Volumes/SSD2', '/Volumes/SSD'), false);
  assert.equal(isInside('/Volumes', '/Volumes/SSD'), false);
});

test('refuses to run when the app itself is on any of the three drives', () => {
  for (const drive of ['working', 'library', 'archive']) {
    const config = withDefaults({ drives: { [drive]: path.dirname(ROOT_DIR) } });
    assert.throws(() => assertSafeLocations(config), /This app is stored inside your/);
  }
  assert.throws(
    () => assertAppNotInside(ROOT_DIR, 'the folder being scanned'),
    /stored inside the folder being scanned/,
  );
});

test('refuses drives that overlap each other', () => {
  const config = withDefaults({ drives: { library: '/Volumes/BRIGSMEDIA/Library' } });
  assert.throws(() => assertSafeLocations(config), /"drives.library" and "drives.working" overlap/);
});

test('the real drive layout is accepted, and a missing drive can be left empty', () => {
  assert.doesNotThrow(() => assertSafeLocations(withDefaults()));
  assert.doesNotThrow(() => assertSafeLocations(withDefaults({ drives: { archive: '' } })));
});

// --- Notion (Phase 4) ---------------------------------------------------------

test('Notion: no token is fine (the dashboard just says "Notion: not connected")', () => {
  const settings = notionSettings(withDefaults());
  assert.equal(settings.token, '');
  assert.equal(settings.configured, false);
  assert.equal(settings.dataSourceId, '233517a5-0199-8028-a552-000b7d81cc6b', "the owner's Projects data source");
  assert.equal(notionSettings(withDefaults({ notion: { token: ' abc ' } })).configured, true);
});

test('Notion: the data source ID can be pasted with or without dashes, or inside a link', () => {
  assert.equal(notionId('233517a501998028a552000b7d81cc6b'), '233517a5-0199-8028-a552-000b7d81cc6b');
  assert.equal(notionId('233517A5-0199-8028-A552-000B7D81CC6B'), '233517a5-0199-8028-a552-000b7d81cc6b');
  // A database link: the ID after the page name, not the view's ID after "?v=".
  assert.equal(
    notionId('https://www.notion.so/brigsmedia/Cafe-233517a501998055b2d5dc8f88dcd53c?v=233517a5019980ab8f0f000c1234abcd'),
    '233517a5-0199-8055-b2d5-dc8f88dcd53c',
  );
  assert.equal(notionId('Projects'), null);
});

test('Notion: settings that are the wrong kind of value are explained', () => {
  assert.throws(() => withDefaults({ notion: { token: 12345 } }), /"notion\.token" must be your Notion token in quotes/);
  assert.throws(() => withDefaults({ notion: { dataSourceId: 'Projects' } }), /"notion\.dataSourceId" must be the ID/);
  assert.throws(() => withDefaults({ notion: { statusProperty: '' } }), /"notion\.statusProperty" must be the name of a property/);
  assert.throws(() => withDefaults({ doneStatuses: 'Done' }), /"doneStatuses" must be a list of text/);
  // An empty End date column name just means "don't read one".
  assert.doesNotThrow(() => withDefaults({ notion: { endDateProperty: '' } }));
});

test('VeriCopy: defaults to http://127.0.0.1:8787, and only 127.0.0.1 is accepted', () => {
  assert.equal(withDefaults().vericopy.url, 'http://127.0.0.1:8787');
  assert.equal(withDefaults({ vericopy: { url: 'http://127.0.0.1:9000/' } }).vericopy.url, 'http://127.0.0.1:9000/');
  const refused = [
    'http://localhost:8787', // may resolve to ::1, where VeriCopy isn't listening
    'https://127.0.0.1:8787',
    'http://192.168.1.20:8787',
    'http://127.0.0.1', // no port
    'http://127.0.0.1:8787/api/jobs',
    'http://user:pw@127.0.0.1:8787',
    'http://127.0.0.1:8787?x=1',
    '',
    8787,
  ];
  for (const url of refused) {
    assert.throws(() => withDefaults({ vericopy: { url } }), /"vericopy\.url" must be VeriCopy's address/, String(url));
  }
});

test("the dashboard can't use VeriCopy's port", () => {
  assert.throws(() => withDefaults({ server: { port: 8787 } }), /VeriCopy uses that port/);
  assert.equal(withDefaults({ server: { port: 7743 } }).server.port, 7743, 'the old Vericopy port is free again');
});
