'use strict';

// The Moves page (moves.html): the Recent jobs list. Every move you started,
// newest first, with live progress for the ones still running (copying %,
// verifying %, time left), and what happened to the others.
//
// The list comes from the dashboard's database (archive_log), not from
// VeriCopy: VeriCopy forgets its jobs when it quits, the dashboard doesn't.
// While a move runs, the page asks GET /api/moves every 2 seconds; the
// server asks VeriCopy (the page never talks to VeriCopy itself).

// Shared with the project page: the buttons on one move's card.
// eslint-disable-next-line no-unused-vars
function moveCardActions() {
  const { api } = Dashboard;
  return {
    actionBusy: null,
    actionMessage: {},

    async cancelMove(move) {
      if (!confirm(`Cancel copying “${move.projectName}”? Files already copied stay at the destination; you'd delete that partial folder in Finder.`)) return;
      await this.moveAction(move, 'cancel');
    },

    async recheckMove(move) {
      await this.moveAction(move, 'recheck');
    },

    async moveAction(move, action) {
      this.actionBusy = move.id;
      try {
        const answer = await api(`/api/moves/${move.id}/${action}`, { method: 'POST', allow: [409] });
        this.actionMessage = { ...this.actionMessage, [move.id]: answer.message };
        await this.loadMoves();
      } catch (error) {
        this.actionMessage = { ...this.actionMessage, [move.id]: error.message };
      } finally {
        this.actionBusy = null;
      }
    },

    spotCheckText(move) {
      const check = move.spotCheck;
      if (!check?.source || !check?.destination) return '';
      const side = (s) => `${Dashboard.plural(s.files, 'file')}, ${Dashboard.formatBytes(s.bytes)}`;
      return `Original: ${side(check.source)} · Copy: ${side(check.destination)}`;
    },
  };
}

// eslint-disable-next-line no-unused-vars
function movesPage() {
  const { api } = Dashboard;
  return {
    ...Dashboard.helpers,
    ...moveCardActions(),
    data: null,
    vericopy: null,
    error: null,

    async init() {
      await Promise.all([this.loadMoves(), this.loadVericopy()]);
      Dashboard.poll(() => this.loadMoves(), () => (this.data?.activeCount ?? 0) > 0);
    },

    async loadMoves() {
      try {
        this.data = await api('/api/moves');
        this.error = null;
      } catch (error) {
        this.error = error.message;
      }
    },

    async loadVericopy() {
      try {
        this.vericopy = await api('/api/vericopy');
      } catch (error) {
        this.vericopy = { running: false, message: error.message };
      }
    },
  };
}
