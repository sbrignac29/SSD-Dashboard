'use strict';

// The project page (project.html?id=12): why a project got its tag (including
// "Done in Notion"), the score part by part, its Notion page, its size by file
// type, its folder tree, and the Pin button.
//
// The "?id=12" part of the address says which project; the page asks the
// server for it with GET /api/projects/12, and the Pin button sends
// POST /api/projects/12/pin.

// eslint-disable-next-line no-unused-vars
function projectPage() {
  const { api } = Dashboard;
  return {
    ...Dashboard.helpers,
    sizeRows: Dashboard.sizeRows,
    id: new URLSearchParams(location.search).get('id'),
    data: null,
    error: null,
    pinBusy: false,
    pinMessage: null,

    async init() {
      if (!this.id) {
        this.error = 'No project chosen. Pick one from the Overview.';
        return;
      }
      await this.load();
      Dashboard.onThemeChange(() => this.draw());
    },

    async load() {
      try {
        this.data = await api(`/api/projects/${encodeURIComponent(this.id)}`);
        document.title = `${this.data.project.name} · SSD Offload`;
        this.error = null;
        this.$nextTick(() => this.draw());
      } catch (error) {
        this.error = error.message;
      }
    },

    draw() {
      if (!this.data) return;
      Dashboard.renderSizeChart(this.$refs.sizeChart, this.data.project.bytesByType);
      Dashboard.renderFolderTree(this.$refs.tree, this.data.tree, this.data.project.sizeBytes);
      // Open the biggest folder, so the tree shows its shape straight away.
      this.$refs.tree?.querySelector('details')?.setAttribute('open', '');
    },

    async togglePin() {
      this.pinBusy = true;
      try {
        const answer = await api(`/api/projects/${encodeURIComponent(this.id)}/pin`, { method: 'POST' });
        this.pinMessage = answer.message;
        await this.load();
      } catch (error) {
        this.pinMessage = error.message;
      } finally {
        this.pinBusy = false;
      }
    },

    backLink() {
      // Back to the page you came from (keeps its filters), or the Overview.
      if (document.referrer && new URL(document.referrer).origin === location.origin) return document.referrer;
      return this.data?.project.drive === 'library' ? 'library.html' : '/';
    },

    backText() {
      return this.data?.project.drive === 'library' ? '← Done HDD' : '← All projects';
    },

    checkMark(state) {
      return { pass: '✓', fail: '✗', na: '–', info: 'i' }[state];
    },

    checkWord(state) {
      return { pass: 'Yes', fail: 'No', na: "Doesn't apply yet", info: 'Note' }[state];
    },

    exportText() {
      const p = this.data.project;
      if (p.hasFinalExport) return `Final — ${p.finalExportFile}`;
      if (p.hasExport) return `Drafts only — e.g. ${p.exportExampleFile}`;
      return 'None found in this folder';
    },

    // When the Notion facts are from, and a warning if the page has gone.
    notionSyncText() {
      const n = this.data.notion;
      if (n.pageGone) {
        return "This page wasn't in the last sync (deleted in Notion, or no longer shared): the status shown is the last one read.";
      }
      return n.syncedAt ? `As of the Notion sync on ${Dashboard.formatDateTime(n.syncedAt)}` : '';
    },

    chartLabel() {
      const rows = Dashboard.sizeRows(this.data?.project.bytesByType);
      return `Size by file type: ${rows.map((r) => `${r.label} ${Dashboard.formatBytes(r.bytes)}`).join(', ')}`;
    },
  };
}
