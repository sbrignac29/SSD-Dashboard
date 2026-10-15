'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT_DIR, withDefaults, deepMerge, isInside, assertSafeLocations } = require('../src/config');

test('the shipped defaults are valid and match the plan', () => {
  const config = withDefaults();
  assert.equal(config.ssdPath, '/Volumes/BRIGSMEDIA');
  assert.deepEqual(config.weights, { done: 0.45, age: 0.35, size: 0.2 });
  assert.deepEqual(config.ageDays, { recent: 14, max: 120 });
  assert.deepEqual(config.buckets, { ready: 70, review: 40 });
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
    () => withDefaults({ ssdPath: '', buckets: { ready: 30, review: 40 } }),
    (error) => error.message.includes('ssdPath') && error.message.includes('buckets.ready'),
  );
});

test('isInside', () => {
  assert.equal(isInside('/Volumes/SSD/Projects', '/Volumes/SSD'), true);
  assert.equal(isInside('/Volumes/SSD', '/Volumes/SSD'), true);
  assert.equal(isInside('/Volumes/SSD2', '/Volumes/SSD'), false);
  assert.equal(isInside('/Volumes', '/Volumes/SSD'), false);
});

test('refuses to run when the app itself is on the scanned drive', () => {
  const config = withDefaults({ ssdPath: path.dirname(ROOT_DIR) });
  assert.throws(() => assertSafeLocations(config), /stored on the drive it scans/);
});

test('refuses an archive path that overlaps the SSD', () => {
  const config = withDefaults({ ssdPath: '/Volumes/BRIGSMEDIA', archivePath: '/Volumes/BRIGSMEDIA/Archive' });
  assert.throws(() => assertSafeLocations(config), /overlap/);
});
