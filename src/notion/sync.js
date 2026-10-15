'use strict';

// LATER PHASE — stub only.
//
// Will read each project's status from Notion (via @notionhq/client) so the
// "Done" part of the score can use it: "Complete" or "Delivered" → Done = 100.
// Notion is only ever READ here; nothing on the SSD changes.

async function syncNotionStatuses() {
  throw new Error('Notion sync is not built yet (later phase).');
}

module.exports = { syncNotionStatuses };
