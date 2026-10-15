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
