'use strict';

// LATER PHASE — stub only. DO NOT IMPLEMENT until the owner explicitly asks.
//
// Will hand a project over to the owner's existing Vericopy app
// (http://localhost:7743, an rsync UI with checksum verification) to COPY it
// to archive storage.
//
// SAFETY RULES (see CLAUDE.md):
//   - This app must never delete, move, rename, or write anything on the SSD.
//   - Offload/delete features stay empty stubs until the owner explicitly asks.

async function startOffload() {
  throw new Error('Offloading is not built yet. It stays disabled until you explicitly ask for it.');
}

module.exports = { startOffload };
