'use strict';

// Moves (Phase 5A): asks VeriCopy to COPY a project to the next drive, follows
// the copy until it's verified, then checks the copy itself. Nothing is
// deleted: the original stays where it is.
//
//   Move 1: Working SSD → Library HDD ("Move to HDD"), for Ready projects
//   Move 2: Library HDD → Archive HDD ("Move to Archive"), for the projects
//           the Done HDD page suggests
//
// The drives are laid out alike, so a project keeps its path: the SSD's
// "NCHS Football/Week 1" lands at "<Library>/NCHS Football/Week 1". VeriCopy
// copies a folder INTO a destination folder, so the destination it's given is
// the PARENT ("<Library>/NCHS Football"), which must already exist.
//
// A move, step by step:
//   1. preview()  – what would happen (from, to, size, files, space left) and
//                   the pre-checks, all read-only. Nothing starts.
//   2. start()    – only after you click Start: the pre-checks run again, the
//                   move is saved in archive_log, THEN VeriCopy is asked
//                   (POST /api/jobs). Its job id is saved straight away.
//   3. tick()     – "polling": every 2 seconds the tracker asks VeriCopy how
//                   each unfinished job is doing (GET /api/jobs/:id) and saves
//                   the answer. HTTP can't push news to us, so we ask. It also
//                   runs once when the dashboard starts, to pick up jobs that
//                   were running when it stopped.
//   4. When VeriCopy says "verified", the spot check: the dashboard counts
//      the copy's files and bytes itself and compares them with the original.
//      Only then is the move "Copied to HDD, original still on SSD".
//
// Job states: VeriCopy reports queued → copying → verifying → verified, or
// failed / cancelled. Only "verified" means every file's checksum matched.
// The dashboard's own states (archive_log.state, see migration 6 in db.js) add
// starting, checking, copied (the only success), check_failed, refused, lost.
//
// SAFETY: this file never writes, moves or deletes anything on a drive (it only
// uses lstat, readdir and statfs — tests/safety.test.js checks). The copying is
// VeriCopy's, which never overwrites. The only writes are archive_log rows in
// the database (db.js).

const fsp = require('node:fs/promises');
const path = require('node:path');
const { DRIVE_LABELS, assertSafeLocations, isInside } = require('../config');
const { getProject, createMove, updateMove, getMove, listMoves, unfinishedMoves } = require('../db');
const { driveSpace, allDriveSpace } = require('../scanner/space');
const { archivePlan } = require('../web/views');
const { measureFolder } = require('./measure');
const { createVericopyClient, VericopyError } = require('./vericopy');

// Which drive a project moves to, from the drive it's on.
const NEXT_DRIVE = { working: 'library', library: 'archive' };
const BUTTON_LABELS = { working: 'Move to HDD', library: 'Move to Archive' };
// The destination needs this much more free space than the project's size.
const SPACE_MARGIN = 0.1;
// Nothing in the project may have changed for this long before a move.
const QUIET_MS = 10 * 60 * 1000;
const POLL_MS = 2000;

function plural(n, word) {
  return `${Number(n).toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

// Decimal GB, like Finder and the rest of the dashboard.
function gb(bytes) {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1e3))} KB`;
}

function minutesAgo(ms, now) {
  const minutes = Math.max(0, Math.round((now - ms) / 60000));
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 120) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.round(hours / 24), 'day')} ago`;
}

// lstat that answers undefined instead of throwing when the path isn't there.
async function lstatOrNothing(target) {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

// Is this drive really plugged in? Returns null if so, else why not.
//
// A drive under /Volumes is a separate disk, so its folder has a different
// device number (stat's `dev`) from /Volumes itself. When macOS is
// interrupted while ejecting, it can leave an EMPTY ordinary folder with the
// drive's name in /Volumes: it exists, but it's on the Mac's own disk (same
// device number as /Volumes). That's not the drive. (Drive paths outside
// /Volumes, like a test folder in your home folder, are only checked to exist.)
async function driveProblem(drivePath, label, { volumesDir = '/Volumes' } = {}) {
  if (typeof drivePath !== 'string' || drivePath.trim() === '') {
    return `No ${label} is set up: add its path on the Settings page.`;
  }
  let stats;
  try {
    stats = await fsp.stat(drivePath);
  } catch {
    return `The ${label} isn't connected (${drivePath} isn't there). Plug it in, then press Check again.`;
  }
  if (!stats.isDirectory()) return `${drivePath} isn't a folder, so it can't be the ${label}.`;
  if (isInside(path.resolve(drivePath), path.resolve(volumesDir)) && path.resolve(drivePath) !== path.resolve(volumesDir)) {
    let volumes;
    try {
      volumes = await fsp.stat(volumesDir);
    } catch {
      volumes = null;
    }
    if (volumes && volumes.dev === stats.dev) {
      return (
        `${drivePath} is a leftover empty folder on the Mac's own disk, not the ${label}: macOS sometimes leaves one ` +
        'after a drive is unplugged without ejecting. Plug the drive in (restarting the Mac clears the leftover folder).'
      );
    }
  }
  return null;
}

// Where a project is and where it would go. Paths in the database are
// relative to the top of the drive, with "/" between folders.
function movePaths(config, project) {
  const fromDrive = project.drive;
  const toDrive = NEXT_DRIVE[fromDrive];
  const fromRoot = config.drives[fromDrive];
  const toRoot = toDrive ? config.drives[toDrive] : '';
  const parts = String(project.relPath).split('/');
  // SAFETY: a path from the scanner never has these, but refuse anyway.
  const badPath = parts.some((part) => part === '' || part === '.' || part === '..');
  const parentParts = parts.slice(0, -1);
  const folderName = parts.at(-1);
  const source = path.join(fromRoot ?? '', ...parts);
  const destinationParent = path.join(toRoot ?? '', ...parentParts);
  return {
    fromDrive,
    toDrive,
    fromRoot,
    toRoot,
    folderName,
    parentParts,
    badPath,
    source,
    destinationParent,
    destinationPath: path.join(destinationParent, folderName),
  };
}

// --- Plain words for VeriCopy's answers -------------------------------------

function vericopyDownText(url) {
  return (
    `VeriCopy isn't open: nothing answered at ${url}. Open VeriCopy, then press Check again. ` +
    '(If it is open, check that VeriCopy ▸ Settings ▸ API is turned on.)'
  );
}

// A VericopyError from POST /api/jobs, as advice. Branches on the error CODE
// (stable, API.md); VeriCopy's own message is added for details.
function refusalText(error, { source, destinationParent, destinationPath, url }) {
  const theirs = error.message ? ` (VeriCopy: “${error.message}”)` : '';
  switch (error.code) {
    case 'destination_exists':
      return (
        `VeriCopy refused: ${destinationPath} already exists. It may be a leftover partial copy from an earlier move that ` +
        'failed or was cancelled. Nothing was copied. Look at it in Finder; if it is a partial copy, delete it there yourself, ' +
        'then try again.'
      );
    case 'path_not_found':
      return `VeriCopy couldn't find ${source} or ${destinationParent}: is the drive plugged in? Nothing was copied.${theirs}`;
    case 'path_not_allowed':
      return (
        'VeriCopy isn\'t allowed to use these folders. Add each drive to "allowedRoots" in VeriCopy\'s api-config.json ' +
        '(~/Library/Application Support/VeriCopy/), press Reload Config in VeriCopy ▸ Settings ▸ API, then try again. ' +
        `Nothing was copied.${theirs}`
      );
    case 'path_not_a_directory':
      return `VeriCopy says ${destinationParent} is a file, not a folder. Nothing was copied.${theirs}`;
    case 'source_empty':
      return `VeriCopy found no files in ${source}. Nothing was copied.${theirs}`;
    case 'destination_inside_source':
      return `VeriCopy refused to copy a folder into itself. Check the drive paths on the Settings page. Nothing was copied.${theirs}`;
    case 'browser_origin_refused':
      return `VeriCopy refused the request as if it came from a web page. That's a bug in the dashboard; nothing was copied.${theirs}`;
    case 'not_running':
      return `${vericopyDownText(url)} Nothing was copied.`;
    case 'timeout':
      return (
        "VeriCopy didn't answer within 30 seconds, so the dashboard never got a job id. VeriCopy may still have started the " +
        "copy: look in VeriCopy's window. If it's there, let it finish (or cancel it) in VeriCopy, then check " +
        `${destinationPath} in Finder before trying again.`
      );
    default:
      return `VeriCopy refused (${error.code}). Nothing was copied.${theirs}`;
  }
}

function partialFolderText(move) {
  return (
    `Files already copied stay in ${move.destinationPath}. Before trying again, delete that partial folder in Finder ` +
    '(the dashboard never deletes anything).'
  );
}

function lostText(move) {
  return (
    'Lost: copy state unknown. VeriCopy no longer knows this job (it was quit or restarted), so the copy was never ' +
    `verified. Check ${move.destinationPath} in Finder: if a partial folder is there, delete it before trying again.`
  );
}

function failedText(job, move) {
  const why = job.fatalError
    ? `VeriCopy couldn't run the copy: ${job.fatalError}.`
    : `VeriCopy reports ${plural(job.filesFailed ?? job.failedFiles.length, 'file')} that failed (listed below).`;
  return `${why} ${partialFolderText(move)}`;
}

// --- The spot check -------------------------------------------------------------

// After VeriCopy says "verified": count both folders ourselves (read-only) and
// compare. Returns { ok, at, source, destination, problems }.
async function spotCheck(move, { now = Date.now() } = {}) {
  const problems = [];
  const summary = (m) =>
    m && { files: m.files, bytes: m.bytes, macClutterFiles: m.clutterFiles, symlinks: m.symlinks, unreadable: m.unreadable.slice(0, 20) };
  let source = null;
  let destination = null;
  try {
    source = await measureFolder(move.sourcePath, { now });
  } catch (error) {
    problems.push(`Couldn't read the original (${move.sourcePath}): ${error.code ?? error.message}.`);
  }
  try {
    destination = await measureFolder(move.destinationPath, { now });
  } catch (error) {
    problems.push(`Couldn't read the copy (${move.destinationPath}): ${error.code ?? error.message}.`);
  }
  if (source && destination) {
    if (source.unreadable.length > 0) problems.push(`${plural(source.unreadable.length, 'item')} in the original couldn't be read.`);
    if (destination.unreadable.length > 0) problems.push(`${plural(destination.unreadable.length, 'item')} in the copy couldn't be read.`);
    if (source.files !== destination.files) {
      problems.push(`The original has ${plural(source.files, 'file')}, the copy ${plural(destination.files, 'file')}.`);
    }
    if (source.bytes !== destination.bytes) {
      problems.push(`The original holds ${source.bytes.toLocaleString('en-US')} bytes, the copy ${destination.bytes.toLocaleString('en-US')}.`);
    }
    if (source.symlinks !== destination.symlinks) {
      problems.push(`The original has ${plural(source.symlinks, 'shortcut (symlink)')}, the copy ${destination.symlinks}.`);
    }
  }
  return {
    ok: problems.length === 0,
    at: new Date(now).toISOString(),
    source: summary(source),
    destination: summary(destination),
    vericopyFilesTotal: move.filesTotal,
    problems,
    ignored: '.DS_Store and ._ files are not counted on either side (Finder and non-Mac drives add them on their own).',
  };
}

function spotCheckFailedText(check, move) {
  return (
    `VeriCopy said every file verified, but the dashboard's own count doesn't match: ${check.problems.join(' ')} ` +
    `So it is NOT marked as copied. Compare the two folders in Finder (Get Info shows size and item count). If the original ` +
    `changed after the copy started, that explains it: delete the copy (${move.destinationPath}) in Finder and move it again. ` +
    'If a drive was unplugged, plug it back in and press Check the copy again.'
  );
}

// --- The mover ------------------------------------------------------------------

//   db          – the open database
//   getConfig   – the current settings (re-read every time)
//   makeClient  – (config) => a VeriCopy client (tests can pass their own)
//   getSpaces   – how full each drive is (Move 2's list depends on it)
//   getSpace    – free space of one drive (the space pre-check)
//   isScanning  – () => true while a scan runs (no moves start meanwhile)
//   volumesDir  – where macOS mounts drives (tests pass a fake)
//   pollMs      – how often to ask VeriCopy while a job runs
//   now         – the clock (tests pass their own)
function createMover({
  db,
  getConfig,
  makeClient = (config) => createVericopyClient({ url: config.vericopy.url }),
  getSpaces = allDriveSpace,
  getSpace = driveSpace,
  isScanning = () => false,
  volumesDir = '/Volumes',
  pollMs = POLL_MS,
  now = () => Date.now(),
  log = console,
}) {
  // Moves being started right now (VeriCopy hasn't answered POST /api/jobs yet).
  const starting = new Set();
  // Projects with a Start press in progress (two quick clicks start one move).
  const busyProjects = new Set();
  // The last time we heard from VeriCopy (or failed to), for the pages.
  let contact = { reachable: null, at: null, message: null };
  let timer = null;
  let ticking = null;

  function noteContact(reachable, message = null) {
    contact = { reachable, at: new Date(now()).toISOString(), message };
  }

  // --- 1. Preview + pre-checks (read-only) ---

  async function preview(projectId) {
    const config = getConfig();
    const project = getProject(db, projectId);
    if (!project) return { found: false };
    const paths = movePaths(config, project);
    const fromLabel = DRIVE_LABELS[paths.fromDrive];
    const toLabel = paths.toDrive ? DRIVE_LABELS[paths.toDrive] : null;
    const client = makeClient(config);
    const checks = [];
    const add = (id, label, state, message) => checks.push({ id, label, state, message });
    const at = now();

    // Can this project be moved at all?
    const moves = listMoves(db, { projectId: project.id, limit: 20 });
    const active = moves.find((m) => m.unfinished);
    const copied = moves.find((m) => m.state === 'copied');
    if (project.kind === 'shared') {
      add('eligible', 'Can be moved', 'fail', 'Shared folders are used by many projects, so they are never moved.');
    } else if (!paths.toDrive) {
      add('eligible', 'Can be moved', 'fail', `Projects on the ${fromLabel} don't move anywhere.`);
    } else if (project.missing) {
      add('eligible', 'Can be moved', 'fail', `This folder wasn't on the ${fromLabel} at the last scan, so there's nothing to move.`);
    } else if (paths.badPath) {
      add('eligible', 'Can be moved', 'fail', `The saved path "${project.relPath}" looks wrong. Press Scan now, then try again.`);
    } else if (project.drive === 'working' && project.scoring?.bucket !== 'Ready') {
      add(
        'eligible',
        'Can be moved',
        'fail',
        'Only projects tagged “Ready to move to HDD” are moved to the Library. See “What it needs to be ready to move” below.',
      );
    } else if (project.drive === 'library' && !archivePlan({ db, config, spaces: await getSpaces(config) }).suggested.has(project.id)) {
      add(
        'eligible',
        'Can be moved',
        'fail',
        `Only the projects the Done HDD page suggests (oldest first, once the Library passes ${config.libraryFull.startAtPercent}% full) ` +
          'are moved to the Archive.',
      );
    } else {
      add('eligible', 'Can be moved', 'pass', project.drive === 'working' ? 'Ready to move to HDD.' : 'Suggested on the Done HDD page.');
    }
    if (active) {
      add('previous', 'No move already running', 'fail', 'A move of this project is already in progress: see below, or the Moves page.');
    } else if (copied && copied.toDrive === paths.toDrive) {
      add(
        'previous',
        'Not copied already',
        'fail',
        `Already copied to the ${toLabel} on ${new Date(copied.finishedMs).toDateString()}. The original stays on the ` +
          `${fromLabel} until removing originals is built (a later phase).`,
      );
    }

    // VeriCopy is open.
    const vericopy = { url: client.url, running: false, version: null, busy: false, message: null };
    try {
      const health = await client.health();
      vericopy.running = health.ok;
      vericopy.version = health.version;
      vericopy.busy = health.queueActive;
      noteContact(true);
    } catch (error) {
      if (!(error instanceof VericopyError)) throw error;
      vericopy.message = error.code === 'not_running' || error.code === 'timeout' ? vericopyDownText(client.url) : `Something answers at ${client.url}, but not like VeriCopy does (${error.code}).`;
      noteContact(false, vericopy.message);
    }
    if (vericopy.running) {
      add(
        'vericopy',
        'VeriCopy is open',
        'pass',
        `VeriCopy ${vericopy.version ?? ''} is answering at ${client.url}.` + (vericopy.busy ? ' It is busy with another copy: this one will wait its turn.' : ''),
      );
    } else {
      add('vericopy', 'VeriCopy is open', 'fail', vericopy.message ?? vericopyDownText(client.url));
    }

    // Both drives are plugged in (and aren't a leftover empty folder).
    const fromProblem = await driveProblem(paths.fromRoot, fromLabel, { volumesDir });
    const toProblem = paths.toDrive ? await driveProblem(paths.toRoot, toLabel, { volumesDir }) : 'No drive to move to.';
    if (fromProblem || toProblem) {
      add('drives', 'Both drives connected', 'fail', [fromProblem, toProblem].filter(Boolean).join(' '));
    } else {
      add('drives', 'Both drives connected', 'pass', `${fromLabel} and ${toLabel} are plugged in.`);
    }

    // The project folder itself: measure it (files, bytes, last change).
    let measured = null;
    if (!fromProblem && !paths.badPath) {
      const stats = await lstatOrNothing(paths.source);
      if (!stats) {
        add('source', 'Project folder found', 'fail', `${paths.source} isn't there any more. Press Scan now to update the list.`);
      } else if (stats.isSymbolicLink() || !stats.isDirectory()) {
        add('source', 'Project folder found', 'fail', `${paths.source} isn't a normal folder (it's a file or a shortcut).`);
      } else {
        try {
          measured = await measureFolder(paths.source, { now: at });
        } catch (error) {
          add('source', 'Project folder found', 'fail', `Couldn't read ${paths.source}: ${error.code ?? error.message}.`);
        }
      }
      if (measured && measured.unreadable.length > 0) {
        add(
          'source',
          'Project folder found',
          'fail',
          `${plural(measured.unreadable.length, 'item')} inside can't be read (e.g. ${measured.unreadable[0]}), so they couldn't be copied either.`,
        );
      } else if (measured && measured.files === 0) {
        add('source', 'Project folder found', 'fail', 'The folder has no files to copy.');
      } else if (measured) {
        add('source', 'Project folder found', 'pass', `${plural(measured.files, 'file')}, ${gb(measured.bytes)}.`);
      }
    }

    // The destination's parent folder exists (the dashboard never creates it).
    let parentOk = false;
    if (!toProblem && !paths.badPath) {
      let missingFrom = null; // the first folder level that isn't there
      for (let depth = 1; depth <= paths.parentParts.length; depth += 1) {
        const folder = path.join(paths.toRoot, ...paths.parentParts.slice(0, depth));
        const stats = await lstatOrNothing(folder);
        if (!stats) {
          missingFrom = depth;
          break;
        }
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          add('parent', 'Destination folder exists', 'fail', `${folder} on the ${toLabel} isn't a normal folder (it's a file or a shortcut).`);
          missingFrom = -1;
          break;
        }
      }
      if (missingFrom === null) {
        parentOk = true;
        add('parent', 'Destination folder exists', 'pass', `${paths.destinationParent} is there.`);
      } else if (missingFrom > 0) {
        const steps = paths.parentParts.slice(missingFrom - 1).map((name, i) => {
          const inside = path.join(paths.toRoot, ...paths.parentParts.slice(0, missingFrom - 1 + i));
          return `create a folder named exactly “${name}” inside “${inside}”`;
        });
        add(
          'parent',
          'Destination folder exists',
          'fail',
          `${paths.destinationParent} doesn't exist yet. In Finder (File ▸ New Folder), ${steps.join(', then ')}. ` +
            'Then press Check again. The dashboard never creates folders on your drives.',
        );
      }
    }

    // Nothing with the project's name at the destination yet.
    if (parentOk) {
      const existing = await lstatOrNothing(paths.destinationPath);
      if (existing) {
        add(
          'destination',
          'Not already at the destination',
          'fail',
          `${paths.destinationPath} already exists. It may be a leftover partial copy from an earlier move that failed or was ` +
            'cancelled. Nothing was started. Look at it in Finder; if it is a partial copy, delete it there yourself, then ' +
            'press Check again. (VeriCopy never overwrites, and the dashboard never deletes.)',
        );
      } else {
        add('destination', 'Not already at the destination', 'pass', `Nothing named “${paths.folderName}” there yet.`);
      }
    }

    // Enough free space: the project + 10%.
    let freeBytes = null;
    const neededBytes = measured ? Math.ceil(measured.bytes * (1 + SPACE_MARGIN)) : null;
    if (!toProblem) {
      freeBytes = (await getSpace(paths.toRoot))?.freeBytes ?? null;
      if (freeBytes === null) {
        add('space', 'Enough free space', 'fail', `Couldn't read how much space is free on the ${toLabel}.`);
      } else if (measured) {
        const fits = freeBytes >= neededBytes;
        add(
          'space',
          'Enough free space',
          fits ? 'pass' : 'fail',
          fits
            ? `${gb(freeBytes)} free; it needs ${gb(neededBytes)} (its size + 10%).`
            : `Only ${gb(freeBytes)} free on the ${toLabel}; it needs ${gb(neededBytes)} (its size + 10%). Make room first.`,
        );
      }
    }

    // Not being worked on: nothing changed for 10 minutes.
    if (measured) {
      if (measured.newestMs !== null && at - measured.newestMs < QUIET_MS) {
        add(
          'quiet',
          'Not changed in the last 10 minutes',
          'fail',
          `Something in it changed ${minutesAgo(measured.newestMs, at)} (${measured.newestFile}). Finish exporting or saving, ` +
            'wait until nothing has changed for 10 minutes, then press Check again.',
        );
      } else {
        add(
          'quiet',
          'Not changed in the last 10 minutes',
          'pass',
          measured.newestMs === null ? 'No dated files.' : `Last change ${minutesAgo(measured.newestMs, at)}.`,
        );
      }
      // Resolve / Premiere. The dashboard can't list running apps (that needs
      // running another program, which its safety rules don't allow), so it
      // warns from what it can see: Premiere's lock file.
      if (measured.premiereLocks.length > 0) {
        add(
          'apps',
          'Not open in an editing app',
          'warn',
          `Premiere Pro seems to be using this project (lock file: ${measured.premiereLocks[0]}). Close it in Premiere before starting.`,
        );
      } else {
        add(
          'apps',
          'Not open in an editing app',
          'info',
          'Close this project in DaVinci Resolve and Premiere Pro before starting. (The dashboard can\'t see which apps are ' +
            'running; the 10-minute check and the spot check catch files that change during the copy.)',
        );
      }
    }

    return {
      found: true,
      project: { id: project.id, name: project.name, relPath: project.relPath, drive: project.drive, kind: project.kind },
      buttonLabel: BUTTON_LABELS[project.drive] ?? null,
      fromDrive: paths.fromDrive,
      toDrive: paths.toDrive ?? null,
      fromLabel,
      toLabel,
      source: paths.source,
      destinationParent: paths.destinationParent,
      destinationPath: paths.destinationPath,
      sizeBytes: measured?.bytes ?? null,
      fileCount: measured?.files ?? null,
      savedSizeBytes: project.sizeBytes,
      freeBytes,
      neededBytes,
      freeAfterBytes: freeBytes !== null && measured ? freeBytes - measured.bytes : null,
      vericopy,
      checks,
      canStart: checks.length > 0 && !checks.some((c) => c.state === 'fail'),
      checkedAt: new Date(at).toISOString(),
    };
  }

  // --- 2. Start (only on your click) ---

  // Returns { started: true, move } or { started: false, reason, message, preview?, move? }:
  //   reason 'not-found' | 'scanning' | 'busy' | 'checks' (a pre-check failed) | 'refused' (VeriCopy said no)
  async function start(projectId) {
    if (isScanning()) {
      return { started: false, reason: 'scanning', message: 'A scan is running. Start the move once it has finished.' };
    }
    if (busyProjects.has(projectId)) {
      return { started: false, reason: 'busy', message: 'This move is already being started.' };
    }
    busyProjects.add(projectId);
    try {
      const config = getConfig();
      // SAFETY: the same checks as a scan before writing to the database.
      assertSafeLocations(config);
      const checked = await preview(projectId);
      if (!checked.found) return { started: false, reason: 'not-found', message: "There's no project with that id." };
      if (!checked.canStart) {
        return { started: false, reason: 'checks', message: 'A pre-check failed, so nothing was started.', preview: checked };
      }
      const client = makeClient(config);
      const move = createMove(
        db,
        {
          projectId: checked.project.id,
          projectPath: checked.project.relPath,
          projectName: checked.project.name,
          fromDrive: checked.fromDrive,
          toDrive: checked.toDrive,
          sourcePath: checked.source,
          destinationParent: checked.destinationParent,
          destinationPath: checked.destinationPath,
          vericopyUrl: client.url,
          sizeBytes: checked.sizeBytes,
          fileCount: checked.fileCount,
        },
        { now: now() },
      );
      starting.add(move.id);
      try {
        const { jobId } = await client.startJob({ source: checked.source, destination: checked.destinationParent });
        noteContact(true);
        const saved = updateMove(
          db,
          move.id,
          { jobId, state: 'queued', vericopyStatus: 'queued', submittedMs: now() },
          { now: now(), note: `VeriCopy accepted it (job ${jobId})` },
        );
        schedule(0);
        return { started: true, move: saved };
      } catch (error) {
        if (!(error instanceof VericopyError)) throw error;
        if (error.code === 'not_running') noteContact(false, vericopyDownText(client.url));
        const message = refusalText(error, { ...checked, url: client.url });
        // A timeout may have started a job we can't follow: that's "lost", not "refused".
        const state = error.code === 'timeout' ? 'lost' : 'refused';
        const saved = updateMove(db, move.id, { state, error: message, finishedMs: now() }, { now: now(), note: `VeriCopy: ${error.code}` });
        return { started: false, reason: 'refused', code: error.code, message, move: saved };
      } finally {
        starting.delete(move.id);
      }
    } finally {
      busyProjects.delete(projectId);
    }
  }

  // --- 3. Following the jobs ---

  // Saves one GET /api/jobs/:id answer onto the move; runs the spot check on "verified".
  async function apply(move, job) {
    const progress = {
      vericopyStatus: job.status,
      progress: job.progress,
      bytesCopied: job.bytesCopied,
      bytesTotal: job.bytesTotal,
      filesTotal: job.filesTotal,
      filesCopied: job.filesCopied,
      filesVerified: job.filesVerified,
      filesFailed: job.filesFailed,
      secondsRemaining: job.secondsRemaining,
      failedFiles: job.failedFiles,
      fatalError: job.fatalError,
    };
    const at = now();
    if (['queued', 'copying', 'verifying'].includes(job.status)) {
      const unchanged =
        move.state === job.status &&
        Object.entries(progress).every(([key, value]) => JSON.stringify(move[key] ?? null) === JSON.stringify(value ?? null));
      if (unchanged) return move;
      return updateMove(db, move.id, { ...progress, state: job.status }, { now: at });
    }
    if (job.status === 'verified') {
      const checking = updateMove(db, move.id, { ...progress, state: 'checking', secondsRemaining: null }, { now: at, note: 'VeriCopy: every file verified' });
      return runSpotCheck(checking);
    }
    if (job.status === 'failed') {
      return updateMove(db, move.id, { ...progress, state: 'failed', error: failedText(job, move), finishedMs: at }, { now: at });
    }
    if (job.status === 'cancelled') {
      return updateMove(
        db,
        move.id,
        { ...progress, state: 'cancelled', error: partialFolderText(move), finishedMs: at },
        { now: at },
      );
    }
    if (job.status === 'copied_unverified') {
      return updateMove(
        db,
        move.id,
        {
          ...progress,
          state: 'unverified',
          error: `VeriCopy copied it without checking checksums, so it isn't known to be good. Not marked as copied. ${partialFolderText(move)}`,
          finishedMs: at,
        },
        { now: at },
      );
    }
    // A status this version doesn't know: keep watching, never a success.
    if (move.vericopyStatus === job.status) return move;
    return updateMove(db, move.id, { vericopyStatus: job.status }, { now: at, note: `VeriCopy reported "${job.status}", unknown to this dashboard` });
  }

  async function runSpotCheck(move) {
    const check = await spotCheck(move, { now: now() });
    const at = now();
    return updateMove(
      db,
      move.id,
      {
        state: check.ok ? 'copied' : 'check_failed',
        spotCheck: check,
        spotCheckOk: check.ok,
        error: check.ok ? null : spotCheckFailedText(check, move),
        finishedMs: at,
      },
      { now: at, note: check.ok ? 'Spot check passed: same file count and bytes' : 'Spot check failed' },
    );
  }

  async function follow(move, client) {
    if (move.state === 'starting') {
      // Still waiting for POST /api/jobs in start(): leave it to start().
      if (starting.has(move.id)) return;
      // The dashboard stopped before VeriCopy answered: the job id was never saved.
      const at = now();
      updateMove(
        db,
        move.id,
        {
          state: 'lost',
          error:
            'Lost: copy state unknown. The dashboard stopped while asking VeriCopy to start this copy, so it never learned ' +
            `the job id. Look in VeriCopy's window, and check ${move.destinationPath} in Finder before trying again.`,
          finishedMs: at,
        },
        { now: at },
      );
      return;
    }
    if (move.state === 'checking') {
      // The dashboard stopped during a spot check: run it again.
      await runSpotCheck(move);
      return;
    }
    let job;
    try {
      job = await client.getJob(move.jobId);
      noteContact(true);
    } catch (error) {
      if (!(error instanceof VericopyError)) throw error;
      if (error.code === 'job_not_found') {
        const at = now();
        updateMove(db, move.id, { state: 'lost', error: lostText(move), finishedMs: at }, { now: at, note: 'VeriCopy: job_not_found' });
        noteContact(true);
      } else if (error.code === 'not_running' || error.code === 'timeout') {
        noteContact(
          false,
          `VeriCopy isn't answering at ${client.url}. If it was quit, its copies stopped; open it again and this page will ` +
            'show what happened.',
        );
      } else {
        noteContact(true, `VeriCopy answered ${error.code}: ${error.message}`);
      }
      return;
    }
    await apply(move, job);
  }

  // One round of polling: every unfinished move, one after another.
  async function round() {
    const moves = unfinishedMoves(db);
    if (moves.length === 0) return;
    const client = makeClient(getConfig());
    for (const move of moves) {
      try {
        await follow(move, client);
      } catch (error) {
        log.error(error);
      }
    }
  }

  // (A second tick while one runs joins it instead of asking twice.)
  async function tick() {
    if (ticking) return ticking;
    const current = round();
    ticking = current;
    try {
      return await current;
    } finally {
      // Cleared only after `ticking` was set: an async function runs on its own
      // until its first await, so clearing inside round() could happen first.
      if (ticking === current) ticking = null;
    }
  }

  // Polling: tick, wait pollMs, tick again... (setTimeout after each round
  // finishes, so two rounds never overlap). `unref` lets the program exit
  // without waiting for the next round. Stays quiet (one database read)
  // while no move is running.
  let polling = false;
  function schedule(delay = pollMs) {
    if (!polling) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await tick();
      } catch (error) {
        log.error(error);
      }
      schedule();
    }, delay);
    timer.unref?.();
  }

  // Called once when the dashboard starts: also picks up unfinished jobs.
  function startPolling() {
    polling = true;
    schedule(0);
  }

  function stopPolling() {
    polling = false;
    clearTimeout(timer);
  }

  // --- Cancel and re-check ---

  async function cancel(moveId) {
    const move = getMove(db, moveId);
    if (!move) return { ok: false, reason: 'not-found', message: "There's no move with that id." };
    if (!move.unfinished || !move.jobId || move.state === 'checking') {
      return { ok: false, reason: 'not-cancellable', message: 'This move is not running in VeriCopy, so there is nothing to cancel.', move };
    }
    const client = makeClient(getConfig());
    try {
      const job = await client.cancelJob(move.jobId);
      noteContact(true);
      const saved = await apply(getMove(db, moveId), job);
      return { ok: true, message: saved.state === 'cancelled' ? `Cancelled. ${partialFolderText(move)}` : 'VeriCopy answered the cancel.', move: saved };
    } catch (error) {
      if (!(error instanceof VericopyError)) throw error;
      if (error.code === 'job_not_cancellable') {
        await tick();
        return { ok: false, reason: 'finished', message: 'VeriCopy had already finished this job, so it could not be cancelled.', move: getMove(db, moveId) };
      }
      if (error.code === 'job_not_found') {
        await tick();
        return { ok: false, reason: 'lost', message: lostText(move), move: getMove(db, moveId) };
      }
      return {
        ok: false,
        reason: 'vericopy',
        message: error.code === 'not_running' ? vericopyDownText(client.url) : `VeriCopy refused the cancel (${error.code}).`,
        move,
      };
    }
  }

  // After a failed spot check (e.g. a drive was unplugged): count again.
  async function recheck(moveId) {
    const move = getMove(db, moveId);
    if (!move) return { ok: false, reason: 'not-found', message: "There's no move with that id." };
    if (move.state !== 'check_failed' || move.vericopyStatus !== 'verified') {
      return { ok: false, reason: 'not-checkable', message: 'Only a verified copy whose spot check failed can be checked again.', move };
    }
    assertSafeLocations(getConfig());
    const saved = await runSpotCheck(updateMove(db, moveId, { state: 'checking' }, { now: now(), note: 'Checking the copy again' }));
    return { ok: saved.state === 'copied', message: saved.state === 'copied' ? 'The copy matches now.' : saved.error, move: saved };
  }

  function status() {
    return { vericopy: { ...contact }, polling };
  }

  return { preview, start, tick, cancel, recheck, startPolling, stopPolling, status };
}

module.exports = { createMover, movePaths, driveProblem, spotCheck, NEXT_DRIVE, BUTTON_LABELS, SPACE_MARGIN, QUIET_MS };
