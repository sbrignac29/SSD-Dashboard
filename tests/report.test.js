'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTable, shortenText, shortenPath, formatGB } = require('../src/cli/report');

test('formatGB uses decimal gigabytes, like Finder', () => {
  assert.equal(formatGB(87_512_345_678), '87.51');
  assert.equal(formatGB(0), '0.00');
});

test('shortenText cuts from the end with an ellipsis', () => {
  assert.equal(shortenText('Covenant Classical Update Content', 12), 'Covenant Cl…');
  assert.equal(shortenText('Short', 12), 'Short');
});

test('shortenPath keeps the last part, so container subprojects stay distinguishable', () => {
  // 26 wide: "Session 2" (9) + " / " (3) leaves 14 for the container name
  assert.equal(shortenPath('Next Elite Soccer Training / Session 2', 26), 'Next Elite So… / Session 2');
  assert.equal(shortenPath('Next Elite Soccer Training / 2026-08-24 Drills', 26), 'Next … / 2026-08-24 Drills');
  assert.equal(shortenPath('NCHS Football/Season Intro.mov', 24, '/'), 'NCHS F…/Season Intro.mov');
  assert.equal(shortenPath('Covenant Classical Update Content', 12), 'Covenant Cl…');
  // When even the subfolder name is too long, keep as much of IT as fits
  assert.equal(shortenPath('Next Elite Soccer Training / 2026-06-14 Passing Drills', 26), '… / 2026-06-14 Passing Dr…'); // 1 + 3 + 22 = 26
});

test('renderTable never shortens when width is Infinity (report saved to a file)', () => {
  const longName = 'Next Elite Soccer Training / A Very Long Session Name That Keeps Going';
  const lines = renderTable([{ header: 'Project', align: 'left', flex: true }], [[longName]], { width: Infinity });
  assert.ok(lines[1].includes(longName));
});

test('renderTable lines up right-aligned numbers', () => {
  const lines = renderTable(
    [
      { header: 'Name', align: 'left' },
      { header: 'GB', align: 'right' },
    ],
    [
      ['a', '1.00'],
      ['b', '100.00'],
    ],
  );
  assert.deepEqual(lines, ['  Name      GB', '  a       1.00', '  b     100.00']);
});
