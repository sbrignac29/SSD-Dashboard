'use strict';

// The Settings page (settings.html): change the app's settings without
// opening config.json.
//
// GET /api/settings sends every setting the page can change, grouped in
// sections, each with its current value and its config.json value. The page
// keeps a `form` copy you edit; Save sends only the settings you changed
// (POST /api/settings), and the server checks them all (the same checks as
// config.json) before saving anything. If something's wrong, nothing is saved
// and the message says what to fix.

// eslint-disable-next-line no-unused-vars
function settingsPage() {
  const { api } = Dashboard;

  // How a value is shown in the form: lists as one item per line.
  const toForm = (field, value) => (field.type === 'list' ? (value ?? []).join('\n') : value);
  // ... and back, for comparing and sending.
  const fromForm = (field, value) => {
    if (field.type === 'list') {
      return String(value ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    }
    if (field.type === 'number') return value === '' || value === null ? null : Number(value);
    return field.type === 'text' ? String(value ?? '').trim() : value;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  return {
    ...Dashboard.helpers,
    data: null,
    form: {},
    error: null,
    notice: null,
    busy: false,
    // Counts loads: the rows' keys include it, so after a save every row is
    // drawn fresh from the server's answer (no leftover "Not saved yet").
    loads: 0,

    async init() {
      try {
        this.load(await api('/api/settings'));
      } catch (error) {
        this.error = error.message;
      }
      // Leaving with unsaved changes? The browser asks first.
      window.addEventListener('beforeunload', (event) => {
        if (this.dirty()) event.preventDefault();
      });
    },

    // Shows the server's answer and resets the form to it.
    load(settings) {
      this.data = settings;
      const form = {};
      for (const field of this.fields()) form[field.key] = toForm(field, field.value);
      this.form = form;
      this.loads += 1;
    },

    fields() {
      return this.data ? this.data.sections.flatMap((section) => section.fields) : [];
    },

    inputId(field) {
      return `setting-${field.key.replace(/\./g, '-')}`;
    },

    lineCount(text) {
      return String(text ?? '').split('\n').length;
    },

    // True when the form differs from what's saved.
    isEdited(field) {
      return !same(fromForm(field, this.form[field.key]), field.value);
    },

    editedFields() {
      return this.fields().filter((field) => this.isEdited(field));
    },

    editedCount() {
      return this.editedFields().length;
    },

    dirty() {
      return this.editedCount() > 0;
    },

    // A value as short text, e.g. for "config.json: 14".
    describe(field, value) {
      if (field.type === 'list') return value.length === 0 ? '(empty)' : value.join(', ');
      if (field.type === 'boolean') return value ? 'on' : 'off';
      if (value === '') return '(empty)';
      return field.unit ? `${value} ${field.unit}` : String(value);
    },

    // Puts config.json's value in the form (saved with the next Save).
    useFileValue(field) {
      this.form[field.key] = toForm(field, field.fileValue);
    },

    weightsTotal() {
      return ['weights.done', 'weights.age', 'weights.size'].reduce((sum, key) => sum + (Number(this.form[key]) || 0), 0);
    },

    weightsOk() {
      return Math.abs(this.weightsTotal() - 1) <= 0.001;
    },

    weightsText() {
      const total = this.weightsTotal().toFixed(2);
      return this.weightsOk() ? `The weights add up to ${total}. ✓` : `The weights add up to ${total}: they must add up to 1.00.`;
    },

    discard() {
      this.load(this.data);
      this.error = null;
    },

    async save() {
      const values = {};
      for (const field of this.editedFields()) values[field.key] = fromForm(field, this.form[field.key]);
      if (Object.keys(values).length === 0) return;
      await this.send('/api/settings', { values });
    },

    async resetAll() {
      const ok = window.confirm(
        'Forget every change saved on this page and use config.json for everything?\n(config.json itself is not changed.)',
      );
      if (ok) await this.send('/api/settings/reset', {});
    },

    async send(path, body) {
      this.busy = true;
      this.error = null;
      this.notice = null;
      try {
        const answer = await api(path, { method: 'POST', body });
        this.load(answer.settings);
        this.notice = this.describeOutcome(answer);
      } catch (error) {
        // Nothing was saved: keep what you typed, so you can fix it.
        this.error = error.message;
      } finally {
        this.busy = false;
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    describeOutcome({ changed, needsScan }) {
      if (changed.length === 0) return { title: 'Saved.', text: 'Nothing actually changed.', needsScan: false };
      const text = needsScan
        ? 'Scores and drive limits already use the new settings. Folder, file-type and Working SSD changes apply at the next scan.'
        : 'The dashboard already uses the new settings.';
      return { title: `Saved ${this.plural(changed.length, 'change')}.`, text, needsScan };
    },
  };
}
