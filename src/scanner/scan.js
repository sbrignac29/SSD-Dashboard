'use strict';

// The scanner: walks the SSD and collects facts about each project.
//
// SAFETY: this file only ever READS. It uses two read-only calls from Node's
// built-in `fs` module:
//   readdir – list the names inside a folder
//   lstat   – get a file's size, type and modified time, without opening the
//             file and without following shortcuts (symlinks)
// It never opens, creates, changes, moves, renames or deletes anything.
// tests/safety.test.js fails if file-changing calls ever appear in src/.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { CATEGORIES, createClassifier, isHousekeepingName } = require('./classify');
const { parseProjectName } = require('./parseName');

// How many files to ask the OS about at once. Faster than one at a time,
// without risking macOS's limit on open file handles.
const STAT_BATCH_SIZE = 64;
// A file dated more than a day in the future has a wrong clock (usually a
// camera's), so its date can't tell us when you last edited.
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
// One broken folder shouldn't flood the report with hundreds of warnings.
const MAX_WARNINGS_PER_FOLDER = 10;

class ScanError extends Error {}

// Makes folder names comparable: "NCHS Football/Week 3/" and
// "nchs football/week 3" give the same key. macOS treats names
// case-insensitively, and the same accented letter can be stored two ways,
// so we normalize that too (NFC).
function folderKey(relPath) {
  return String(relPath)
    .normalize('NFC')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
    .toLowerCase();
}

function keySet(names) {
  return new Set(names.map(folderKey));
}

// Lists a folder and looks up every entry with lstat, a batch at a time.
// Returns [{ name, stats }] or [{ name, error }] per entry, sorted by name.
async function statEntries(absDir) {
  const names = await fsp.readdir(absDir);
  names.sort((a, b) => a.localeCompare(b));
  const entries = [];
  for (let i = 0; i < names.length; i += STAT_BATCH_SIZE) {
    const batch = names.slice(i, i + STAT_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (name) => {
        try {
          return { name, stats: await fsp.lstat(path.join(absDir, name)) };
        } catch (error) {
          return { name, error };
        }
      }),
    );
    entries.push(...results);
  }
  return entries;
}

function friendlyRootError(error, root) {
  if (error.code === 'ENOENT') {
    return (
      `Can't find "${root}". Is the SSD plugged in?\n` +
      'Run `ls /Volumes` in Terminal to see the names of connected drives, then update "ssdPath" in config.json.'
    );
  }
  if (error.code === 'EPERM' || error.code === 'EACCES') {
    return (
      `macOS blocked access to "${root}" (${error.code}).\n` +
      'Open System Settings → Privacy & Security → Files and Folders, find Terminal (or the app you ran this from), ' +
      'and turn on "Removable Volumes". Then run the scan again.'
    );
  }
  return `Couldn't read "${root}": ${error.message}`;
}

// --- Step 1: decide what each top-level item is ------------------------------

// Looks at the top level of the drive (and inside container folders) and
// sorts every item into: a project to scan, a shared folder to scan, a loose
// file, or something to skip.
async function planScan(root, lists) {
  const plan = { targets: [], looseFiles: [], skipped: [], hiddenCount: 0, warnings: [], seenKeys: new Set() };

  let entries;
  try {
    entries = await statEntries(root);
  } catch (error) {
    throw new ScanError(friendlyRootError(error, root));
  }
  for (const entry of entries) {
    await planEntry(plan, root, lists, entry, null);
  }
  return plan;
}

async function planEntry(plan, absDir, lists, entry, container) {
  const relPath = container ? `${container}/${entry.name}` : entry.name;
  const key = folderKey(relPath);
  plan.seenKeys.add(key);

  if (isHousekeepingName(entry.name)) {
    // .Spotlight-V100, .fseventsd, .DS_Store, ... — macOS's own bookkeeping.
    plan.hiddenCount += 1;
    return;
  }
  if (entry.error) {
    plan.warnings.push(`Couldn't look at "${relPath}" (${entry.error.code || entry.error.message}).`);
    return;
  }
  if (lists.ignore.has(key)) {
    plan.skipped.push({ relPath, reason: 'listed in folders.ignore' });
    return;
  }

  const { stats } = entry;
  const absPath = path.join(absDir, entry.name);

  if (stats.isSymbolicLink()) {
    plan.skipped.push({ relPath, reason: 'a shortcut/symlink — not followed' });
    return;
  }
  if (stats.isFile()) {
    plan.looseFiles.push({
      location: container || '',
      name: entry.name,
      relPath,
      sizeBytes: stats.size,
      modifiedMs: stats.mtimeMs,
    });
    return;
  }
  if (!stats.isDirectory()) {
    plan.skipped.push({ relPath, reason: 'not a regular file or folder' });
    return;
  }

  if (!container && lists.containers.has(key)) {
    let children;
    try {
      children = await statEntries(absPath);
    } catch (error) {
      plan.warnings.push(`Couldn't open container folder "${relPath}" (${error.code || error.message}).`);
      return;
    }
    for (const child of children) {
      await planEntry(plan, absPath, lists, child, entry.name);
    }
    return;
  }

  plan.targets.push({
    name: container ? `${container} / ${entry.name}` : entry.name,
    folderName: entry.name,
    relPath,
    absPath,
    kind: lists.shared.has(key) ? 'shared' : 'project',
    container,
  });
}

// --- Step 2: walk one project folder ----------------------------------------

function emptyCounts() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
}

function newFacts(target) {
  return {
    name: target.name,
    relPath: target.relPath,
    kind: target.kind,
    container: target.container,
    parsedName: parseProjectName(target.folderName),
    sizeBytes: 0, // what Finder calls the size: the sum of every file's length
    diskBytes: 0, // space actually taken on the drive (rounded up per file)
    fileCount: 0,
    folderCount: 0,
    bytesByType: emptyCounts(),
    filesByType: emptyCounts(),
    lastEditedMs: null, // newest modified time of any real (non-housekeeping) file
    lastEditedFile: null,
    lastProjectSaveMs: null, // newest modified time of a project file (.drp, .prproj, ...)
    lastProjectSaveFile: null,
    hasExport: false,
    futureDatedFiles: 0,
    futureDatedExample: null,
    skippedLinks: 0,
    warnings: [],
    warningsDropped: 0,
  };
}

function addWarning(facts, message) {
  if (facts.warnings.length < MAX_WARNINGS_PER_FOLDER) facts.warnings.push(message);
  else facts.warningsDropped += 1;
}

function diskUsage(stats) {
  // `blocks` counts 512-byte chunks the file occupies on disk.
  return typeof stats.blocks === 'number' ? stats.blocks * 512 : stats.size;
}

function recordFile(facts, name, dir, stats, classifier, now) {
  const category = classifier.classifyFile(name, dir.context);
  const relPath = [...dir.folders, name].join('/');

  facts.fileCount += 1;
  facts.sizeBytes += stats.size;
  facts.diskBytes += diskUsage(stats);
  facts.bytesByType[category] += stats.size;
  facts.filesByType[category] += 1;
  if (category === 'export') facts.hasExport = true;

  // Dates: only real files count. Hidden housekeeping files get rewritten
  // just by browsing in Finder, which would make old projects look fresh.
  if (dir.context.hidden || isHousekeepingName(name)) return;

  // mtime = "modified time": when the file's contents last changed.
  // (We never use access time — that changes whenever anything reads a file.)
  const modifiedMs = stats.mtimeMs;
  if (modifiedMs > now + FUTURE_SLACK_MS) {
    facts.futureDatedFiles += 1;
    facts.futureDatedExample ??= relPath;
    return;
  }
  if (facts.lastEditedMs === null || modifiedMs > facts.lastEditedMs) {
    facts.lastEditedMs = modifiedMs;
    facts.lastEditedFile = relPath;
  }
  if (category === 'project' && (facts.lastProjectSaveMs === null || modifiedMs > facts.lastProjectSaveMs)) {
    facts.lastProjectSaveMs = modifiedMs;
    facts.lastProjectSaveFile = relPath;
  }
}

async function scanFolder(target, { classifier, now, onProgress, progress }) {
  const facts = newFacts(target);
  // The "stack" is a to-do list of folders still to look inside. We take one
  // off, list it, and add any subfolders we find back onto the list.
  const stack = [
    { absPath: target.absPath, folders: [], context: classifier.rootContext(target.relPath.split('/')) },
  ];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await statEntries(dir.absPath);
    } catch (error) {
      const where = dir.folders.length > 0 ? dir.folders.join('/') : '(the project folder itself)';
      addWarning(facts, `Couldn't open folder "${where}" (${error.code || error.message}).`);
      continue;
    }

    for (const entry of entries) {
      if (entry.error) {
        // ENOENT = the file disappeared between listing and looking; ignore it.
        if (entry.error.code !== 'ENOENT') {
          addWarning(facts, `Couldn't look at "${[...dir.folders, entry.name].join('/')}" (${entry.error.code}).`);
        }
        continue;
      }
      const { stats } = entry;
      if (stats.isSymbolicLink()) {
        facts.skippedLinks += 1;
      } else if (stats.isDirectory()) {
        facts.folderCount += 1;
        stack.push({
          absPath: path.join(dir.absPath, entry.name),
          folders: [...dir.folders, entry.name],
          context: classifier.childContext(dir.context, entry.name),
        });
      } else if (stats.isFile()) {
        recordFile(facts, entry.name, dir, stats, classifier, now);
        progress.filesScanned += 1;
      }
    }
    onProgress({ name: target.name, filesScanned: progress.filesScanned });
  }

  if (facts.futureDatedFiles > 0) {
    addWarning(
      facts,
      `${facts.futureDatedFiles} file(s) are dated in the future (e.g. "${facts.futureDatedExample}") — ` +
        'probably a camera with a wrong clock. Their dates were ignored.',
    );
  }
  return facts;
}

// --- Putting it together -----------------------------------------------------

// Config folder names that didn't match anything are probably typos; say so.
function unmatchedConfigWarnings(folders, seenKeys) {
  const warnings = [];
  for (const listName of ['ignore', 'shared', 'containers', 'keepPinned']) {
    for (const name of folders[listName]) {
      if (!seenKeys.has(folderKey(name))) {
        warnings.push(
          `folders.${listName} lists "${name}", but no top-level folder (or container subfolder) has that name.`,
        );
      }
    }
  }
  return warnings;
}

// Scans the drive at config.ssdPath. Returns plain data (no classes), so it
// can be printed now and saved to the database in Phase 2.
//   now        – the time to measure "future-dated" against (tests pass a fixed time)
//   onProgress – called after each folder with { name, filesScanned }
async function scanDrive(config, { now = Date.now(), onProgress = () => {} } = {}) {
  const root = path.resolve(config.ssdPath);

  let rootStats;
  try {
    rootStats = await fsp.stat(root);
  } catch (error) {
    throw new ScanError(friendlyRootError(error, root));
  }
  if (!rootStats.isDirectory()) throw new ScanError(`"${root}" is a file, not a folder.`);

  const classifier = createClassifier(config.fileTypes);
  const lists = {
    ignore: keySet(config.folders.ignore),
    shared: keySet(config.folders.shared),
    containers: keySet(config.folders.containers),
    keepPinned: keySet(config.folders.keepPinned),
  };

  const plan = await planScan(root, lists);
  const progress = { filesScanned: 0 };
  const projects = [];
  const shared = [];

  for (const target of plan.targets) {
    const facts = await scanFolder(target, { classifier, now, onProgress, progress });
    facts.pinnedKeep = lists.keepPinned.has(folderKey(target.relPath));
    (target.kind === 'shared' ? shared : projects).push(facts);
  }

  return {
    root,
    scannedAt: now,
    projects,
    shared,
    looseFiles: plan.looseFiles,
    skipped: plan.skipped,
    hiddenCount: plan.hiddenCount,
    warnings: [...plan.warnings, ...unmatchedConfigWarnings(config.folders, plan.seenKeys)],
    filesScanned: progress.filesScanned,
  };
}

module.exports = { scanDrive, folderKey, ScanError };
