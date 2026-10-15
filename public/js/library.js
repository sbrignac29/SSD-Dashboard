'use strict';

// The Done HDD page (library.html): what's on the Library HDD, oldest first,
// and — once it's past its limit (libraryFull.startAtPercent, 90%) — which
// projects to move to the Archive to bring it back down to
// libraryFull.targetPercent (70%).
//
// One request fills the page: GET /api/library. It works with the Library
// unplugged too: then it shows the last scan's list and how full it was then.

// eslint-disable-next-line no-unused-vars
function libraryPage() {
  const { api, formatBytes, formatPercent, formatDateTime, formatAgo, plural } = Dashboard;
  // "74% full", or "more than full" past 100% (the projects wouldn't fit at all).
  const full = (percent) => (percent > 100 ? 'more than full' : `${formatPercent(percent)} full`);
  return {
    ...Dashboard.helpers,
    data: null,
    error: null,

    async init() {
      try {
        this.data = await api('/api/library');
      } catch (error) {
        this.error = error.message;
      }
    },

    lastScannedText() {
      const scan = this.data.lastScan;
      const when = scan ? ` · last scanned ${formatDateTime(scan.at)} (${formatAgo(scan.at)})` : ' · never scanned';
      return this.data.spaceIsLastKnown ? `${when} — the space shown is from then` : when;
    },

    bannerTitle() {
      const { plan, limitPercent } = this.data;
      return plan.status === 'full-now'
        ? `The Library HDD is past its ${limitPercent}% limit: ${formatPercent(plan.usedPercent)} full.`
        : `The projects ready on the SSD would take the Library HDD past its ${limitPercent}% limit.`;
    },

    bannerText() {
      const { plan, targetPercent, ready, spaceIsLastKnown } = this.data;
      const asOf = spaceIsLastKnown ? ' (as of its last scan)' : '';
      if (plan.moves.length === 0) return `It needs about ${formatBytes(plan.bytesToFree)} moved to the Archive${asOf}.`;
      const what = `Move ${plan.moves.length === 1 ? 'this project' : `these ${plan.moves.length} projects`} ` +
        `(${formatBytes(plan.movesBytes)}, oldest first) to the Archive HDD`;
      if (plan.status === 'full-now') return `${what} to bring it down to ${targetPercent}%${asOf}:`;
      return `Moving the ${plural(ready.count, 'ready project')} (${formatBytes(ready.bytes)}) would make it ` +
        `${full(plan.percentAfterIncoming)}${asOf}. To make room first, ${what.charAt(0).toLowerCase()}${what.slice(1)}:`;
    },

    afterText() {
      const { plan, ready } = this.data;
      const after = `Afterwards it would be ${full(plan.percentAfterMoves)}`;
      if (plan.status === 'full-now' && ready.count > 0) {
        return `${after}, and ${full(plan.percentAfterIncoming)} once the ${plural(ready.count, 'ready project')} ` +
          `(${formatBytes(ready.bytes)}) from the SSD arrive.`;
      }
      return plan.status === 'full-after' ? `${after}, with the ready projects moved in.` : `${after}.`;
    },

    archiveText() {
      const { archive } = this.data;
      if (!archive.configured) return 'No Archive HDD is set up (drives.archive in config.json).';
      if (!archive.connected) return 'The Archive HDD isn\'t connected: plug it in to check it has room.';
      const fits = archive.space.freeBytes >= this.data.plan.movesBytes;
      return `The Archive HDD has ${formatBytes(archive.space.freeBytes)} free${fits ? ' — plenty of room.' : ': not enough room for all of these.'}`;
    },

    roomText() {
      const { plan, limitPercent, ready } = this.data;
      const room = `${formatBytes(plan.roomBeforeLimitBytes)} of room before the ${limitPercent}% limit`;
      return ready.count > 0
        ? `Nothing needs to move to the Archive. After the ${plural(ready.count, 'ready project')} from the SSD arrive, there's still ${room}.`
        : `Nothing needs to move to the Archive: ${formatPercent(plan.usedPercent)} full, ${room}.`;
    },

    openProject(event, project) {
      if (event.target.closest('a, button')) return;
      location.href = `project.html?id=${project.id}`;
    },
  };
}
