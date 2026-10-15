'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DATA_DIR, withDefaults } = require('../src/config');
const { driveSpace, allDriveSpace } = require('../src/scanner/space');

test('driveSpace reports the size and free space of the drive a folder is on', async () => {
  const space = await driveSpace(DATA_DIR);
  assert.ok(space.totalBytes > 0);
  assert.ok(space.freeBytes >= 0 && space.freeBytes <= space.totalBytes);
  assert.equal(space.usedBytes, space.totalBytes - space.freeBytes);
  assert.ok(space.usedPercent >= 0 && space.usedPercent <= 100);
});

test('driveSpace returns null for a drive that is not plugged in', async () => {
  assert.equal(await driveSpace(path.join(DATA_DIR, 'no-such-drive')), null);
});

test('allDriveSpace lists every drive in config, connected or not', async () => {
  const config = withDefaults({ drives: { working: DATA_DIR, library: '/Volumes/Not Here', archive: '' } });
  const spaces = await allDriveSpace(config);
  assert.deepEqual(
    spaces.map((s) => [s.drive, s.label, s.space === null]),
    [
      ['working', 'Working SSD', false],
      ['library', 'Library HDD', true],
    ],
  );
});
