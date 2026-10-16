'use strict';

// Tests for the VeriCopy client (src/offload/vericopy.js): it only talks to
// 127.0.0.1, only on the four routes in API.md, never sends an Origin header,
// and turns VeriCopy's answers into one fixed shape. Uses fake servers only.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createVericopyClient, normalizeJob, VericopyError, ROUTES } = require('../src/offload/vericopy');
const { startFakeVericopy, closedPort } = require('./fakeVericopy');

test('only http://127.0.0.1:<port> is accepted as VeriCopy\'s address', () => {
  for (const url of ['http://localhost:8787', 'http://10.0.0.5:8787', 'https://127.0.0.1:8787', 'http://127.0.0.1:8787/x', 'http://127.0.0.1', 'file:///etc']) {
    assert.throws(() => createVericopyClient({ url }), (error) => error instanceof VericopyError && error.code === 'refused_here', url);
  }
  assert.equal(createVericopyClient({ url: 'http://127.0.0.1:8787/' }).url, 'http://127.0.0.1:8787');
});

test('exactly four routes exist', () => {
  assert.deepEqual(
    Object.values(ROUTES).map((r) => `${r.method} ${r.path('ID')}`),
    ['GET /api/health', 'POST /api/jobs', 'GET /api/jobs/ID', 'POST /api/jobs/ID/cancel'],
  );
});

test('a job id that could change the path is refused before anything is sent', async () => {
  const fake = await startFakeVericopy().listen();
  try {
    const client = createVericopyClient({ url: fake.url });
    for (const id of ['../health', 'a/b', '', 'x?y=1', 'a b', null, 'A'.repeat(65)]) {
      await assert.rejects(client.getJob(id), (error) => error.code === 'refused_here', String(id));
      await assert.rejects(client.cancelJob(id), (error) => error.code === 'refused_here', String(id));
    }
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.stop();
  }
});

test('the headers sent: no Origin, JSON only where needed (checked at the receiving end)', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(req.url === '/api/jobs' ? 202 : 200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/api/jobs' ? '{"jobId":"5584C666-76CC-438B-991D-D8561E4E4CD6"}' : '{"ok":true,"version":"1.0","queueActive":false,"status":"queued"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = createVericopyClient({ url: `http://127.0.0.1:${server.address().port}` });
    await client.health();
    await client.startJob({ source: '/Volumes/BRIGSMEDIA/Shoot', destination: '/Volumes/BRIGSMEDIA LIBRARY' });
    await client.getJob('5584C666-76CC-438B-991D-D8561E4E4CD6');
    await client.cancelJob('5584C666-76CC-438B-991D-D8561E4E4CD6');
    assert.deepEqual(
      seen.map((s) => `${s.method} ${s.url}`),
      [
        'GET /api/health',
        'POST /api/jobs',
        'GET /api/jobs/5584C666-76CC-438B-991D-D8561E4E4CD6',
        'POST /api/jobs/5584C666-76CC-438B-991D-D8561E4E4CD6/cancel',
      ],
    );
    for (const { headers } of seen) {
      assert.equal(headers.origin, undefined, 'never an Origin header');
      assert.equal(headers.referer, undefined);
      assert.equal(headers.host, `127.0.0.1:${server.address().port}`);
    }
    assert.equal(seen[1].headers['content-type'], 'application/json');
    assert.equal(seen[0].headers['content-type'], undefined);
    assert.equal(seen[3].headers['content-type'], undefined, 'cancel has no body');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("VeriCopy's errors keep their code; nothing listening = not_running", async () => {
  const fake = await startFakeVericopy().listen();
  try {
    const client = createVericopyClient({ url: fake.url });
    await assert.rejects(client.getJob('NOPE'), (error) => error.code === 'job_not_found' && error.status === 404);
    fake.nextStartError = { status: 409, error: 'destination_exists', message: 'Already exists.' };
    await assert.rejects(client.startJob({ source: '/a', destination: '/b' }), (error) => error.code === 'destination_exists' && error.message === 'Already exists.');
  } finally {
    await fake.stop();
  }
  const port = await closedPort();
  await assert.rejects(createVericopyClient({ url: `http://127.0.0.1:${port}` }).health(), (error) => error.code === 'not_running');
});

test('a VeriCopy that never answers times out', async () => {
  const server = http.createServer(() => {}); // never answers
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = createVericopyClient({ url: `http://127.0.0.1:${server.address().port}`, timeouts: { health: 100 } });
    await assert.rejects(client.health(), (error) => error.code === 'timeout');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('missing keys become null; an unknown status is never final', () => {
  const job = normalizeJob({ jobId: 'X', status: 'copying', progress: 0.2 });
  assert.equal(job.secondsRemaining, null);
  assert.equal(job.fatalError, null);
  assert.deepEqual(job.failedFiles, []);
  assert.equal(job.final, false);
  assert.equal(normalizeJob({ status: 'paused' }).knownStatus, false);
  assert.equal(normalizeJob({ status: 'paused' }).final, false);
  assert.equal(normalizeJob({ status: 'copied_unverified' }).final, true);
});
