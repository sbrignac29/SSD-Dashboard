'use strict';

// The Overview page (index.html): headline, Scan now, drives, the project
// table with filters, and the size chart.
//
// overviewPage() returns an Alpine "component": an object whose values the
// HTML shows (x-text="summary.ready.count") and whose functions the buttons
// call (@click="startScan()"). When a value changes, Alpine updates the page.
//
// Everything on the page comes from the server:
//   GET  /api/summary    the headline numbers
//   GET  /api/drives     the three drive cards
//   GET  /api/projects   the table (with the filters in the address)
//   POST /api/scan       the Scan now button; then GET /api/scan for progress
//   GET  /api/notion     "Notion: connected / not connected"
//   POST /api/notion/sync  the Refresh Notion button

// eslint-disable-next-line no-unused-vars
function overviewPage() {
  const { api } = Dashboard;
  // The order tags sort in: what to act on first.
  const TAG_ORDER = { ready: 0, check: 1, keep: 2, pinned: 3 };

  return {
    ...Dashboard.helpers,
    sizeRows: Dashboard.sizeRows,
    error: null,
    summary: null,
    drives: [],
    list: null,
    scan: { running: false, percent: 0, message: '', outcome: null, finishedAt: null },
    scanNote: null, // a one-off message, e.g. "plug in a drive"
    notion: null,
    notionBusy: false,
    notionNote: null,
    // notion: '' (all) | 'unlinked' | 'no-page' | 'status:Done' (a Notion status)
    filters: { tag: '', client: '*', from: '', to: '', notion: '' },
    sort: { key: 'tag', dir: 'asc' },
    columns: [
      { key: 'name', label: 'Project' },
      { key: 'client', label: 'Client' },
      { key: 'size', label: 'Size', right: true },
      { key: 'lastEdited', label: 'Last edited' },
      { key: 'status', label: 'Status' },
      { key: 'tag', label: 'Tag' },
    ],

    // Alpine calls init() once when the page starts. It only READS: starting
    // the page never starts a scan.
    async init() {
      this.readFiltersFromAddress();
      await Promise.all([this.loadSummary(), this.loadDrives(), this.loadProjects(), this.loadNotion(), this.checkScan()]);
      Dashboard.onThemeChange(() => this.drawChart());
      // Notice drives being plugged in or out: re-check them when you come
      // back to the tab, and every 30 seconds.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.loadDrives();
      });
      setInterval(() => this.loadDrives(), 30000);
    },

    async load(what) {
      try {
        await what();
        this.error = null;
      } catch (error) {
        this.error = error.message;
      }
    },

    loadSummary() {
      return this.load(async () => {
        this.summary = await api('/api/summary');
      });
    },

    loadDrives() {
      return this.load(async () => {
        this.drives = (await api('/api/drives')).drives;
      });
    },

    loadNotion() {
      return this.load(async () => {
        this.notion = await api('/api/notion');
      });
    },

    // Reads Notion now (a few seconds). Problems aren't errors: the answer
    // says "not connected" and why, and the saved statuses stay in use.
    async refreshNotion() {
      this.notionBusy = true;
      this.notionNote = null;
      try {
        const answer = await api('/api/notion/sync', { method: 'POST' });
        this.notion = answer.notion;
        this.notionNote = answer.message;
        await Promise.all([this.loadSummary(), this.loadProjects()]);
      } catch (error) {
        this.notionNote = error.message;
      } finally {
        this.notionBusy = false;
      }
    },

    loadProjects() {
      return this.load(async () => {
        this.list = await api(`/api/projects?${this.filterParams()}`);
        // Draw after Alpine has shown the chart's card.
        this.$nextTick(() => this.drawChart());
      });
    },

    drawChart() {
      if (this.list && this.list.totals.count > 0) Dashboard.renderSizeChart(this.$refs.sizeChart, this.list.totals.byType);
    },

    chartLabel() {
      if (!this.list) return '';
      const rows = Dashboard.sizeRows(this.list.totals.byType);
      return `Size by file type: ${rows.map((r) => `${r.label} ${Dashboard.formatBytes(r.bytes)}`).join(', ')}`;
    },

    // --- Headline ----------------------------------------------------------

    libraryLine() {
      const lib = this.summary.library;
      if (!lib.configured) return '';
      if (!lib.known) return "Plug in the Library HDD to check they'll fit on it.";
      const asOf = lib.lastKnown ? ' (as of its last scan)' : '';
      if (lib.fits === false) return `They don't all fit on the Library HDD${asOf}: ${Dashboard.formatBytes(lib.shortBytes)} short.`;
      return `They fit on the Library HDD${asOf}: it would be ${Dashboard.formatPercent(lib.percentAfter)} full.`;
    },

    showOnly(tag) {
      this.setTag(tag);
      document.getElementById('projects').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    // --- Scan now ------------------------------------------------------------

    async startScan() {
      this.scanNote = null;
      try {
        // Answers "started", or why not (already running, nothing plugged in).
        const status = await api('/api/scan', { method: 'POST' });
        this.scan = status;
        if (status.running) this.followScan();
        else if (status.outcome === 'nothing-connected') this.scanNote = status.message;
      } catch (error) {
        this.scanNote = error.message;
      }
    },

    // A scan already running (another tab, or the nightly scan) shows here too.
    async checkScan() {
      try {
        this.scan = await api('/api/scan');
        if (this.scan.running) this.followScan();
      } catch {
        // The other loads report problems.
      }
    },

    // Asks the server how the scan is going, twice a second, until it's done.
    followScan() {
      const tick = async () => {
        try {
          this.scan = await api('/api/scan');
        } catch (error) {
          this.scanNote = error.message;
          return;
        }
        if (this.scan.running) {
          setTimeout(tick, 500);
        } else {
          await Promise.all([this.loadSummary(), this.loadDrives(), this.loadProjects(), this.loadNotion()]);
        }
      };
      setTimeout(tick, 500);
    },

    scanMessage() {
      if (this.scanNote) return this.scanNote;
      if (this.scan.running) return this.scan.message;
      if (!this.scan.outcome || this.scan.outcome === 'nothing-connected') return '';
      const prefix = { saved: 'Done.', partly: 'Partly done.', failed: "The scan didn't finish." }[this.scan.outcome] ?? '';
      return `${prefix} ${this.scan.message}`;
    },

    // --- Filters (kept in the address, so Back and bookmarks keep them) -------

    readFiltersFromAddress() {
      const params = new URLSearchParams(location.search);
      this.filters.tag = params.get('tag') ?? '';
      this.filters.client = params.has('client') ? params.get('client') : '*';
      this.filters.from = params.get('from') ?? '';
      this.filters.to = params.get('to') ?? '';
      this.filters.notion = params.has('status') ? `status:${params.get('status')}` : (params.get('notion') ?? '');
    },

    filterParams() {
      const params = new URLSearchParams();
      if (this.filters.tag) params.set('tag', this.filters.tag);
      if (this.filters.client !== '*') params.set('client', this.filters.client);
      if (this.filters.from) params.set('from', this.filters.from);
      if (this.filters.to) params.set('to', this.filters.to);
      if (this.filters.notion.startsWith('status:')) params.set('status', this.filters.notion.slice('status:'.length));
      else if (this.filters.notion) params.set('notion', this.filters.notion);
      return params.toString();
    },

    filtersChanged() {
      const query = this.filterParams();
      history.replaceState(null, '', query ? `?${query}` : location.pathname);
      this.loadProjects();
    },

    setTag(tag) {
      this.filters.tag = tag;
      this.filtersChanged();
    },

    hasFilters() {
      const { tag, client, from, to, notion } = this.filters;
      return tag !== '' || client !== '*' || from !== '' || to !== '' || notion !== '';
    },

    clearFilters() {
      this.filters = { tag: '', client: '*', from: '', to: '', notion: '' };
      this.filtersChanged();
    },

    tagTotal() {
      return Object.values(this.list.tagCounts).reduce((a, b) => a + b, 0);
    },

    tagLabel(id) {
      return this.list?.tags.find((t) => t.id === id)?.label ?? id;
    },

    // --- Sorting (in the browser: instant) -------------------------------------

    sortBy(key) {
      if (this.sort.key === key) this.sort.dir = this.sort.dir === 'asc' ? 'desc' : 'asc';
      else this.sort = { key, dir: key === 'size' || key === 'lastEdited' ? 'desc' : 'asc' };
    },

    sortedProjects() {
      if (!this.list) return [];
      const { key, dir } = this.sort;
      const sign = dir === 'asc' ? 1 : -1;
      const text = (value) => (value ?? '').toLocaleLowerCase();
      const compare = {
        name: (a, b) => text(a.name).localeCompare(text(b.name)),
        // No client sorts last either way.
        client: (a, b) => (!a.client - !b.client) * sign || text(a.client).localeCompare(text(b.client)),
        size: (a, b) => a.sizeBytes - b.sizeBytes,
        lastEdited: (a, b) => Date.parse(a.lastEdited ?? 0) - Date.parse(b.lastEdited ?? 0),
        status: (a, b) => text(a.status).localeCompare(text(b.status)),
        // Ready first; within Ready the biggest first (frees the most space),
        // otherwise the highest score first.
        tag: (a, b) =>
          TAG_ORDER[a.tag] - TAG_ORDER[b.tag] ||
          (a.tag === 'ready' ? b.sizeBytes - a.sizeBytes : (b.score ?? 0) - (a.score ?? 0)),
      }[key];
      return [...this.list.projects].sort((a, b) => sign * compare(a, b) || text(a.name).localeCompare(text(b.name)));
    },

    // The Status cell's tooltip: which Notion page it comes from.
    statusTitle(project) {
      if (project.notionLink === 'confirmed') return `Notion page: ${project.notionTitle}`;
      if (project.notionLink === 'none') return 'You marked it: no Notion page';
      return 'Not linked to a Notion page yet';
    },

    // A click anywhere on a row opens the project (the name is also a link).
    openProject(event, project) {
      if (event.target.closest('a, button')) return;
      location.href = `project.html?id=${project.id}`;
    },
  };
}
