'use strict';

// Loads the app's settings.
//
// Settings come from two files in the project folder:
//   config.example.json – the defaults that ship with the app (tracked by git)
//   config.json         – your personal copy (ignored by git). Anything you put
//                         here overrides the default with the same name.
// If config.json doesn't exist yet, the defaults are used as-is.
//
// This file is a "module": a file that shares some of its functions with other
// files. The list of shared things is `module.exports` at the bottom; other
// files get them with `require('./config')`.

const fs = require('node:fs');
const path = require('node:path');

// __dirname is the folder this file lives in (src/), so ROOT_DIR is the
// project folder one level up.
const ROOT_DIR = path.resolve(__dirname, '..');
// SAFETY: the only folder the app is ever allowed to write to.
const DATA_DIR = path.join(ROOT_DIR, 'data');
const EXAMPLE_CONFIG_PATH = path.join(ROOT_DIR, 'config.example.json');
const USER_CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

// A custom error type, so the command-line tool can print these messages
// plainly instead of as a scary stack trace.
class ConfigError extends Error {}

function readJson(filePath) {
  const fileName = path.basename(filePath);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(`Couldn't read ${fileName}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    // TextEdit's "smart quotes" turn " into “ ”, which JSON doesn't allow.
    // (Curly single quotes like ’ are fine inside JSON text.)
    const tip = /[“”]/.test(text)
      ? 'Tip: the file contains curly quotes (“ ”). JSON needs straight quotes ("). In TextEdit, turn off ' +
        'Edit → Substitutions → Smart Quotes and retype them, or use a code editor like VS Code.'
      : 'Tip: look for a missing comma between items, or an extra comma after the last item in a list.';
    throw new ConfigError(`${fileName} isn't valid JSON: ${err.message}\n${tip}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Vericopy (the copy-and-verify app) runs at http://localhost:7743, so the
// dashboard must use a different port.
const VERICOPY_PORT = 7743;

// The three drives in the workflow, in the order projects travel:
//   working (2TB SSD: cards land here, editing happens here)
//   → library (2TB HDD: finished, recent projects)
//   → archive (28TB HDD: everything older, once the library fills up)
const DRIVE_LABELS = {
  working: 'Working SSD',
  library: 'Library HDD',
  archive: 'Archive HDD',
};

// Combines two settings objects. Nested sections ("weights", "folders", ...)
// are merged key by key; lists and single values from `overrides` replace the
// default entirely.
function deepMerge(base, overrides) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides || {})) {
    merged[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return merged;
}

function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// Checks the settings and throws one error listing every problem found, so
// you can fix them all in one go.
function validateConfig(config) {
  const problems = [];

  // Older settings files used "ssdPath" / "archivePath" before there were three drives.
  for (const oldName of ['ssdPath', 'archivePath']) {
    if (oldName in config) {
      problems.push(
        `"${oldName}" was replaced by the "drives" section: your config.json is from before the three-drive ` +
          'update. Copy the example again (cp config.example.json config.json) and redo any edits.',
      );
    }
  }
  const drives = config.drives || {};
  if (typeof drives.working !== 'string' || drives.working.trim() === '') {
    problems.push('"drives.working" must be the path to your working SSD, e.g. "/Volumes/BRIGSMEDIA".');
  }
  for (const name of ['library', 'archive']) {
    if (typeof drives[name] !== 'string') {
      problems.push(`"drives.${name}" must be a path in quotes (or "" if you don't have that drive).`);
    }
  }

  const full = config.libraryFull || {};
  if (!Number.isFinite(full.startAtPercent) || full.startAtPercent <= 0 || full.startAtPercent > 100) {
    problems.push('"libraryFull.startAtPercent" must be a percentage between 1 and 100, e.g. 90.');
  } else if (!Number.isFinite(full.targetPercent) || full.targetPercent < 0 || full.targetPercent >= full.startAtPercent) {
    problems.push('"libraryFull.targetPercent" must be a percentage smaller than "startAtPercent", e.g. 70.');
  }

  // The dashboard server (npm start). Vericopy already uses 7743.
  const server = config.server || {};
  if (!Number.isInteger(server.port) || server.port < 1024 || server.port > 65535) {
    problems.push('"server.port" must be a whole number between 1024 and 65535, e.g. 7744.');
  } else if (server.port === VERICOPY_PORT) {
    problems.push(`"server.port" can't be ${VERICOPY_PORT}: Vericopy uses that port. Try 7744.`);
  }
  if (typeof server.host !== 'string' || server.host.trim() === '') {
    problems.push('"server.host" must be "127.0.0.1" (this Mac only) or "0.0.0.0" (also your phone, on the same Wi-Fi).');
  }

  const weights = config.weights || {};
  const weightNames = ['done', 'age', 'size'];
  const badWeights = weightNames.filter((name) => typeof weights[name] !== 'number' || weights[name] < 0);
  if (badWeights.length > 0) {
    problems.push(`"weights.${badWeights.join('", "weights.')}" must be numbers 0 or higher.`);
  } else {
    const total = weights.done + weights.age + weights.size;
    if (Math.abs(total - 1) > 0.001) {
      problems.push(`"weights" must add up to 1 so scores stay between 0 and 100 (they add up to ${total.toFixed(3)}).`);
    }
  }

  const ageDays = config.ageDays || {};
  if (!Number.isFinite(ageDays.recent) || ageDays.recent < 0) {
    problems.push('"ageDays.recent" must be a number of days, 0 or more.');
  } else if (!Number.isFinite(ageDays.max) || ageDays.max <= ageDays.recent) {
    problems.push('"ageDays.max" must be a number of days bigger than "ageDays.recent".');
  }

  const buckets = config.buckets || {};
  if (!Number.isFinite(buckets.review) || buckets.review < 0 || buckets.review > 100) {
    problems.push('"buckets.review" must be a score between 0 and 100, e.g. 40.');
  }

  if (!isStringList(config.doneStatuses)) {
    problems.push('"doneStatuses" must be a list of text: the Notion statuses that mean finished, e.g. ["Done"].');
  }

  // Notion (Phase 4). An empty token is fine: the dashboard then shows
  // "Notion: not connected" and scores from exports alone.
  const notion = config.notion || {};
  if (typeof notion.token !== 'string') {
    problems.push('"notion.token" must be your Notion token in quotes, or "" for no Notion.');
  }
  if (typeof notion.dataSourceId !== 'string' || (notion.dataSourceId.trim() !== '' && notionId(notion.dataSourceId) === null)) {
    problems.push(
      '"notion.dataSourceId" must be the ID of your Projects data source, e.g. "233517a5-0199-8028-a552-000b7d81cc6b" ' +
        '(32 letters and digits; a copied Notion link works too).',
    );
  }
  for (const name of ['titleProperty', 'statusProperty', 'endDateProperty']) {
    if (typeof notion[name] !== 'string' || (name !== 'endDateProperty' && notion[name].trim() === '')) {
      problems.push(`"notion.${name}" must be the name of a property (column) in your Notion database, in quotes.`);
    }
  }

  for (const name of ['ignore', 'shared', 'containers', 'keepPinned']) {
    if (!isStringList(config.folders?.[name])) {
      problems.push(`"folders.${name}" must be a list of folder names (it can be empty: []).`);
    }
  }

  for (const [name, value] of Object.entries(config.fileTypes || {})) {
    if (!isStringList(value)) problems.push(`"fileTypes.${name}" must be a list of text.`);
  }

  if (problems.length > 0) {
    throw new ConfigError(`There's a problem with your settings:\n  - ${problems.join('\n  - ')}`);
  }
}

// A Notion ID in its usual form (8-4-4-4-12, lowercase), from an ID written
// with or without dashes or a copied Notion link; null if there's none.
// Notion IDs are 32 hexadecimal characters (0-9, a-f).
function notionId(text) {
  // In a link, ignore everything after "?" (e.g. "?v=..." is a view's ID).
  const before = String(text ?? '').split(/[?#]/)[0].toLowerCase();
  const matches = before.match(/(?<![0-9a-f])[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?![0-9a-f])/g);
  if (!matches) return null;
  // In a link, the ID is the last one (after the page name).
  const hex = matches[matches.length - 1].replace(/-/g, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The Notion settings, tidied: { token, dataSourceId, titleProperty, statusProperty,
// endDateProperty, configured } — configured = there's a token and an ID to use.
function notionSettings(config) {
  const notion = config.notion ?? {};
  const token = String(notion.token ?? '').trim();
  const dataSourceId = notionId(notion.dataSourceId);
  return {
    token,
    dataSourceId,
    titleProperty: String(notion.titleProperty ?? '').trim(),
    statusProperty: String(notion.statusProperty ?? '').trim(),
    endDateProperty: String(notion.endDateProperty ?? '').trim(),
    configured: token !== '' && dataSourceId !== null,
  };
}

// Returns the defaults with `overrides` applied on top, after checking them.
// Tests use this directly so they never depend on your personal config.json.
function withDefaults(overrides = {}) {
  const config = deepMerge(readJson(EXAMPLE_CONFIG_PATH), overrides);
  validateConfig(config);
  return config;
}

// Loads config.json (if you've made one) on top of the defaults.
// Returns the settings plus which file they came from, for display.
function loadConfig() {
  const hasUserConfig = fs.existsSync(USER_CONFIG_PATH);
  const overrides = hasUserConfig ? readJson(USER_CONFIG_PATH) : {};
  return {
    config: withDefaults(overrides),
    source: hasUserConfig ? 'config.json' : 'config.example.json (defaults — no config.json yet)',
  };
}

// --- Safety checks -----------------------------------------------------------

// Turns a path into a comparable form: absolute, with shortcuts resolved, and
// lowercase on macOS/Windows (where "/Volumes/SSD" and "/volumes/ssd" are the
// same place).
function canonicalPath(p) {
  let resolved = path.resolve(p);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // The path doesn't exist (yet). Keep the plain resolved version.
  }
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// True if `child` is `parent` itself or somewhere inside it.
function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

// The drives that have a path set, as [name, path] pairs.
function configuredDrives(config) {
  return Object.keys(DRIVE_LABELS)
    .map((name) => [name, config.drives[name]])
    .filter(([, drivePath]) => typeof drivePath === 'string' && drivePath.trim() !== '');
}

// SAFETY: refuses to run if this app lives inside a folder it would scan. If
// it did, the app's data/ folder (the one place it writes) would be on that
// drive, and the scan would include the app's own files as a "project".
function assertAppNotInside(folder, label = folder) {
  if (isInside(canonicalPath(ROOT_DIR), canonicalPath(folder))) {
    throw new ConfigError(
      `This app is stored inside ${label} (${folder}).\n` +
        'The app must never write to your media drives, so move the app folder somewhere else first ' +
        '(for example ~/Code/SSD-Dashboard) and run it from there.',
    );
  }
  // canonicalPath follows shortcuts, so this also catches a data/ folder that
  // is really a shortcut (symlink) into this folder. The database lives in
  // data/, so it must never end up on a media drive.
  if (isInside(canonicalPath(DATA_DIR), canonicalPath(folder))) {
    throw new ConfigError(
      `The app's data/ folder leads into ${label} (${folder}).\n` +
        'The database must never be written to your media drives. Make data/ a normal folder inside the app folder.',
    );
  }
}

// SAFETY: the app must not live on any of the three drives, and the drives
// must be three separate places (otherwise "move to the library" could mean
// "move onto itself").
function assertSafeLocations(config) {
  const drives = configuredDrives(config);
  for (const [name, drivePath] of drives) {
    assertAppNotInside(drivePath, `your ${DRIVE_LABELS[name]}`);
  }
  for (const [nameA, pathA] of drives) {
    for (const [nameB, pathB] of drives) {
      if (nameA < nameB && (isInside(canonicalPath(pathA), canonicalPath(pathB)) || isInside(canonicalPath(pathB), canonicalPath(pathA)))) {
        throw new ConfigError(
          `"drives.${nameA}" and "drives.${nameB}" overlap (${pathA} / ${pathB}). Each drive must be a separate place.`,
        );
      }
    }
  }
}

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  DRIVE_LABELS,
  ConfigError,
  configuredDrives,
  assertAppNotInside,
  loadConfig,
  withDefaults,
  validateConfig,
  deepMerge,
  isInside,
  assertSafeLocations,
  notionId,
  notionSettings,
};
