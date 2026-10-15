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
const { DRIVE_LABELS, configuredDrives } = require('../config');
const { parseProjectName } = require('./parseName');

// How many files to ask the OS about at once. Faster than one at a time,
// without risking macOS's limit on open file handles.
const STAT_BATCH_SIZE = 64;
// A file dated more than a day in the future has a wrong clock (usually a
// camera's), so its date can't tell us when you last edited.
const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_SLACK_MS = DAY_MS;
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
    .replace(/[‘’]/g, "'") // a curly apostrophe (TextEdit, iPhone) matches a straight one
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
      `Can't find "${root}". Is the drive plugged in?\n` +
      'Run `ls /Volumes` in Terminal to see the names of connected drives, then check "drives" in config.json.'
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

// True if this path, or any folder above it, is in the list. So pinning a
// container like "NCHS Football" keeps every shoot inside it, and a --root
// scan of a folder INSIDE a shared folder still treats everything as shared.
function matchesSelfOrAncestor(segments, keys) {
  return segments.some((_, i) => keys.has(folderKey(segments.slice(0, i + 1).join('/'))));
}

// True if config.json pins this project (folders.keepPinned), using the same
// rules as a scan: any upper/lower case, and a pinned container covers every
// project inside it. The database uses this when it re-scores without a scan.
//   relPath – the project's path from the top of the SSD, e.g. "NCHS Football/Week 1"
function isPinnedByConfig(relPath, keepPinned) {
  return matchesSelfOrAncestor(String(relPath).split('/'), keySet(keepPinned));
}

// Looks at the top level of the drive (and inside container folders) and
// sorts every item into: a project to scan, a shared folder to scan, a loose
// file, or something to skip.
//
// `prefix` is where `root` sits on the SSD, as folder names: [] for a normal
// scan, or e.g. ["NCHS Football"] when you scan just that folder with --root.
// Paths are always written from the top of the SSD, so the folder lists in
// your config match the same way in both cases.
async function planScan(root, lists, prefix) {
  const plan = { targets: [], looseFiles: [], skipped: [], hiddenCount: 0, warnings: [], unreadable: [], seenKeys: new Set() };

  let entries;
  try {
    entries = await statEntries(root);
  } catch (error) {
    throw new ScanError(friendlyRootError(error, root));
  }
  for (const entry of entries) {
    await planEntry(plan, root, lists, entry, prefix, true);
  }
  return plan;
}

// parentSegments: folder names from the top of the SSD down to `absDir`.
// atTop: true for items directly inside the scanned folder (the only level
// where container folders get opened up).
async function planEntry(plan, absDir, lists, entry, parentSegments, atTop) {
  const segments = [...parentSegments, entry.name];
  const relPath = segments.join('/');
  const key = folderKey(relPath);
  plan.seenKeys.add(key);

  if (isHousekeepingName(entry.name)) {
    // .Spotlight-V100, .fseventsd, .DS_Store, ... — macOS's own bookkeeping.
    plan.hiddenCount += 1;
    return;
  }
  if (entry.error) {
    plan.warnings.push(`Couldn't look at "${relPath}" (${entry.error.code || entry.error.message}).`);
    plan.unreadable.push(relPath);
    return;
  }
  if (matchesSelfOrAncestor(segments, lists.ignore)) {
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

  if (atTop && lists.containers.has(key)) {
    let children;
    try {
      children = await statEntries(absPath);
    } catch (error) {
      plan.warnings.push(`Couldn't open container folder "${relPath}" (${error.code || error.message}).`);
      plan.unreadable.push(relPath);
      return;
    }
    for (const child of children) {
      await planEntry(plan, absPath, lists, child, segments, false);
    }
    return;
  }

  plan.targets.push({
    name: segments.join(' / '),
    folderName: entry.name,
    segments,
    relPath,
    absPath,
    kind: matchesSelfOrAncestor(segments, lists.shared) ? 'shared' : 'project',
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
    hasExport: false, // any export, including drafts still in revision
    exportExampleFile: null, // the first file that made hasExport true, so you can check it in Finder
    hasVideoExport: false,
    hasFinalExport: false, // an export that says it's final ("FD"/"Final") — the sign the project is finished
    finalExportFile: null, // the newest such file, so you can check it in Finder
    finalExportMs: null,
    newerFootageFile: null, // footage shot after the final export — maybe another shoot still to edit
    futureDatedFiles: 0,
    futureDatedExample: null,
    skippedLinks: 0,
    incomplete: false, // true if some folder or file inside couldn't be read
    pinnedKeep: false,
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

// Keeps the newest { file, ms } seen so far in tracking[key].
function keepNewest(tracking, key, file, ms) {
  if (tracking[key] === null || ms > tracking[key].ms) tracking[key] = { file, ms };
}

function recordFile(facts, tracking, name, dir, stats, classifier, now) {
  const category = classifier.classifyFile(name, dir.context);
  const kind = classifier.mediaKind(name);
  const relPath = [...dir.folders, name].join('/');

  facts.fileCount += 1;
  facts.sizeBytes += stats.size;
  facts.diskBytes += diskUsage(stats);
  facts.bytesByType[category] += stats.size;
  facts.filesByType[category] += 1;
  if (category === 'export' && !facts.hasExport) {
    facts.hasExport = true;
    facts.exportExampleFile = relPath;
  }
  if (category === 'export' && kind === 'video') facts.hasVideoExport = true;
  if (category === 'raw' && kind === 'video') tracking.anyRawVideo = true;
  const finalKind = classifier.finalExportKind(name, dir.context);
  if (finalKind === 'video') keepNewest(tracking, 'finalVideo', relPath, stats.mtimeMs);
  if (finalKind === 'photo') keepNewest(tracking, 'finalPhoto', relPath, stats.mtimeMs);

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
  if (category === 'raw' && kind === 'video') keepNewest(tracking, 'rawVideo', relPath, modifiedMs);
  if (category === 'raw' && kind === 'photo') keepNewest(tracking, 'rawPhoto', relPath, modifiedMs);
  if (category === 'project' && (facts.lastProjectSaveMs === null || modifiedMs > facts.lastProjectSaveMs)) {
    facts.lastProjectSaveMs = modifiedMs;
    facts.lastProjectSaveFile = relPath;
  }
}

// If a folder suddenly can't be read, check whether the whole drive went away
// (unplugged, cable bumped, Mac went to sleep). A half-finished scan would
// show projects as 0 GB, so it's better to stop with a clear message.
async function assertDriveStillThere(root) {
  try {
    await fsp.stat(root);
  } catch {
    throw new ScanError('The SSD disconnected during the scan, so the results would be wrong. Plug it back in and run the scan again.');
  }
}

// Decides whether the project is finished, once every file has been seen.
// A video project needs a final VIDEO export; a final photo only counts for a
// photo shoot — a project with no video footage and no video exports at all —
// so a "Thumbnail FINAL.jpg" can't make a video project look finished.
// Footage shot more than a day after the final export suggests another shoot
// still waiting to be edited (e.g. Game 2 in a folder where Game 1 is done).
function settleFinalExport(facts, tracking) {
  const isPhotoProject = !facts.hasVideoExport && !tracking.anyRawVideo;
  const final = tracking.finalVideo ?? (isPhotoProject ? tracking.finalPhoto : null);
  if (!final) return;
  facts.hasFinalExport = true;
  facts.finalExportFile = final.file;
  facts.finalExportMs = final.ms;
  const footage = final === tracking.finalVideo ? tracking.rawVideo : tracking.rawPhoto;
  if (footage && footage.ms > final.ms + DAY_MS) facts.newerFootageFile = footage.file;
}

async function scanFolder(target, { classifier, now, onProgress, progress, root }) {
  const facts = newFacts(target);
  const tracking = { finalVideo: null, finalPhoto: null, rawVideo: null, rawPhoto: null, anyRawVideo: false };
  // The "stack" is a to-do list of folders still to look inside. We take one
  // off, list it, and add any subfolders we find back onto the list.
  const stack = [{ absPath: target.absPath, folders: [], context: classifier.rootContext(target.segments) }];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await statEntries(dir.absPath);
    } catch (error) {
      await assertDriveStillThere(root);
      facts.incomplete = true;
      const where = dir.folders.length > 0 ? dir.folders.join('/') : '(the project folder itself)';
      addWarning(facts, `Couldn't open folder "${where}" (${error.code || error.message}).`);
      continue;
    }

    for (const entry of entries) {
      if (entry.error) {
        // ENOENT = the file disappeared between listing and looking (an app
        // deleted a temp file); ignore it. Anything else means we missed a file.
        if (entry.error.code !== 'ENOENT') {
          await assertDriveStillThere(root);
          facts.incomplete = true;
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
        recordFile(facts, tracking, entry.name, dir, stats, classifier, now);
        progress.filesScanned += 1;
      }
    }
    onProgress({ name: target.name, filesScanned: progress.filesScanned });
  }

  settleFinalExport(facts, tracking);
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

// Where `root` sits inside `drivePath`, as folder names: [] if it IS the
// drive, ["NCHS Football"] for /Volumes/BRIGSMEDIA/NCHS Football, or null if
// it's somewhere else. realpath gives both paths in their true on-disk
// spelling (macOS ignores upper/lower case), so they compare reliably.
async function locateInside(root, drivePath) {
  let realRoot;
  let realDrive;
  try {
    [realRoot, realDrive] = await Promise.all([fsp.realpath(root), fsp.realpath(drivePath)]);
  } catch {
    return root === path.resolve(drivePath) ? [] : null;
  }
  const relative = path.relative(realDrive, realRoot);
  if (relative === '') return [];
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep);
}

// Which of the three drives `root` is on, and where on it.
// Returns { drive: 'working'|'library'|'archive'|null, prefix: [...] }.
async function locateOnDrives(root, config) {
  for (const [drive, drivePath] of configuredDrives(config)) {
    const prefix = await locateInside(root, drivePath);
    if (prefix !== null) return { drive, prefix };
  }
  return { drive: null, prefix: [] };
}


// Scans a drive and returns plain data (no classes), so it can be printed and
// saved to the database (src/db.js).
//   root       – folder to scan; defaults to the working SSD (drives.working).
//                Can be a folder inside any of the drives
//                (npm run scan -- --root ...) or anywhere else.
//   now        – the time to measure "future-dated" against (tests pass a fixed time)
//   onProgress – called after each folder with { name, filesScanned }
async function scanDrive(config, { root = config.drives.working, now = Date.now(), onProgress = () => {} } = {}) {
  root = path.resolve(root);

  let rootStats;
  try {
    rootStats = await fsp.stat(root);
  } catch (error) {
    throw new ScanError(friendlyRootError(error, root));
  }
  if (!rootStats.isDirectory()) throw new ScanError(`"${root}" is a file, not a folder.`);

  const { drive, prefix } = await locateOnDrives(root, config);
  // The folder lists in config describe the working SSD, so only a scan of the
  // whole working SSD can tell whether a listed name is missing (a typo).
  const isWholeWorkingSsd = drive === 'working' && prefix.length === 0;

  const classifier = createClassifier(config.fileTypes);
  const lists = {
    ignore: keySet(config.folders.ignore),
    shared: keySet(config.folders.shared),
    containers: keySet(config.folders.containers),
    keepPinned: keySet(config.folders.keepPinned),
  };

  const plan = await planScan(root, lists, prefix);
  const progress = { filesScanned: 0 };
  const projects = [];
  const shared = [];

  for (const target of plan.targets) {
    const facts = await scanFolder(target, { classifier, now, onProgress, progress, root });
    facts.pinnedKeep = matchesSelfOrAncestor(target.segments, lists.keepPinned);
    (target.kind === 'shared' ? shared : projects).push(facts);
  }
  // One last check: if the drive vanished while the final folders were being
  // read, their files would just look missing.
  await assertDriveStillThere(root);

  // "This name matches nothing" warnings only make sense when we've seen the
  // whole SSD; a --root scan only sees part of it.
  const warnings = isWholeWorkingSsd
    ? [...plan.warnings, ...unmatchedConfigWarnings(config.folders, plan.seenKeys)]
    : plan.warnings;

  return {
    root,
    // Which drive this was ('working', 'library', 'archive', or null if none),
    // and whether the scan covered all of it.
    drive,
    driveLabel: drive ? DRIVE_LABELS[drive] : null,
    wholeDrive: drive !== null && prefix.length === 0,
    scope: isWholeWorkingSsd ? 'working' : 'partial',
    scannedAt: now,
    projects,
    shared,
    looseFiles: plan.looseFiles,
    skipped: plan.skipped,
    hiddenCount: plan.hiddenCount,
    warnings,
    // Folders (paths from the top of the drive) that couldn't be opened or
    // looked at, so nothing is known about what's inside them this time.
    unreadable: plan.unreadable,
    filesScanned: progress.filesScanned,
  };
}

module.exports = { scanDrive, folderKey, isPinnedByConfig, ScanError };
