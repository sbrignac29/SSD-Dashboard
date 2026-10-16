'use strict';

// The dashboard's HTTP client for VeriCopy (Phase 5).
//
// VeriCopy is the owner's Mac app that copies folders and verifies every file
// with checksums. While it's open, it answers HTTP requests at
// http://127.0.0.1:8787 (its API.md is the contract). This file is the only
// place in the app that sends requests to another program over HTTP.
//
// Server vs client: src/server.js is a SERVER (it waits for the browser to ask
// it things). This file is a CLIENT: it does the asking. Each call sends one
// request (a method like GET or POST, plus a path like /api/jobs/<id>) and
// waits for VeriCopy's answer: a status code (202 = accepted, 409 = refused,
// ...) and a JSON body.
//
// SAFETY (see CLAUDE.md, tests/safety.test.js and tests/vericopy.test.js):
//   - Only VeriCopy on this Mac: the address must be http://127.0.0.1:<port>
//     (config.js → vericopyAddress refuses anything else).
//   - Only four routes, the ones in ROUTES below. There's no way to ask for
//     another path: job ids are checked, and the path is built here.
//   - Never an Origin header. VeriCopy refuses requests that carry one,
//     because a web page's requests always do. Node's built-in http module
//     only sends the headers we write (checked with a test server, not
//     assumed), and send() refuses to go if an Origin header ever appears.
//     The browser never talks to VeriCopy: only this server-side code does.
//   - VeriCopy only copies. It never overwrites (409 destination_exists) and has
//     no delete route. The dashboard itself writes nothing on any drive.

// `request` is Node's function for sending one HTTP request. It's taken out
// of the module under its own name (httpRequest) so it can't be confused with
// the Notion library's `.request(...)`, which tests/safety.test.js forbids.
const { request: httpRequest } = require('node:http');
const { vericopyAddress, DEFAULT_VERICOPY_URL } = require('../config');

// The whole list of things the dashboard may ask VeriCopy (API.md):
//   health  GET  /api/health              is it open? { ok, version, queueActive }
//   start   POST /api/jobs                copy { source, destination } -> 202 { jobId }
//   job     GET  /api/jobs/:id            one job's status (what we poll)
//   cancel  POST /api/jobs/:id/cancel     stop a running or queued job
const ROUTES = Object.freeze({
  health: { method: 'GET', path: () => '/api/health' },
  start: { method: 'POST', path: () => '/api/jobs' },
  job: { method: 'GET', path: (id) => `/api/jobs/${id}` },
  cancel: { method: 'POST', path: (id) => `/api/jobs/${id}/cancel` },
});

// How long to wait for an answer. POST /api/jobs walks the whole source
// folder before it answers, which can take a while on a big project (API.md:
// "30 s is ample"). Everything else answers at once.
const TIMEOUTS_MS = { health: 3000, start: 30000, job: 5000, cancel: 5000 };

// VeriCopy's job ids are UUIDs ("5584C666-76CC-..."). Anything else is refused
// before a request is made, so an id can't change the path (e.g. "../health").
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/;

// Every status VeriCopy can report (API.md "Status values"). Only `verified`
// means the copy is known good.
const STATUSES = ['queued', 'copying', 'verifying', 'verified', 'failed', 'cancelled', 'copied_unverified'];
const FINAL_STATUSES = ['verified', 'failed', 'cancelled', 'copied_unverified'];

// Problems talking to VeriCopy. `code` is what to branch on:
//   VeriCopy's own `error` codes (destination_exists, path_not_found, job_not_found, ...),
//   'not_running' (nothing answered), 'timeout', 'bad_answer' (not VeriCopy's JSON), 'refused_here'
//   (the dashboard wouldn't send it). `message` is VeriCopy's own text (or ours).
class VericopyError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Turns one job answer into a fixed shape. VeriCopy leaves out keys that have
// no value yet (e.g. secondsRemaining while it's warming up), so a missing key
// becomes null here, and nothing later has to guess.
function normalizeJob(raw) {
  const job = raw && typeof raw === 'object' ? raw : {};
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const text = (value) => (typeof value === 'string' ? value : null);
  return {
    jobId: text(job.jobId),
    name: text(job.name),
    origin: text(job.origin),
    status: text(job.status),
    // A status this version of the dashboard doesn't know: never a success.
    knownStatus: STATUSES.includes(job.status),
    final: FINAL_STATUSES.includes(job.status),
    destination: text(job.destination),
    progress: number(job.progress), // 0.0–1.0, copying AND verifying together
    bytesCopied: number(job.bytesCopied),
    bytesTotal: number(job.bytesTotal),
    filesTotal: number(job.filesTotal),
    filesCopied: number(job.filesCopied),
    filesVerified: number(job.filesVerified),
    filesFailed: number(job.filesFailed),
    startedAt: text(job.startedAt),
    finishedAt: text(job.finishedAt),
    secondsRemaining: number(job.secondsRemaining),
    fatalError: text(job.fatalError),
    failedFiles: Array.isArray(job.failedFiles)
      ? job.failedFiles.slice(0, 500).map((f) => ({ path: text(f?.path) ?? '?', message: text(f?.message) ?? '' }))
      : [],
  };
}

// The biggest answer we'll read (a job with a long failedFiles list is still
// far smaller). Stops a broken answer from filling memory.
const MAX_ANSWER_BYTES = 5 * 1024 * 1024;

//   url – config.vericopy.url, e.g. "http://127.0.0.1:8787"
// Returns { url, health, startJob, getJob, cancelJob }. Each returns a promise
// of VeriCopy's answer, or throws a VericopyError.
function createVericopyClient({ url = DEFAULT_VERICOPY_URL, timeouts = TIMEOUTS_MS } = {}) {
  const address = vericopyAddress(url);
  if (!address) {
    // SAFETY: never talk to anything but 127.0.0.1.
    throw new VericopyError('refused_here', `VeriCopy's address must be http://127.0.0.1:<port>, not "${url}".`);
  }

  // Sends one request and resolves with { status, body }.
  function send(routeName, { jobId = null, body = null } = {}) {
    const route = ROUTES[routeName];
    if (!route) return Promise.reject(new VericopyError('refused_here', `No VeriCopy route called "${routeName}".`));
    if (route.path.length > 0 && !(typeof jobId === 'string' && JOB_ID.test(jobId))) {
      return Promise.reject(new VericopyError('refused_here', `"${jobId}" isn't a VeriCopy job id.`));
    }
    const payload = body === null ? '' : JSON.stringify(body);
    // The only headers sent. (Node adds Host and Connection itself; it never
    // adds Origin.)
    const headers = { Accept: 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (body !== null) headers['Content-Type'] = 'application/json';
    if (Object.keys(headers).some((name) => name.toLowerCase() === 'origin')) {
      return Promise.reject(new VericopyError('refused_here', 'Refusing to send an Origin header to VeriCopy.'));
    }

    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          method: route.method,
          path: route.path(jobId),
          headers,
          // A fresh connection per request: nothing stays open between polls.
          agent: false,
          timeout: timeouts[routeName],
        },
        (answer) => {
          const chunks = [];
          let size = 0;
          answer.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_ANSWER_BYTES) {
              answer.destroy(new VericopyError('bad_answer', "VeriCopy's answer was far too big."));
              return;
            }
            chunks.push(chunk);
          });
          answer.on('error', reject);
          answer.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = text === '' ? null : JSON.parse(text);
            } catch {
              // Not JSON: handled below.
            }
            const status = answer.statusCode;
            if (status >= 200 && status < 300) {
              if (json === null || typeof json !== 'object') {
                reject(new VericopyError('bad_answer', `Something at ${address.origin} answered, but not like VeriCopy does.`, { status }));
              } else {
                resolve({ status, body: json });
              }
              return;
            }
            // Every VeriCopy error looks like { error, message }: branch on `error`.
            const code = typeof json?.error === 'string' ? json.error : `http_${status}`;
            const message = typeof json?.message === 'string' ? json.message : `VeriCopy answered ${status}.`;
            reject(new VericopyError(code, message, { status }));
          });
        },
      );
      outgoing.on('timeout', () => {
        outgoing.destroy(new VericopyError('timeout', `VeriCopy didn't answer within ${Math.round(timeouts[routeName] / 1000)} seconds.`));
      });
      outgoing.on('error', (error) => {
        if (error instanceof VericopyError) return reject(error);
        // ECONNREFUSED: nothing is listening at that port, i.e. VeriCopy isn't open
        // (or its API is turned off in VeriCopy ▸ Settings ▸ API).
        if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE'].includes(error.code)) {
          return reject(new VericopyError('not_running', `Nothing answered at ${address.origin}.`));
        }
        return reject(new VericopyError('not_running', `Couldn't reach VeriCopy at ${address.origin}: ${error.message}`));
      });
      outgoing.end(payload);
    });
  }

  return {
    url: address.origin,
    // { ok, version, queueActive }
    async health() {
      const { body } = await send('health');
      return { ok: body.ok === true, version: typeof body.version === 'string' ? body.version : null, queueActive: body.queueActive === true };
    },
    // Asks VeriCopy to copy `source` (a folder) INTO `destination` (an
    // existing folder): it lands at destination/<source folder name>.
    async startJob({ source, destination }) {
      const { body } = await send('start', { body: { source, destination } });
      if (typeof body.jobId !== 'string' || !JOB_ID.test(body.jobId)) {
        throw new VericopyError('bad_answer', 'VeriCopy accepted the copy but sent no job id.');
      }
      return { jobId: body.jobId };
    },
    async getJob(jobId) {
      return normalizeJob((await send('job', { jobId })).body);
    },
    async cancelJob(jobId) {
      return normalizeJob((await send('cancel', { jobId })).body);
    },
  };
}

module.exports = { createVericopyClient, normalizeJob, VericopyError, ROUTES, STATUSES, FINAL_STATUSES, JOB_ID };
