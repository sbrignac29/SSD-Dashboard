'use strict';

// PHASE 3 — not built yet.
//
// This will be the web server that runs the dashboard at http://localhost:<port>.
// It will use Express, a small library for answering web requests. Each
// "route" is a pair of (web address, function that answers it), e.g.:
//
//   GET  /                 -> sends public/index.html (the dashboard page)
//   GET  /api/projects     -> sends the latest scan results + scores as JSON
//   POST /api/scan         -> starts a fresh scan of the SSD
//   POST /api/projects/:id/pin -> pins/unpins a project as "Keep"
//
// When it starts, it will also start the nightly 2 AM scan (src/jobs/nightly.js).
//
// The server will only READ from the SSD (through src/scanner/scan.js) and only
// WRITE to the data/ folder (through src/db.js).

console.log('The dashboard server arrives in Phase 3. For now, run: npm run scan (or npm run report)');
