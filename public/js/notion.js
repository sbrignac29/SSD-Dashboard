'use strict';

// The Link to Notion page (notion.html): match each project folder to its
// page on the Notion Projects board, one Confirm at a time.
//
//   GET  /api/notion/links   the folders (each with its top 3 suggestions) and every Notion page
//   POST /api/notion/links   Confirm / No Notion page / back to "not linked yet"
//   POST /api/notion/sync    the Refresh Notion button
//
// Nothing is linked until you press Confirm. The best suggestion is picked in
// advance only when it's a likely match; you can pick another, or any page
// from the dropdown.
//
// notion.html?id=12 shows just that project (the project page's "Change" link).

// eslint-disable-next-line no-unused-vars
function notionPage() {
  const { api } = Dashboard;
  const params = new URLSearchParams(location.search);
  return {
    ...Dashboard.helpers,
    data: null,
    error: null,
    show: params.get('show') ?? 'todo',
    // '*' = all folders, '' = top-level folders only, else a container name
    client: params.has('client') ? params.get('client') : '*',
    singleId: params.get('id'),
    tabs: [
      { id: 'todo', label: 'Not linked yet' },
      { id: 'linked', label: 'Linked' },
      { id: 'none', label: 'No Notion page' },
    ],
    choices: {}, // project id -> the Notion page picked for it
    opened: {}, // project id -> true while changing an existing link
    busy: false,
    syncing: false,
    message: null,
    undoIds: [],

    async init() {
      await this.load();
    },

    query() {
      const query = new URLSearchParams();
      if (this.singleId) {
        query.set('id', this.singleId);
        return query.toString();
      }
      query.set('show', this.show);
      if (this.client !== '*') query.set('client', this.client);
      return query.toString();
    },

    async load() {
      try {
        const data = await api(`/api/notion/links?${this.query()}`);
        // Keep what you'd already picked; pre-pick the likely matches for the rest.
        const choices = {};
        for (const row of data.rows) {
          const top = row.suggestions[0];
          choices[row.id] = this.choices[row.id] ?? (top && top.likely && row.link.state === null ? top.pageId : '');
        }
        this.choices = choices;
        this.data = data;
        this.syncing = data.notion.syncing;
        this.error = null;
      } catch (error) {
        this.error = error.message;
      }
    },

    setShow(show) {
      this.show = show;
      this.filtersChanged();
    },

    filtersChanged() {
      this.opened = {};
      history.replaceState(null, '', `?${this.query()}`);
      this.load();
    },

    isOpen(row) {
      return this.singleId !== null || this.opened[row.id] === true;
    },

    openPicker(row) {
      this.opened = { ...this.opened, [row.id]: true };
    },

    // One folder: 'confirm' (the picked page), 'none' or 'clear'.
    async act(row, action) {
      await this.send([row.id], action, action === 'confirm' ? this.choices[row.id] : null, row.link.state === null);
      if (this.singleId && !this.error) location.href = `project.html?id=${row.id}`;
    },

    // "No Notion page" in one go for one container's folders (the football
    // games, the soccer sessions) — but never for a folder with a likely
    // match: confirm or reject those one by one first.
    unlikelyRows() {
      return this.data.rows.filter((row) => !row.suggestions[0]?.likely);
    },

    canMarkAll() {
      return this.show === 'todo' && this.client !== '*' && this.client !== '' && this.unlikelyRows().length > 1;
    },

    markAllLabel() {
      const n = this.unlikelyRows().length;
      return n === this.data.rows.length ? `No Notion page for all ${n} shown` : `No Notion page for the ${n} without a likely match`;
    },

    async markAllNone() {
      const ids = this.unlikelyRows().map((row) => row.id);
      if (!confirm(`Mark ${ids.length} folders in ${this.client} as "No Notion page"? You can undo this.`)) return;
      await this.send(ids, 'none', null, true);
    },

    async undo() {
      await this.send(this.undoIds, 'clear', null, false);
    },

    async send(projectIds, action, pageId, canUndo) {
      this.busy = true;
      try {
        const answer = await api('/api/notion/links', { method: 'POST', body: { projectIds, action, pageId } });
        this.message = answer.message;
        // Undo puts them back on the "not linked yet" list, which is where they came from.
        this.undoIds = canUndo && action !== 'clear' ? projectIds : [];
        for (const id of projectIds) delete this.choices[id];
        this.opened = {};
        await this.load();
      } catch (error) {
        this.message = error.message;
        this.undoIds = [];
      } finally {
        this.busy = false;
      }
    },

    async refreshNotion() {
      this.syncing = true;
      try {
        const answer = await api('/api/notion/sync', { method: 'POST' });
        this.message = answer.message;
        this.undoIds = [];
        await this.load();
      } catch (error) {
        this.message = error.message;
      } finally {
        this.syncing = false;
      }
    },
  };
}
