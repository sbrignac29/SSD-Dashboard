'use strict';

// Tests for the file classifier. Run with: npm test
//
// `test(name, fn)` registers a check; `assert.equal(actual, expected)` fails
// the test if the two differ. Node's built-in test runner finds and runs
// every file in tests/ ending in .test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withDefaults } = require('../src/config');
const { createClassifier, isHousekeepingName, toWords } = require('../src/scanner/classify');

const { classify } = createClassifier(withDefaults().fileTypes);

test('original camera media is raw (extensions are case-insensitive)', () => {
  assert.equal(classify('C0001.MP4', ['Footage']), 'raw');
  assert.equal(classify('A001_C002.braw', []), 'raw');
  assert.equal(classify('IMG_1234.HEIC', ['Photos']), 'raw');
  assert.equal(classify('Kahn.mp3', ['Music']), 'raw');
});

test('project files win over everything else', () => {
  assert.equal(classify('Edit.prproj', []), 'project');
  assert.equal(classify('QB Era.drp', ['Exports']), 'project');
  assert.equal(classify('Project--10-15-2026.prproj', ['Adobe Premiere Pro Auto-Save']), 'project');
});

test('cache folders and cache extensions are cache', () => {
  assert.equal(classify('x.dvcc', ['CacheClip']), 'cache');
  assert.equal(classify('a.mov', ['Render Cache']), 'cache'); // "render" alone would mean export
  assert.equal(classify('a.mov', ['Adobe Premiere Pro Video Previews']), 'cache');
  assert.equal(classify('clip.pek', ['Peaks']), 'cache');
  assert.equal(classify('clip.cfa', []), 'cache');
});

test('proxy folders, proxy file names and .lrv files are proxies', () => {
  assert.equal(classify('C0001.mov', ['Proxies']), 'proxy');
  assert.equal(classify('C0001.mov', ['ProRes Proxies']), 'proxy');
  assert.equal(classify('C0001.mov', ['OptimizedMedia']), 'proxy');
  assert.equal(classify('C0001_Proxy.mov', ['Footage']), 'proxy');
  assert.equal(classify('GL010001.LRV', ['DCIM', '100GOPRO']), 'proxy');
});

test('a project NAME can mark proxies or cache, e.g. "NCHS Football Working Proxies"', () => {
  assert.equal(classify('C0002.mov', [], ['NCHS Football Working Proxies']), 'proxy');
});

test('export folders inside the project make exports', () => {
  assert.equal(classify('v1.mp4', ['Exports']), 'export');
  assert.equal(classify('v1.mp4', ['05_Exports']), 'export');
  assert.equal(classify('v1.mp4', ['Deliverables', 'Social']), 'export');
  assert.equal(classify('v1.mov', ['Renders']), 'export');
  assert.equal(classify('still.png', ['FINAL EXPORTS']), 'export');
});

test('video files named like finished exports are exports', () => {
  assert.equal(classify('Sunburned Final Cut.mov', []), 'export');
  assert.equal(classify('Meet the Rowdies FINAL.mov', []), 'export');
  assert.equal(classify('Season_Master.mp4', []), 'export');
});

test('a project NAME never makes exports: "Soccer Finals Temp" footage stays raw', () => {
  assert.equal(classify('game.mov', ['Footage'], ['Soccer Finals Temp']), 'raw');
  assert.equal(classify('game.mov', [], ['FINAL FINAL RENDERS']), 'raw');
});

test('whole words only: "Finally" is not "final", "Rendering Notes" is not "render"', () => {
  assert.equal(classify('Finally Home.mov', []), 'raw');
  assert.equal(classify('a.mov', ['Rendering Notes']), 'raw');
});

test('housekeeping files are "other" even inside an Exports folder', () => {
  assert.equal(classify('.DS_Store', ['Exports']), 'other');
  assert.equal(classify('._v1.mp4', ['Exports']), 'other');
  assert.equal(classify('Thumbs.db', []), 'other');
});

test('documents, graphics and unknown files are other', () => {
  assert.equal(classify('notes.txt', []), 'other');
  assert.equal(classify('banner.psd', []), 'other');
  assert.equal(classify('Look.cube', ['LUTs']), 'other');
});

test('isHousekeepingName spots OS-made files', () => {
  assert.equal(isHousekeepingName('.DS_Store'), true);
  assert.equal(isHousekeepingName('._clip.mov'), true);
  assert.equal(isHousekeepingName('desktop.ini'), true);
  assert.equal(isHousekeepingName('clip.mov'), false);
});

test('toWords splits names into padded lowercase words', () => {
  assert.equal(toWords('ProRes Proxies'), ' pro res proxies ');
  assert.equal(toWords('05_Exports'), ' 05 exports ');
  assert.equal(toWords('CacheClip'), ' cache clip ');
});
