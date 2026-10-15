'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProjectName } = require('../src/scanner/parseName');

// Checks just the fields we care about for each example.
function check(name, expected) {
  const parsed = parseProjectName(name);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(parsed[key], value, `${name} → ${key}`);
  }
}

test('month-day names from the BRIGSMEDIA drive', () => {
  check('Parker Soccer 10-3', { subject: 'Parker Soccer', month: 10, day: 3, year: null, dateLabel: '10/3' });
  check('Baseball 6-12', { subject: 'Baseball', month: 6, day: 12, year: null });
  check('QB Era 9-6', { subject: 'QB Era', month: 9, day: 6 });
  check('Soccer 8-24', { subject: 'Soccer', month: 8, day: 24 });
});

test('a lone year', () => {
  check('Camping 2026', { subject: 'Camping', year: 2026, month: null, dateLabel: '2026' });
  check('Senior Videos 2026', { subject: 'Senior Videos', year: 2026 });
});

test('names without dates keep the whole name as the subject', () => {
  check("Veteran's Day Video", { subject: "Veteran's Day Video", dateLabel: null, year: null });
  check('NCHS Football Working Proxies', { subject: 'NCHS Football Working Proxies', dateLabel: null });
  check('untitled folder', { subject: 'untitled folder', dateLabel: null });
});

test('full dates in the recommended naming style', () => {
  check('2026-08-24 Next Elite - Soccer Training', {
    subject: 'Next Elite - Soccer Training',
    year: 2026,
    month: 8,
    day: 24,
    dateLabel: '2026-08-24',
  });
  check('2025_03_14_Nike_Spring Promo', { subject: 'Nike Spring Promo', year: 2025, month: 3, day: 14 });
  check('Shoot 20250314', { subject: 'Shoot', year: 2025, month: 3, day: 14 });
  check('Game 6-12-25', { subject: 'Game', year: 2025, month: 6, day: 12 });
});

test('a "/" typed in Finder is stored as ":" and still parses', () => {
  check('Soccer 8:24', { subject: 'Soccer', month: 8, day: 24 });
});

test('impossible dates and look-alikes are not dates', () => {
  check('Soccer 13-45', { dateLabel: null });
  check('Game 2-30', { dateLabel: null }); // no Feb 30th
  check('U12-14 Tournament', { dateLabel: null });
  check('SUNBURNED 1080p', { dateLabel: null });
});

test('a name that is only a date has no subject', () => {
  check('2026-01-05', { subject: null, dateLabel: '2026-01-05' });
});
