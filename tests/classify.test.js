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
  assert.equal(classify('DJI_0001.LRF', ['DCIM', 'DJI_001']), 'proxy');
  assert.equal(classify('LRV_20260101_120000_11_001.insv', []), 'proxy');
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

test('final exports: a video export named "Final" or "FD" (drafts are not final)', () => {
  const { isFinal } = createClassifier(withDefaults().fileTypes);
  assert.equal(isFinal('Soccer 8-24 FD.mp4', ['Exports']), true);
  assert.equal(isFinal('SoccerFD.mp4', []), true); // "SoccerFD" splits into "Soccer FD"
  assert.equal(isFinal('Promo FINALv2.mov', []), true);
  assert.equal(isFinal('Sunburned Final Cut.mov', []), true);
  assert.equal(isFinal('Soccer 8-24 v3.mp4', ['Exports']), false); // a draft in revision
  assert.equal(isFinal('Highlights FINAL rough.mp4', ['Exports']), false); // says it's rough
  assert.equal(isFinal('Highlights Final Draft.mp4', ['Exports']), true); // "Final Draft" = FD
  assert.equal(isFinal('Highlights Draft 2.mp4', ['Exports']), false);
  assert.equal(isFinal('Soccer FD_Proxy.mov', []), false); // a proxy, not an export
  assert.equal(isFinal('Soccer FD.mp4', ['Render Cache']), false); // cache
  assert.equal(isFinal('game.mov', ['Footage'], ['Soccer Finals Temp']), false); // the project name never counts
});

test('a "Final" or "FD" that is only part of the project or event name does not count', () => {
  const { isFinal, classify } = createClassifier(withDefaults().fileTypes);
  const regional = ['NCHS Basketball Regional Final'];
  assert.equal(isFinal('Regional Final Highlights v1.mp4', ['Exports'], regional), false);
  assert.equal(isFinal('Regional Final Highlights FD.mp4', ['Exports'], regional), true);
  // Full-game footage named after the game is raw, not an export
  assert.equal(classify('Sectional Final Full Game.mp4', ['Footage'], ['Soccer Sectional Final']), 'raw');
  const fireDept = ['Naperville FD Recruitment'];
  assert.equal(isFinal('Naperville FD Recruitment v2.mp4', ['Exports'], fireDept), false);
  assert.equal(isFinal('Naperville FD Recruitment FINAL.mp4', ['Exports'], fireDept), true);
});

test('the export\'s OWN Final still counts when the project name has Final/FD in it', () => {
  const { isFinal } = createClassifier(withDefaults().fileTypes);
  const regional = ['NCHS Basketball Regional Final'];
  assert.equal(isFinal('Highlights FINAL.mp4', ['Exports'], regional), true);
  assert.equal(isFinal('Highlights.mp4', ['Final Exports'], regional), true);
  assert.equal(isFinal('Highlights.mp4', ['Exports', 'Final'], regional), true);
  assert.equal(isFinal('Promo FD.mp4', ['Exports'], ['Naperville FD']), true);
  // Container game names count as project name too
  assert.equal(isFinal('Week 11 State Final Highlights v1.mp4', ['Exports'], ['NCHS Football', 'Week 11 State Final']), false);
});

test('"Soccer Finals Temp": drafts named after the game are not final ("Finals" = "Final")', () => {
  const { isFinal } = createClassifier(withDefaults().fileTypes);
  const project = ['Soccer Finals Temp'];
  assert.equal(isFinal('Soccer Final v1.mp4', ['Exports'], project), false);
  assert.equal(isFinal('Sectional Final Highlights v1.mp4', ['Exports'], project), false);
  assert.equal(isFinal('Highlights FINAL.mp4', ['Exports'], project), true);
  assert.equal(isFinal('Sectional Final Highlights FD.mp4', ['Exports'], project), true);
});

test('drafts inside a final-exports folder are not final', () => {
  const { isFinal } = createClassifier(withDefaults().fileTypes);
  assert.equal(isFinal('Veterans Day v1.mp4', ['Final Exports', 'Drafts']), false);
  assert.equal(isFinal('Highlights v2.mp4', ['Exports', 'State Final']), false); // a game round, not a verdict
});

test('Semi-Final, Quarter-Final, Pre-Final and Not Final are not finals', () => {
  const { isFinal } = createClassifier(withDefaults().fileTypes);
  assert.equal(isFinal('Semi-Final Highlights v2.mp4', ['Exports']), false);
  assert.equal(isFinal('Quarter Final Recap.mp4', ['Exports']), false);
  assert.equal(isFinal('Promo NOT FINAL.mp4', ['Exports']), false);
  assert.equal(isFinal('Semi-Final Highlights FD.mp4', ['Exports']), true);
});

test('timestamps and random IDs in phone/app file names are not versions', () => {
  const { isFinal, classify } = createClassifier(withDefaults().fileTypes);
  assert.equal(classify('RPReplay_Final1726851234.MP4', ['Reference']), 'raw');
  assert.equal(isFinal('RPReplay_Final1726851234.MP4', ['Reference']), false);
  assert.equal(classify('0B9C5E3A-FD12-4C8E-9A51-3D2F6E7B8C90.mov', []), 'raw');
  assert.equal(classify('trim.0B9C5E3A-FD12-4C8E-9A51-3D2F6E7B8C90.MOV', ['Footage']), 'raw'); // iPhone trim
  assert.equal(classify('0B9C5E3A-FD12-4C8E-9A51-3D2F6E7B8C90 2.MOV', []), 'raw'); // Finder duplicate
  assert.equal(isFinal('Highlights FD2.mp4', ['Exports']), true); // a short version number is fine
});

test('folders of finals: "Final Exports", "FINAL FINAL RENDERS", "Exports/FD" — but not a plain "Final" folder', () => {
  const { isFinal } = createClassifier(withDefaults().fileTypes);
  assert.equal(isFinal('Soccer 8-24 Highlights.mp4', ['FINAL EXPORTS'], ['Soccer 8-24']), true);
  assert.equal(isFinal('Hangover.mov', ['FINAL FINAL RENDERS']), true);
  assert.equal(isFinal('Highlights.mp4', ['Exports', 'FD']), true);
  assert.equal(isFinal('Highlights Draft.mp4', ['Final Exports']), false); // named as a draft
  assert.equal(isFinal('Highlights.mp4', ['Exports']), false);
  assert.equal(isFinal('clip.mov', ['Regional Final', 'Footage'], ['NCHS Basketball']), false);
});

test('photo exports can be final too (the scanner only uses them for photo-only projects)', () => {
  const { finalKind } = createClassifier(withDefaults().fileTypes);
  assert.equal(finalKind('Senior Portraits FINAL 001.jpg', ['Exports']), 'photo');
  assert.equal(finalKind('Soccer FD.mp4', ['Exports']), 'video');
  assert.equal(finalKind('State Final 001.jpg', ['Photos']), null); // raw photo, not an export
});

test('a word added only to finalExportWords still works (it also counts as an export word)', () => {
  const fileTypes = { ...withDefaults().fileTypes, finalExportWords: ['final', 'fd', 'approved'] };
  const { classify, isFinal } = createClassifier(fileTypes);
  assert.equal(classify('Promo APPROVED.mp4', []), 'export');
  assert.equal(isFinal('Promo APPROVED.mp4', []), true);
});

test('a version or number on the end still counts: FINALv2, Final2, Exports2025', () => {
  assert.equal(classify('Senior Night FINALv2.mp4', []), 'export');
  assert.equal(classify('Promo Final2.mp4', []), 'export');
  assert.equal(classify('v1.mp4', ['Exports2025']), 'export');
  assert.equal(classify('C0001.mov', ['Proxies1080']), 'proxy');
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
