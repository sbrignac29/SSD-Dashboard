'use strict';

// Tests for the nightly job (src/jobs/nightly.js). They never scan anything:
// each test passes a fake `run` function instead of the real scan, and stops
// the schedule at the end (a running schedule would keep the test going forever).

const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleNightlyScan, NIGHTLY_SCHEDULE } = require('../src/jobs/nightly');

const quiet = { info() {}, error() {} };

test('the nightly scan is scheduled for 2:00 AM every day', async () => {
  const task = scheduleNightlyScan({ run: async () => assert.fail('should not run during this test'), log: quiet });
  try {
    assert.equal(task.getPattern(), NIGHTLY_SCHEDULE);
    // match() asks node-cron "would the job run at this moment?" (local time).
    assert.equal(task.match(new Date(2026, 9, 16, 2, 0, 0)), true);
    assert.equal(task.match(new Date(2026, 11, 25, 2, 0, 0)), true);
    assert.equal(task.match(new Date(2026, 9, 16, 2, 1, 0)), false);
    assert.equal(task.match(new Date(2026, 9, 16, 14, 0, 0)), false); // 2 PM, not 2 AM
  } finally {
    await task.destroy();
  }
});

test('a failed nightly scan is logged, never thrown (it must not crash the server)', async () => {
  const errors = [];
  const task = scheduleNightlyScan({
    run: async () => {
      throw new Error('SSD not plugged in');
    },
    log: { info() {}, error: (message) => errors.push(message) },
  });
  try {
    await task.execute(); // run it now instead of waiting for 2 AM
    assert.deepEqual(errors, ['Nightly scan failed: SSD not plugged in']);
  } finally {
    await task.destroy();
  }
});

test('a successful nightly scan logs a summary', async () => {
  const infos = [];
  const task = scheduleNightlyScan({
    run: async () => ({ scan: { projects: [{}, {}, {}], shared: [{}] }, projects: [{}, {}, {}], added: 1, markedMissing: 2 }),
    log: { info: (message) => infos.push(message), error: assert.fail },
  });
  try {
    await task.execute();
    assert.deepEqual(infos, ['Nightly scan saved: 3 projects + 1 shared folder (1 new, 2 no longer on the Working SSD).']);
  } finally {
    await task.destroy();
  }
});

test('the schedule really fires on its own (checked with a once-a-second schedule)', async () => {
  let task;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the job never fired')), 5000);
    task = scheduleNightlyScan({
      schedule: '* * * * * *', // node-cron allows an extra seconds field at the start: every second
      run: async () => {
        clearTimeout(timer);
        resolve();
        return { scan: { projects: [], shared: [] }, projects: [], added: 0, markedMissing: 0 };
      },
      log: quiet,
    });
  }).finally(() => task.destroy());
});
