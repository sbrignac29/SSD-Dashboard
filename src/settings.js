'use strict';

// The dashboard's Settings page: which settings it can change, checking what
// you type, and combining the saved changes with config.json.
//
// Settings are stacked in three layers, each overriding the one before:
//   1. config.example.json  – the defaults that ship with the app
//   2. config.json          – your own copy (you edit it in a text editor)
//   3. the Settings page    – saved in data/dashboard.db (the `settings` table)
//
// SAFETY: the Settings page never edits config.json (the app only ever
// writes inside data/). It stores just the values you changed there, so
// anything you didn't touch keeps following config.json.
//
// Every command uses the same three layers (loadAppConfig below), so
// `npm run scan` and the dashboard always agree.

const fs = require('node:fs');
const { loadConfig, validateConfig, assertSafeLocations, ConfigError } = require('./config');
const { openDatabase, readSavedSettings, writeSavedSettings, DEFAULT_DB_PATH } = require('./db');

// A problem with what was typed on the Settings page (the server answers 400).
class SettingsError extends Error {}

// What happens after a change:
//   now     – used straight away (drive bars, the Done HDD page)
//   rescore – scores are recalculated as soon as you save
//   scan    – takes effect at the next Scan now (the scan has to look again)
const EFFECTS = {
  now: 'Applies right away',
  rescore: 'Applies right away (scores are recalculated)',
  scan: 'Applies at the next Scan now',
};

// Every setting the page can change, grouped into the page's sections.
//   key    – where it lives in the settings, e.g. "ageDays.recent"
//   type   – text | number | list (of text)
//   saveAs – settings that only make sense together (the three weights must
//            add up to 1) are saved as one group, so a later config.json edit
//            can't leave them half from one place and half from the other
const SECTIONS = [
  {
    id: 'drives',
    title: 'Drives',
    intro: 'Where each drive is mounted. In Finder, the drive’s name under /Volumes.',
    fields: [
      {
        key: 'drives.working',
        label: 'Working SSD',
        type: 'text',
        effect: 'scan',
        help:
          'Pointing this at a different drive makes the projects from the old one show as "no longer on the SSD" ' +
          'after the next scan (nothing is deleted; they come back if you switch back).',
      },
      { key: 'drives.library', label: 'Library HDD (Done HDD)', type: 'text', effect: 'now', help: 'Leave empty if you don’t have one.' },
      { key: 'drives.archive', label: 'Archive HDD', type: 'text', effect: 'now', help: 'Leave empty if you don’t have one.' },
    ],
  },
  {
    id: 'libraryFull',
    title: 'Done HDD limits (Move 2)',
    intro: 'When the Library HDD gets this full, the Done HDD page lists the oldest projects to move to the Archive.',
    fields: [
      {
        key: 'libraryFull.startAtPercent',
        saveAs: 'libraryFull',
        label: 'Start moving to the Archive at',
        type: 'number',
        unit: '% full',
        min: 1,
        max: 100,
        step: 1,
        effect: 'now',
      },
      {
        key: 'libraryFull.targetPercent',
        saveAs: 'libraryFull',
        label: 'Move projects until it’s down to',
        type: 'number',
        unit: '% full',
        min: 0,
        max: 99,
        step: 1,
        effect: 'now',
        help: 'Must be lower than the start percentage.',
      },
    ],
  },
  {
    id: 'scoring',
    title: 'Scoring (Move 1)',
    intro: 'How projects on the Working SSD are ranked: Score = Done weight × Done + Age weight × Age + Size weight × Size.',
    fields: [
      {
        key: 'ageDays.recent',
        saveAs: 'ageDays',
        label: 'Untouched for this long before “Ready”',
        type: 'number',
        unit: 'days',
        min: 0,
        step: 1,
        effect: 'rescore',
        help: 'A finished project edited more recently than this stays “Check first”. The Age part is 0 until then.',
      },
      {
        key: 'ageDays.max',
        saveAs: 'ageDays',
        label: 'Age part reaches 100 at',
        type: 'number',
        unit: 'days',
        min: 1,
        step: 1,
        effect: 'rescore',
      },
      { key: 'weights.done', saveAs: 'weights', label: 'Done weight', type: 'number', min: 0, max: 1, step: 0.05, effect: 'rescore' },
      { key: 'weights.age', saveAs: 'weights', label: 'Age weight', type: 'number', min: 0, max: 1, step: 0.05, effect: 'rescore' },
      {
        key: 'weights.size',
        saveAs: 'weights',
        label: 'Size weight',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        effect: 'rescore',
        help: 'The three weights must add up to 1.',
      },
      {
        key: 'buckets.review',
        label: 'Unfinished projects become “Check first” from score',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        effect: 'rescore',
      },
      {
        key: 'doneStatuses',
        label: 'Notion statuses that mean “done”',
        type: 'list',
        effect: 'rescore',
        help: 'One per line. Used once Notion is connected (Phase 4).',
      },
    ],
  },
  {
    id: 'folders',
    title: 'Folders',
    intro: 'Folder names at the top of the drive, one per line (upper/lower case doesn’t matter). A container’s shoot is written "Container/Shoot".',
    fields: [
      {
        key: 'folders.containers',
        label: 'Containers (each subfolder is its own project)',
        type: 'list',
        effect: 'scan',
        help: 'E.g. NCHS Football: every shoot inside it is listed as NCHS Football / <shoot>.',
      },
      {
        key: 'folders.shared',
        label: 'Shared folders (measured, never ranked)',
        type: 'list',
        effect: 'scan',
        help: 'Folders used by many projects, e.g. Resolve Project Library.',
      },
      { key: 'folders.ignore', label: 'Ignore completely', type: 'list', effect: 'scan' },
      {
        key: 'folders.keepPinned',
        label: 'Always keep on the SSD (pinned)',
        type: 'list',
        effect: 'rescore',
        help: 'Same as the Pin button. Pinning a container pins every shoot in it.',
      },
    ],
  },
  {
    id: 'fileTypes',
    title: 'File types (advanced)',
    intro:
      'How files are sorted into raw, proxy, export, cache and project files, and which exports count as “final”. ' +
      'Extensions start with a dot; words match whole words in file and folder names. One per line.',
    advanced: true,
    fields: [
      ['projectExtensions', 'Project file extensions', 'Their last save is the project’s “last edited” date.'],
      ['videoExtensions', 'Video extensions'],
      ['photoExtensions', 'Photo extensions'],
      ['audioExtensions', 'Audio extensions'],
      ['proxyExtensions', 'Proxy extensions'],
      ['cacheExtensions', 'Cache extensions'],
      ['cacheFolderWords', 'Cache folder words'],
      ['proxyFolderWords', 'Proxy folder words'],
      ['proxyFileWords', 'Proxy file-name words'],
      ['exportFolderWords', 'Export folder words'],
      ['exportFileWords', 'Export file-name words'],
      ['finalExportWords', 'Final export words', 'An export with one of these in its name means the project is finished.'],
      ['notFinalWords', 'Not-final words', 'Names or folders with these are drafts, even with “Final” in the name.'],
    ].map(([name, label, help]) => ({ key: `fileTypes.${name}`, label, type: 'list', effect: 'scan', help })),
  },
];

const FIELDS = SECTIONS.flatMap((section) => section.fields);
const FIELDS_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));
// The names the settings are saved under ("weights", "drives.working", ...).
const SAVE_KEYS = [...new Set(FIELDS.map((field) => field.saveAs ?? field.key))];

// Shown on the page, but only changed in config.json: they're used when
// npm start begins, and opening the dashboard to other devices on your Wi-Fi
// should be a deliberate edit, not a click.
const FIXED = [
  { key: 'server.port', label: 'Dashboard port' },
  { key: 'server.host', label: 'Who can open the dashboard', describe: (v) => (v === '0.0.0.0' ? `${v} (this Mac and your phone)` : `${v} (this Mac only)`) },
];

// --- Small helpers -----------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A deep copy of plain settings (objects, lists, text, numbers, true/false).
function clone(value) {
  return structuredClone(value);
}

// getPath(config, 'ageDays.recent') -> config.ageDays.recent
function getPath(object, dotted) {
  return dotted.split('.').reduce((current, part) => (isPlainObject(current) ? current[part] : undefined), object);
}

function setPath(object, dotted, value) {
  const parts = dotted.split('.');
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Combining the layers ----------------------------------------------------

// Only the saved names this version of the app knows (an older or newer
// version may have saved others; they're kept in the database but not used).
function knownOverrides(overrides) {
  return Object.fromEntries(SAVE_KEYS.filter((key) => key in overrides).map((key) => [key, overrides[key]]));
}

// The file settings (layers 1 + 2) with the Settings page's changes on top,
// not checked yet.
function mergeOverrides(fileConfig, overrides) {
  const config = clone(fileConfig);
  for (const [key, value] of Object.entries(knownOverrides(overrides))) setPath(config, key, clone(value));
  return config;
}

// The same, checked. Throws a ConfigError if the result isn't valid (e.g.
// config.json was edited since, and a saved value no longer fits with it).
function applyOverrides(fileConfig, overrides) {
  const config = mergeOverrides(fileConfig, overrides);
  try {
    validateConfig(config);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ConfigError(
      `${error.message}\n` +
        'Some settings were changed on the dashboard’s Settings page. Open it (npm start, then Settings) to fix them there, ' +
        'or press "Use config.json for everything" on that page.',
    );
  }
  return config;
}

function describeSource(fileSource, overrides) {
  const count = Object.keys(knownOverrides(overrides)).length;
  if (count === 0) return fileSource;
  return `${fileSource} + ${count} change${count === 1 ? '' : 's'} from the Settings page`;
}

// The Settings page's saved changes, read from data/dashboard.db without
// changing it. No database yet, or one from before the Settings page
// (it gets upgraded by the next `npm run scan` / `npm start`) = no changes.
function readOverridesFromDisk() {
  if (!fs.existsSync(DEFAULT_DB_PATH)) return {};
  let db;
  try {
    db = openDatabase({ readonly: true });
  } catch (error) {
    if (error.outdated) return {};
    throw error;
  }
  try {
    return readSavedSettings(db).overrides;
  } finally {
    db.close();
  }
}

// What the commands use instead of config.js → loadConfig(): all three layers.
// Returns { config, source } like loadConfig().
//   db – an already open database (the server); otherwise data/dashboard.db is
//        opened read-only just long enough to read the saved changes
function loadAppConfig({ db = null, loadFileConfig = loadConfig } = {}) {
  const file = loadFileConfig();
  const overrides = db ? readSavedSettings(db).overrides : readOverridesFromDisk();
  return { config: applyOverrides(file.config, overrides), source: describeSource(file.source, overrides) };
}

// --- Checking what was typed -------------------------------------------------

// Turns one typed value into the right kind of value, or explains why it can't.
function parseValue(field, raw) {
  const label = `"${field.label}" (${field.key})`;
  switch (field.type) {
    case 'text':
      if (typeof raw !== 'string') throw new SettingsError(`${label} must be text.`);
      return raw.trim();
    case 'number': {
      const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new SettingsError(`${label} must be a number.`);
      return value;
    }
    case 'list': {
      // The page sends a list; text with one item per line works too.
      const items = typeof raw === 'string' ? raw.split('\n') : raw;
      if (!Array.isArray(items) || !items.every((item) => typeof item === 'string')) {
        throw new SettingsError(`${label} must be a list of text, one per line.`);
      }
      // Blank lines are dropped, and repeats kept once.
      return [...new Set(items.map((item) => item.trim()).filter((item) => item !== ''))];
    }
    default:
      throw new Error(`Unknown setting type: ${field.type}`);
  }
}

// --- The store the server uses -----------------------------------------------

// One object the server keeps for the whole run:
//   current()      – the settings every route and every Scan now uses
//   view()         – everything the Settings page shows (GET /api/settings)
//   save(values)   – POST /api/settings: { "ageDays.recent": 21, ... }
//   reset()        – forget every Settings-page change (use config.json again)
// loadFileConfig is config.js → loadConfig, re-read every time, so edits to
// config.json still apply without restarting; tests pass a fake.
function createSettingsStore({ db, loadFileConfig = loadConfig }) {
  function current() {
    return loadAppConfig({ db, loadFileConfig }).config;
  }

  // The file settings, the saved changes, and the combination. If the saved
  // changes no longer fit with config.json, `problem` says so, but `config`
  // still has them all, so the page can load, and saving a fix to one value
  // keeps your other changes.
  function layers() {
    const file = loadFileConfig();
    const saved = readSavedSettings(db);
    const overrides = knownOverrides(saved.overrides);
    let problem = null;
    try {
      applyOverrides(file.config, overrides);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problem = error.message;
    }
    return { file, saved, overrides, config: mergeOverrides(file.config, overrides), problem };
  }

  function view() {
    const { file, saved, overrides, config, problem } = layers();
    const fieldView = (field) => {
      const saveKey = field.saveAs ?? field.key;
      return {
        key: field.key,
        label: field.label,
        help: field.help ?? null,
        type: field.type,
        unit: field.unit ?? null,
        min: field.min ?? null,
        max: field.max ?? null,
        step: field.step ?? null,
        effect: field.effect,
        effectText: EFFECTS[field.effect],
        value: getPath(config, field.key),
        fileValue: getPath(file.config, field.key),
        // true when this value comes from the Settings page, not config.json
        changedHere: saveKey in overrides,
      };
    };
    return {
      source: describeSource(file.source, overrides),
      fileSource: file.source,
      changedCount: Object.keys(overrides).length,
      savedAt: saved.updatedMs === null ? null : new Date(saved.updatedMs).toISOString(),
      problem,
      sections: SECTIONS.map((section) => ({
        id: section.id,
        title: section.title,
        intro: section.intro ?? null,
        advanced: Boolean(section.advanced),
        fields: section.fields.map(fieldView),
      })),
      fixed: FIXED.map((item) => {
        const value = getPath(config, item.key);
        return { key: item.key, label: item.label, value: item.describe ? item.describe(value) : String(value) };
      }),
    };
  }

  // Saves the result: only the values that differ from config.json, then
  // re-scores. Returns what changed, so the page can say what happens next.
  function store({ file, before, next }) {
    // SAFETY: the same checks as a scan, before anything is written: the app
    // and its data/ folder must not be on any drive, and the drives must not overlap.
    try {
      assertSafeLocations(next);
    } catch (error) {
      if (error instanceof ConfigError) throw new SettingsError(error.message);
      throw error;
    }
    const overrides = {};
    for (const key of SAVE_KEYS) {
      const value = getPath(next, key);
      if (!sameValue(value, getPath(file.config, key))) overrides[key] = clone(value);
    }
    writeSavedSettings(db, overrides, next);
    const changed = FIELDS.filter((field) => !sameValue(getPath(before, field.key), getPath(next, field.key)));
    return {
      config: next,
      changed: changed.map((field) => field.key),
      needsScan: changed.some((field) => field.effect === 'scan'),
    };
  }

  function save(values) {
    if (!isPlainObject(values) || Object.keys(values).length === 0) {
      throw new SettingsError('Nothing to save: send the changed settings, e.g. {"values": {"ageDays.recent": 21}}.');
    }
    const unknown = Object.keys(values).filter((key) => !FIELDS_BY_KEY.has(key));
    if (unknown.length > 0) {
      throw new SettingsError(`The Settings page can't change ${unknown.map((key) => `"${key}"`).join(', ')}.`);
    }
    const { file, config: before } = layers();
    const next = clone(before);
    for (const [key, raw] of Object.entries(values)) setPath(next, key, parseValue(FIELDS_BY_KEY.get(key), raw));
    try {
      validateConfig(next);
    } catch (error) {
      if (error instanceof ConfigError) throw new SettingsError(error.message);
      throw error;
    }
    return store({ file, before, next });
  }

  function reset() {
    const { file, config: before } = layers();
    return store({ file, before, next: clone(file.config) });
  }

  return { current, view, save, reset };
}

module.exports = {
  SettingsError,
  SECTIONS,
  FIELDS,
  loadAppConfig,
  applyOverrides,
  createSettingsStore,
};
