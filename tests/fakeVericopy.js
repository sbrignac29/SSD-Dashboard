'use strict';

// A fake VeriCopy for the tests (not a test file itself): a real HTTP server
// on 127.0.0.1 and a random port that answers like VeriCopy's API.md says,
// so the dashboard's client and moves can be tested without the real app or
// any real drive. It only ever copies inside the tests' own data/.test-*
// folders.
//
// Like the real one it:
//   - refuses any request with an Origin header (403 browser_origin_refused)
//   - needs Content-Type: application/json on POST /api/jobs
//   - never overwrites (409 destination_exists) and needs the destination to exist
//   - leaves out keys that have no value (no nulls)
// Each GET /api/jobs/:id moves a job one step along its `steps`
// (default queued → copying → verifying → verified). The files are copied when
// the job reaches "copying".
//
// Scripting the next job: fake.nextJob = { steps, failedFiles, fatalError, tamper(destinationFolder) }
// A refusal for the next POST /api/jobs: fake.nextStartError = { status, error, message }
// VeriCopy restarted (forgets every job): fake.forgetJobs()
// Every request is in fake.requests: { method, path, headers }.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const FINAL = ['verified', 'failed', 'cancelled', 'copied_unverified'];

function startFakeVericopy() {
  const requests = [];
  const jobs = new Map();
  const fake = { requests, jobs, nextJob: null, nextStartError: null };

  function send(res, status, body) {
    // Like VeriCopy: no null keys.
    const clean = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null && value !== undefined));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(clean));
  }

  function jobBody(job) {
    const step = job.steps[job.at];
    const total = job.filesTotal;
    const copying = ['copying', 'verifying', 'verified', 'failed'].includes(step);
    return {
      jobId: job.jobId,
      name: path.basename(job.source),
      origin: 'api',
      status: step,
      sources: [job.source],
      destination: job.destination,
      progress: { queued: 0, copying: 0.4, verifying: 0.75, verified: 1 }[step] ?? 0.5,
      bytesCopied: copying ? job.bytesTotal : 0,
      bytesTotal: job.bytesTotal,
      filesTotal: total,
      filesCopied: copying ? total : 0,
      filesVerified: step === 'verified' ? total : step === 'verifying' ? Math.floor(total / 2) : 0,
      filesFailed: job.failedFiles.length,
      startedAt: '2026-10-16T10:00:00Z',
      finishedAt: FINAL.includes(step) ? '2026-10-16T10:05:00Z' : null,
      secondsRemaining: step === 'copying' ? 120 : step === 'verifying' ? 40 : null,
      fatalError: job.fatalError,
      failedFiles: job.failedFiles,
    };
  }

  function countFiles(folder) {
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
      }
    }
    return { files, bytes };
  }

  // The fake's "copy": the test folder, inside data/.test-*.
  function copyNow(job) {
    if (job.copied) return;
    job.copied = true;
    const target = path.join(job.destination, path.basename(job.source));
    fs.cpSync(job.source, target, { recursive: true, preserveTimestamps: true });
    job.tamper?.(target);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, headers: { ...req.headers } });
      if ('origin' in req.headers) {
        return send(res, 403, { error: 'browser_origin_refused', message: 'Requests from web pages are refused.' });
      }
      if (req.method === 'GET' && req.url === '/api/health') {
        return send(res, 200, { ok: true, version: '1.0', queueActive: [...jobs.values()].some((j) => !FINAL.includes(j.steps[j.at])) });
      }
      if (req.method === 'POST' && req.url === '/api/jobs') {
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return send(res, 400, { error: 'unsupported_media_type', message: 'Content-Type must be application/json.' });
        }
        if (fake.nextStartError) {
          const { status, error, message } = fake.nextStartError;
          fake.nextStartError = null;
          return send(res, status, { error, message });
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(res, 400, { error: 'invalid_body', message: 'Body is not { source, destination }.' });
        }
        const { source, destination } = body ?? {};
        if (typeof source !== 'string' || typeof destination !== 'string') {
          return send(res, 400, { error: 'invalid_body', message: 'Body is not { source, destination }.' });
        }
        if (!fs.existsSync(source) || !fs.existsSync(destination)) {
          return send(res, 400, { error: 'path_not_found', message: 'Path does not exist.' });
        }
        if (fs.existsSync(path.join(destination, path.basename(source)))) {
          return send(res, 409, { error: 'destination_exists', message: 'Already exists. This API never overwrites.' });
        }
        const plan = fake.nextJob ?? {};
        fake.nextJob = null;
        const { files, bytes } = countFiles(source);
        const job = {
          jobId: crypto.randomUUID().toUpperCase(),
          source,
          destination,
          steps: plan.steps ?? ['queued', 'copying', 'verifying', 'verified'],
          at: 0,
          filesTotal: files,
          bytesTotal: bytes,
          failedFiles: plan.failedFiles ?? [],
          fatalError: plan.fatalError ?? null,
          tamper: plan.tamper ?? null,
          copied: false,
        };
        jobs.set(job.jobId, job);
        return send(res, 202, { jobId: job.jobId });
      }
      const match = req.url.match(/^\/api\/jobs\/([^/]+)(\/cancel)?$/);
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) return send(res, 404, { error: 'job_not_found', message: 'No job with that id.' });
        if (req.method === 'GET' && !match[2]) {
          // Each poll moves the job one step on (and stays on its last step).
          if (job.at < job.steps.length - 1 && !FINAL.includes(job.steps[job.at])) job.at += 1;
          if (['copying', 'verifying', 'verified', 'failed'].includes(job.steps[job.at])) copyNow(job);
          return send(res, 200, jobBody(job));
        }
        if (req.method === 'POST' && match[2]) {
          if (FINAL.includes(job.steps[job.at])) return send(res, 409, { error: 'job_not_cancellable', message: 'Already finished.' });
          job.steps = [...job.steps.slice(0, job.at + 1), 'cancelled'];
          job.at += 1;
          return send(res, 200, jobBody(job));
        }
        return send(res, 405, { error: 'method_not_allowed', message: 'Wrong method.' });
      }
      return send(res, 404, { error: 'not_found', message: 'No such route.' });
    });
  });

  fake.forgetJobs = () => jobs.clear();
  fake.listen = () =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        fake.port = server.address().port;
        fake.url = `http://127.0.0.1:${fake.port}`;
        resolve(fake);
      });
    });
  fake.stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}

// A port where nothing is listening (VeriCopy "not open").
async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

module.exports = { startFakeVericopy, closedPort };
