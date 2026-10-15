'use strict';

// Builds the answers the dashboard's API routes send back (see server.js):
// plain objects that Express turns into JSON for the page. They come from the
// database, the settings, and how full each drive is.
//
// Kept apart from server.js so each route stays a few lines long, and so these
// can be tested without starting a web server. Nothing here writes anything:
// it only reads the database.

const { DRIVE_LABELS, notionSettings } = require('../config');
const {
  latestScan,
  listProjects,
  getProject,
  latestNotionSync,
  listNotionPages,
  getNotionPage,
  notionLinkCounts,
  SAVED_DRIVES,
} = require('../db');
const { scoreProject, isDoneStatus, DAY_MS } = require('../scoring/score');
const { planMoves, planArchiveMoves } = require('../scoring/plan');
const { isPinnedByConfig } = require('../scanner/scan');
const { createMatcher, LIKELY_SCORE } = require('../notion/match');

// A problem with the request itself (a bad filter value, an unknown id).
// server.js answers these with their HTTP status: 400 "bad request", 404 "not found".
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// What each drive is for, in the workflow (shown under its name).
const DRIVE_ROLES = {
  working: 'Editing — cards land here',
  library: 'Done HDD — finished, recent projects',
  archive: 'Everything older',
};

// --- Small helpers ---------------------------------------------------------

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

// "Oct 18, 2026", in this Mac's time zone (the server and the browser run on
// the same Mac, so they agree).
function formatDay(ms) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function plural(n, word) {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

function sum(items, pick) {
  return items.reduce((total, item) => total + pick(item), 0);
}

// { totalBytes, freeBytes } -> the same plus usedBytes and usedPercent.
function spaceDetails(space) {
  if (!space) return null;
  const usedBytes = space.totalBytes - space.freeBytes;
  return {
    totalBytes: space.totalBytes,
    freeBytes: space.freeBytes,
    usedBytes,
    usedPercent: space.totalBytes > 0 ? (usedBytes / space.totalBytes) * 100 : 0,
  };
}

function scanSummary(scan) {
  if (!scan) return null;
  return {
    at: iso(scan.finishedMs),
    startedAt: iso(scan.startedMs),
    projectCount: scan.projectCount,
    fileCount: scan.fileCount,
    totalBytes: scan.totalBytes,
  };
}

// The latest attempt, if it failed AFTER the last scan that finished.
function failureSince(lastScan, lastAttempt) {
  if (!lastAttempt || lastAttempt.status !== 'failed') return null;
  if (lastScan && lastScan.id > lastAttempt.id) return null;
  return { at: iso(lastAttempt.finishedMs), message: String(lastAttempt.errors[0] ?? 'Unknown error').split('\n')[0] };
}

function readString(query, name) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RequestError(400, `"${name}" can only be given once.`);
  return value;
}

// "2026-10-03" -> the first or last millisecond of that day, in this Mac's time zone.
function parseDay(text, name, { endOfDay }) {
  if (text === undefined || text === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new RequestError(400, `"${name}" must be a date like 2026-10-03.`);
  const ms = new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00'}`).getTime();
  if (Number.isNaN(ms)) throw new RequestError(400, `"${name}" isn't a real date: ${text}.`);
  return ms;
}

// A Notion date ("2026-10-03", or with a time) as milliseconds. A plain day is
// read in this Mac's time zone: new Date('2026-10-03') would mean midnight in
// London, which is the evening of Oct 2 in Chicago.
function notionDateMs(text) {
  if (!text) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

// Notion's End date as a hint (not part of the score): "Delivered Oct 3, 2026",
// "Due Oct 20, 2026", or a passed date on a page that isn't done.
function endDateHint(status, endDate, doneStatuses, now = Date.now()) {
  const ms = notionDateMs(endDate);
  if (ms === null) return null;
  const day = formatDay(ms);
  if (isDoneStatus(status, doneStatuses)) return `Delivered ${day}`;
  const today = new Date(now);
  if (ms >= new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) return `Due ${day}`;
  return `End date ${day} has passed (${status ? `still ${status}` : 'no status'} in Notion)`;
}

// What made a project finished, for short reasons: 'Done in Notion', 'Final export', or null.
function finishedBy(project, config) {
  if (isDoneStatus(project.notionStatus, config.doneStatuses)) return 'Done in Notion';
  return project.hasFinalExport ? 'Final export' : null;
}

// --- Tags: the plain-language version of the buckets -------------------------

// One tag per project, shown before the score. Built from the bucket the last
// scan (or pin) saved, so the page always agrees with `npm run report`.
function tagList(config) {
  return [
    {
      id: 'ready',
      label: 'Ready to move to HDD',
      hint: `Finished (Done in Notion, or a final export), and untouched for ${config.ageDays.recent}+ days.`,
    },
    { id: 'check', label: 'Check first', hint: 'Finished but not safe to move yet, or old and big but not finished.' },
    { id: 'keep', label: 'Keep on SSD', hint: 'Not finished yet (no final export, not Done in Notion).' },
    { id: 'pinned', label: 'Pinned to SSD', hint: 'You pinned it as Keep: it stays on the SSD.' },
  ];
}

const TAG_IDS = ['ready', 'check', 'keep', 'pinned'];
const BUCKET_TAGS = { Ready: 'ready', Review: 'check', Keep: 'keep' };

function pinSources(project, config) {
  return {
    database: project.pinnedInDatabase,
    config: isPinnedByConfig(project.relPath, config.folders.keepPinned),
  };
}

function tagOf(project, config) {
  if (!project.scoring) return null;
  const pinned = pinSources(project, config);
  if (project.scoring.bucket === 'Keep' && (pinned.database || pinned.config)) return 'pinned';
  return BUCKET_TAGS[project.scoring.bucket];
}

function daysBefore(scanMs, ms) {
  return ms === null || ms === undefined ? null : Math.max(0, (scanMs - ms) / DAY_MS);
}

// Why a finished project isn't Ready yet, as short phrases for the table (in
// the same order as score.js's readyBlockers).
function shortBlockers(project, daysSinceEdit, config) {
  const reasons = [];
  if (daysSinceEdit === null) reasons.push('No file dates found');
  else if (daysSinceEdit < config.ageDays.recent) {
    reasons.push(`Edited recently — can be ready ${formatDay(project.lastEditedMs + config.ageDays.recent * DAY_MS)}`);
  }
  if (project.futureDatedFiles > 0) reasons.push('Some files have future dates');
  if (project.incomplete) reasons.push("Some folders couldn't be read");
  if (project.newerFootageFile) reasons.push('Has footage newer than its final export');
  return reasons;
}

// One short line under the tag: the main reason for it.
function shortReason(project, tag, { scanMs, config }) {
  const days = daysBefore(scanMs, project.lastEditedMs);
  if (tag === 'ready') return `${finishedBy(project, config)} · untouched ${Math.floor(days)} days`;
  if (tag === 'pinned') {
    const would = /would be (Ready|Review)/.exec(project.scoring.notes.join(' '))?.[1];
    if (would === 'Ready') return 'You pinned it · otherwise ready to move';
    if (would === 'Review') return 'You pinned it · otherwise check first';
    return 'You pinned it';
  }
  if (tag === 'check') {
    if (!finishedBy(project, config)) return 'Old and big, but no final export';
    const reasons = shortBlockers(project, days, config);
    if (reasons.length === 0) return 'Finished — rescan to update';
    return reasons.length === 1 ? reasons[0] : `${reasons[0]} (+${reasons.length - 1} more)`;
  }
  if (tag === 'keep') return project.hasExport ? 'Only draft exports so far' : 'No exports yet';
  return null;
}

// One project as a table row (also used for Library projects, which have no tag).
function projectRow(project, context) {
  const tag = project.drive === 'working' ? tagOf(project, context.config) : null;
  return {
    id: project.id,
    drive: project.drive,
    name: project.name,
    relPath: project.relPath,
    client: project.client,
    sizeBytes: project.sizeBytes,
    bytesByType: project.bytesByType,
    fileCount: project.fileCount,
    lastEdited: iso(project.lastEditedMs),
    hasExport: project.hasExport,
    hasFinalExport: project.hasFinalExport,
    // The linked Notion page's status (null if not linked).
    status: project.notionLink === 'confirmed' ? project.notionStatus : null,
    notionLink: project.drive === 'working' ? project.notionLink : null, // 'confirmed' | 'none' | null
    notionTitle: project.notionLink === 'confirmed' ? project.notionTitle : null,
    tag,
    reason: tag ? shortReason(project, tag, context) : null,
    score: project.scoring?.score ?? null,
    bucket: project.scoring?.bucket ?? null,
    incomplete: project.incomplete,
    missing: project.missing,
    firstSeen: iso(project.firstSeenMs),
    lastScanned: iso(project.lastScannedMs),
  };
}

function presentProjects(db, drive) {
  return listProjects(db, { drive }).filter((p) => p.kind === 'project' && !p.missing);
}

function totalsByType(projects) {
  const totals = { raw: 0, proxy: 0, export: 0, cache: 0, project: 0, other: 0 };
  for (const p of projects) for (const type of Object.keys(totals)) totals[type] += p.bytesByType[type] ?? 0;
  return totals;
}

// --- GET /api/drives ---------------------------------------------------------

//   spaces – from space.allDriveSpace(config): [{ drive, label, path, space | null }]
function drivesView({ db, config, spaces }) {
  return {
    drives: spaces.map(({ drive, path, space }) => {
      const scanned = SAVED_DRIVES.includes(drive);
      const lastScan = scanned ? latestScan(db, 'finished', { drive }) : undefined;
      const lastAttempt = scanned ? latestScan(db, undefined, { drive }) : undefined;
      return {
        drive,
        label: DRIVE_LABELS[drive],
        role: DRIVE_ROLES[drive],
        path,
        connected: space !== null,
        space: spaceDetails(space),
        // How full it was at its last scan, for when it's unplugged.
        lastKnownSpace: lastScan?.driveSpace ? { ...spaceDetails(lastScan.driveSpace), at: iso(lastScan.finishedMs) } : null,
        // Scan now reads this drive's folders (the Archive is only measured).
        scannedByButton: scanned,
        lastScan: scanSummary(lastScan),
        lastFailure: failureSince(lastScan, lastAttempt),
        limitPercent: drive === 'library' ? config.libraryFull.startAtPercent : null,
      };
    }),
  };
}

// --- GET /api/summary --------------------------------------------------------

// The space each drive has now, or (when it's unplugged) at its last scan.
function spacesWithFallback(db, spaces) {
  return spaces.map((entry) => {
    if (entry.space || !SAVED_DRIVES.includes(entry.drive)) return { ...entry, lastKnown: false };
    const known = latestScan(db, 'finished', { drive: entry.drive })?.driveSpace;
    return { ...entry, space: known ? spaceDetails(known) : null, lastKnown: Boolean(known) };
  });
}

function summaryView({ db, config, spaces }) {
  const lastScan = latestScan(db, 'finished');
  const lastAttempt = latestScan(db);
  const projects = presentProjects(db, 'working').filter((p) => p.scoring);
  const shared = listProjects(db).filter((p) => p.kind === 'shared' && !p.missing);

  const tagCounts = Object.fromEntries(TAG_IDS.map((id) => [id, { count: 0, bytes: 0 }]));
  for (const p of projects) {
    const counts = tagCounts[tagOf(p, config)];
    counts.count += 1;
    counts.bytes += p.sizeBytes;
  }

  const known = spacesWithFallback(db, spaces);
  const plan = planMoves({ projects, spaces: known, libraryFull: config.libraryFull });
  const lastKnown = (drive) => known.find((s) => s.drive === drive)?.lastKnown ?? false;
  const connected = (drive) => spaces.some((s) => s.drive === drive && s.space !== null);

  return {
    hasScan: Boolean(lastScan),
    lastScan: scanSummary(lastScan),
    lastFailure: failureSince(lastScan, lastAttempt),
    ready: tagCounts.ready,
    tagCounts,
    projectCount: projects.length,
    projectBytes: sum(projects, (p) => p.sizeBytes),
    working: {
      connected: connected('working'),
      lastKnown: lastKnown('working'),
      percentNow: plan.workingPercentNow,
      percentAfter: plan.workingPercentAfter,
    },
    library: {
      configured: spaces.some((s) => s.drive === 'library'),
      connected: connected('library'),
      lastKnown: lastKnown('library'),
      known: plan.libraryConnected,
      fits: plan.fitsOnLibrary,
      percentNow: plan.libraryPercentNow,
      percentAfter: plan.libraryPercentAfter,
      shortBytes: plan.fitsOnLibrary === false ? -plan.libraryFreeAfterBytes : 0,
      status: plan.libraryStatus,
      limitPercent: config.libraryFull.startAtPercent,
    },
    shared: { count: shared.length, bytes: sum(shared, (p) => p.sizeBytes), names: shared.map((p) => p.name) },
    nightlyScan: config.server.nightlyScan,
  };
}

// --- GET /api/projects -------------------------------------------------------

// Filters (all optional, all in the address after "?"):
//   drive  – 'working' (default) or 'library'
//   tag    – ready | check | keep | pinned (Working SSD only)
//   client – a client name, or empty (client=) for projects with no client
//   from, to – last edited between these days (YYYY-MM-DD), inclusive
//   notion – unlinked (not linked yet) | no-page (marked "No Notion page") | linked
//   status – a Notion status, e.g. Done (linked projects with that status)
// Sorted by score, highest first (ties: biggest first). Library projects have
// no score, so they're sorted oldest first.
function projectsView({ db, config, query = {} }) {
  const drive = readString(query, 'drive') ?? 'working';
  if (!SAVED_DRIVES.includes(drive)) throw new RequestError(400, `"drive" must be one of: ${SAVED_DRIVES.join(', ')}.`);
  const tag = readString(query, 'tag') || undefined;
  if (tag !== undefined && !TAG_IDS.includes(tag)) throw new RequestError(400, `"tag" must be one of: ${TAG_IDS.join(', ')}.`);
  const client = readString(query, 'client');
  const fromMs = parseDay(readString(query, 'from'), 'from', { endOfDay: false });
  const toMs = parseDay(readString(query, 'to'), 'to', { endOfDay: true });
  if (fromMs !== null && toMs !== null && fromMs > toMs) throw new RequestError(400, '"from" must be on or before "to".');
  const notion = readString(query, 'notion') || undefined;
  if (notion !== undefined && !Object.hasOwn(NOTION_FILTERS, notion)) {
    throw new RequestError(400, `"notion" must be one of: ${Object.keys(NOTION_FILTERS).join(', ')}.`);
  }
  const status = readString(query, 'status') || undefined;

  const lastScan = latestScan(db, 'finished', { drive });
  const context = { config, scanMs: lastScan?.startedMs ?? Date.now() };
  const all = presentProjects(db, drive).map((p) => projectRow(p, context));
  const clients = [...new Set(all.map((p) => p.client).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  // Client and dates first; the tag counts are worked out from what's left,
  // so each tag button shows how many it would show with the other filters.
  let rows = all.filter((p) => client === undefined || (client === '' ? !p.client : p.client === client));
  if (fromMs !== null || toMs !== null) {
    rows = rows.filter((p) => {
      if (p.lastEdited === null) return false;
      const ms = Date.parse(p.lastEdited);
      return (fromMs === null || ms >= fromMs) && (toMs === null || ms <= toMs);
    });
  }
  if (notion !== undefined) rows = rows.filter((p) => p.notionLink === NOTION_FILTERS[notion]);
  if (status !== undefined) rows = rows.filter((p) => (p.status ?? '').toLowerCase() === status.trim().toLowerCase());
  const tagCounts = Object.fromEntries(TAG_IDS.map((id) => [id, rows.filter((p) => p.tag === id).length]));
  if (drive === 'working' && tag) rows = rows.filter((p) => p.tag === tag);

  if (drive === 'working') {
    rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.sizeBytes - a.sizeBytes);
  } else {
    rows.sort(oldestFirst);
  }
  return {
    drive,
    lastScan: scanSummary(lastScan),
    tags: drive === 'working' ? tagList(config) : [],
    tagCounts: drive === 'working' ? tagCounts : null,
    clients,
    hasNoClient: all.some((p) => !p.client),
    // For the Notion filter: the statuses in use, and how many aren't linked yet.
    statuses: [...new Set(all.map((p) => p.status).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    notionCounts: Object.fromEntries(Object.entries(NOTION_FILTERS).map(([id, link]) => [id, all.filter((p) => p.notionLink === link).length])),
    totalCount: all.length,
    projects: rows,
    totals: { count: rows.length, bytes: sum(rows, (p) => p.sizeBytes), byType: totalsByType(rows) },
  };
}

// The `notion` filter's values -> the link they select.
const NOTION_FILTERS = { unlinked: null, 'no-page': 'none', linked: 'confirmed' };

// Oldest last edit first; projects with no dated files go last.
function oldestFirst(a, b) {
  if (a.lastEdited === null || b.lastEdited === null) return (a.lastEdited === null) - (b.lastEdited === null);
  return Date.parse(a.lastEdited) - Date.parse(b.lastEdited) || b.sizeBytes - a.sizeBytes;
}

// --- GET /api/projects/:id ---------------------------------------------------

// The saved subfolders (a flat list, biggest first) as a tree, each level
// biggest first. `otherBytes` = files directly in that folder, plus any
// subfolders too small to be kept (the scan keeps the biggest 300, 3 levels deep).
function folderTree(subfolders, totalBytes) {
  const root = { path: '', sizeBytes: totalBytes, children: [] };
  const byPath = new Map([['', root]]);
  const depth = (p) => p.split('/').length;
  for (const folder of [...subfolders].sort((a, b) => depth(a.path) - depth(b.path))) {
    const slash = folder.path.lastIndexOf('/');
    const parent = byPath.get(slash === -1 ? '' : folder.path.slice(0, slash));
    if (!parent) continue; // its parent wasn't kept (can't happen: parents are always bigger)
    const node = {
      name: folder.path.slice(slash + 1),
      path: folder.path,
      depth: depth(folder.path),
      sizeBytes: folder.sizeBytes,
      fileCount: folder.fileCount,
      children: [],
    };
    byPath.set(folder.path, node);
    parent.children.push(node);
  }
  const finish = (node) => {
    node.children.sort((a, b) => b.sizeBytes - a.sizeBytes);
    node.children.forEach(finish);
    node.otherBytes = Math.max(0, node.sizeBytes - sum(node.children, (c) => c.sizeBytes));
  };
  finish(root);
  return { folders: root.children, otherBytes: root.otherBytes };
}

// The Ready checklist: each thing a project needs before it's Ready to move.
//   state: 'pass' | 'fail' | 'info' (not part of the rule) | 'na' (doesn't apply)
function readyChecks(project, scoring, context) {
  const { config } = context;
  const { recent } = config.ageDays;
  const days = scoring.daysSinceEdit;
  const checks = [];

  const finishedLabel = 'Finished (Done in Notion, or a final export)';
  if (isDoneStatus(project.notionStatus, config.doneStatuses)) {
    const alsoExport = project.hasFinalExport ? ` Final export: ${project.finalExportFile}` : '';
    checks.push({ id: 'finished', label: finishedLabel, state: 'pass', detail: `Done in Notion ("${project.notionTitle}").${alsoExport}` });
  } else if (project.hasFinalExport) {
    checks.push({ id: 'finished', label: finishedLabel, state: 'pass', detail: project.finalExportFile });
  } else {
    checks.push({
      id: 'finished',
      label: finishedLabel,
      state: 'fail',
      detail: project.hasExport
        ? `Only draft exports so far (e.g. ${project.exportExampleFile}). Name the finished export "Final" or "FD", ` +
          'or save it in a "Final Exports" folder — or mark it Done in Notion.'
        : 'No exports found in this folder, and not Done in Notion.',
    });
  }
  checks.push(notionCheck(project, config, context.now));

  if (days === null) {
    checks.push({ id: 'untouched', label: `Untouched for ${recent}+ days`, state: 'fail', detail: 'No file dates were found.' });
  } else {
    const edited = `Last edited ${formatDay(project.lastEditedMs)} (${plural(Math.floor(days), 'day')} before the last scan): ${project.lastEditedFile}`;
    checks.push({
      id: 'untouched',
      label: `Untouched for ${recent}+ days`,
      state: days >= recent ? 'pass' : 'fail',
      detail:
        days >= recent ? edited : `${edited}. Can be ready ${formatDay(project.lastEditedMs + recent * DAY_MS)} if left alone.`,
    });
  }

  checks.push(
    !project.hasFinalExport
      ? { id: 'newer-footage', label: 'No footage newer than the final export', state: 'na', detail: 'Applies once there is a final export.' }
      : project.newerFootageFile
        ? {
            id: 'newer-footage',
            label: 'No footage newer than the final export',
            state: 'fail',
            detail:
              `${project.newerFootageFile} is more than a day newer than the final export. If that's new footage, ` +
              "another shoot may still need editing; if it's a cut-down or re-export, move it into Exports or name it Final/FD.",
          }
        : { id: 'newer-footage', label: 'No footage newer than the final export', state: 'pass', detail: null },
  );

  checks.push(
    project.futureDatedFiles > 0
      ? {
          id: 'dates',
          label: 'File dates look right',
          state: 'fail',
          detail: `${plural(project.futureDatedFiles, 'file')} dated in the future (a camera with a wrong clock?), so the real last edit is unknown.`,
        }
      : { id: 'dates', label: 'File dates look right', state: 'pass', detail: null },
  );

  checks.push(
    project.incomplete
      ? {
          id: 'readable',
          label: 'Every folder could be read',
          state: 'fail',
          detail: "Some folders couldn't be read in the last scan, so these facts may be out of date.",
        }
      : { id: 'readable', label: 'Every folder could be read', state: 'pass', detail: null },
  );

  const pins = pinSources(project, config);
  const sources = [pins.database && 'the Pin button / npm run pin', pins.config && 'folders.keepPinned in config.json'].filter(Boolean);
  checks.push({
    id: 'pinned',
    label: 'Not pinned to the SSD',
    state: sources.length > 0 ? 'fail' : 'pass',
    detail: sources.length > 0 ? `Pinned by ${sources.join(' and ')}. A pinned project always stays.` : null,
  });

  return checks;
}

// "Done in Notion": the signal that shows why a project with no final export
// can still be Ready. 'pass' when the linked page is Done, 'info' when it's
// linked but not done (the export rule decides), 'na' when not linked.
function notionCheck(project, config, now) {
  const base = { id: 'notion', label: 'Done in Notion' };
  if (project.notionLink === 'confirmed') {
    const done = isDoneStatus(project.notionStatus, config.doneStatuses);
    const facts = [
      `"${project.notionTitle}" is ${project.notionStatus ? `"${project.notionStatus}"` : 'without a status'}`,
      endDateHint(project.notionStatus, project.notionEndDate, config.doneStatuses, now),
    ]
      .filter(Boolean)
      .join(' · ');
    return done
      ? { ...base, state: 'pass', detail: `${facts}. That alone makes it finished (Done = 100).` }
      : { ...base, state: 'info', detail: `${facts}. Not done in Notion yet, so the final export decides.` };
  }
  if (project.notionLink === 'none') {
    return { ...base, state: 'na', detail: 'You marked it "No Notion page", so the final export decides.' };
  }
  return { ...base, state: 'na', detail: 'Not linked to a Notion page yet (see Link to Notion). Until then, the final export decides.' };
}

// The score, part by part: "Done 70 × 0.45 = 31.5 points".
function scoreParts(project, scoring, largest, config) {
  const { weights, ageDays } = config;
  const days = scoring.daysSinceEdit;
  const sizeShare = largest.sizeBytes > 0 ? Math.round((project.sizeBytes / largest.sizeBytes) * 100) : 0;
  return [
    {
      id: 'done',
      label: 'Done',
      value: scoring.parts.done,
      weight: weights.done,
      why:
        scoring.parts.done === 100
          ? `Done in Notion ("${project.notionTitle}")`
          : scoring.parts.done === 70
            ? 'it has a final export'
            : 'no final export yet, not Done in Notion',
    },
    {
      id: 'age',
      label: 'Age',
      value: scoring.parts.age,
      weight: weights.age,
      why:
        days === null
          ? 'no dated files'
          : `${plural(Math.floor(days), 'day')} since the last edit (0 up to ${ageDays.recent} days, 100 at ${ageDays.max}+)`,
    },
    {
      id: 'size',
      label: 'Size',
      value: scoring.parts.size,
      weight: weights.size,
      why:
        largest.id === project.id ? 'the biggest project on the SSD' : `${sizeShare}% of the biggest project (${largest.name})`,
    },
  ].map((part) => ({ ...part, points: Math.round(part.value * part.weight * 10) / 10 }));
}

function projectDetailView({ db, config, id }) {
  const project = getProject(db, id);
  if (!project) throw new RequestError(404, "There's no project with that id. It may be from an older database.");
  const lastScan = latestScan(db, 'finished', { drive: project.drive });
  const context = { config, scanMs: lastScan?.startedMs ?? Date.now(), now: Date.now() };

  const result = {
    project: {
      ...projectRow(project, context),
      kind: project.kind,
      driveLabel: DRIVE_LABELS[project.drive],
      lastEditedFile: project.lastEditedFile,
      lastProjectSave: iso(project.lastProjectSaveMs),
      lastProjectSaveFile: project.lastProjectSaveFile,
      exportExampleFile: project.exportExampleFile,
      finalExportFile: project.finalExportFile,
      newerFootageFile: project.newerFootageFile,
      futureDatedFiles: project.futureDatedFiles,
    },
    lastScan: scanSummary(lastScan),
    tree: folderTree(project.subfolders, project.sizeBytes),
    treeDepth: 3,
    scoring: null,
    pin: null,
    notion: null,
  };
  if (project.drive !== 'working' || project.kind !== 'project') return result;

  const page = project.notionPageId ? getNotionPage(db, project.notionPageId) : undefined;
  result.notion = {
    link: project.notionLink, // 'confirmed' | 'none' | null (not decided yet)
    pageId: project.notionPageId,
    title: project.notionTitle,
    status: project.notionStatus,
    endDate: project.notionEndDate,
    endHint: project.notionLink === 'confirmed' ? endDateHint(project.notionStatus, project.notionEndDate, config.doneStatuses, context.now) : null,
    doneInNotion: isDoneStatus(project.notionStatus, config.doneStatuses),
    syncedAt: iso(project.notionSyncedMs),
    decidedAt: iso(project.linkDecidedMs),
    url: page?.url ?? null,
    // The page wasn't in the last sync: deleted in Notion, or no longer shared.
    pageGone: page ? !page.inLastSync : false,
  };

  const pins = pinSources(project, config);
  result.pin = { ...pins, pinned: pins.database || pins.config };
  if (project.missing || !project.scoring) return result;

  // Work the score out again from the saved facts, the same way the last scan
  // (or pin) did, to show each part. If it comes out different, config.json
  // was edited since; the saved score is what the rest of the page shows.
  const others = presentProjects(db, 'working');
  const largest = others.reduce((big, p) => (p.sizeBytes > big.sizeBytes ? p : big), project);
  const fresh = scoreProject({ ...project, pinnedKeep: result.pin.pinned }, config, {
    now: context.scanMs,
    largestBytes: largest.sizeBytes,
  });
  const tag = tagOf(project, config);
  result.scoring = {
    score: project.scoring.score,
    bucket: project.scoring.bucket,
    tag,
    tagLabel: tagList(config).find((t) => t.id === tag)?.label ?? null,
    reason: shortReason(project, tag, context),
    notes: project.scoring.notes,
    checks: readyChecks(project, fresh, context),
    parts: scoreParts(project, fresh, largest, config),
    formula: `${config.weights.done} × Done + ${config.weights.age} × Age + ${config.weights.size} × Size`,
    reviewThreshold: config.buckets.review,
    stale: fresh.score !== project.scoring.score || fresh.bucket !== project.scoring.bucket,
    freshScore: fresh.score,
  };
  return result;
}

// --- POST /api/projects/:id/pin ----------------------------------------------

// togglePinById()'s outcome, in plain words for the page.
function pinResultView(outcome) {
  const { result, project } = outcome;
  const name = project ? `"${project.name}"` : 'This project';
  const messages = {
    pinned: `Pinned ${name}: it stays on the SSD.`,
    unpinned: outcome.stillPinnedByConfig
      ? `Removed your pin, but config.json also pins ${name} (folders.keepPinned), so it stays. Remove it there to unpin it.`
      : `Unpinned ${name}.`,
    'pinned-in-config':
      `${name} is pinned in config.json (folders.keepPinned). The app never edits that file: ` +
      'remove the name there, then press Scan now, to unpin it.',
    shared: `${name} is a shared folder: shared folders are never ranked, so there's nothing to pin.`,
    'not-on-working': 'Pins are for Working SSD projects.',
    'not-found': "There's no project with that id.",
  };
  return {
    result,
    ok: ['pinned', 'unpinned', 'pinned-in-config'].includes(result),
    message: messages[result],
    missing: Boolean(project?.missing),
  };
}

// --- GET /api/library (the Done HDD page) -------------------------------------

function libraryView({ db, config, spaces }) {
  const configured = typeof config.drives.library === 'string' && config.drives.library.trim() !== '';
  const live = spaces.find((s) => s.drive === 'library')?.space ?? null;
  const lastScan = latestScan(db, 'finished', { drive: 'library' });
  const lastAttempt = latestScan(db, undefined, { drive: 'library' });
  const space = spaceDetails(live ?? lastScan?.driveSpace ?? null);
  const context = { config, scanMs: lastScan?.startedMs ?? Date.now() };

  const projects = presentProjects(db, 'library');
  const shared = listProjects(db, { drive: 'library' }).filter((p) => p.kind === 'shared' && !p.missing);
  const ready = presentProjects(db, 'working').filter((p) => p.scoring?.bucket === 'Ready');
  const readyBytes = sum(ready, (p) => p.sizeBytes);
  const plan = planArchiveMoves({ libraryProjects: projects, space, libraryFull: config.libraryFull, incomingBytes: readyBytes });
  const suggested = new Set((plan?.moves ?? []).map((p) => p.id));
  const archive = spaces.find((s) => s.drive === 'archive');

  return {
    configured,
    path: config.drives.library,
    connected: live !== null,
    space,
    spaceIsLastKnown: live === null && space !== null,
    lastScan: scanSummary(lastScan),
    lastFailure: failureSince(lastScan, lastAttempt),
    limitPercent: config.libraryFull.startAtPercent,
    targetPercent: config.libraryFull.targetPercent,
    ready: { count: ready.length, bytes: readyBytes },
    plan: plan && { ...plan, moves: plan.moves.map((p) => projectRow(p, context)) },
    projects: projects
      .map((p) => ({ ...projectRow(p, context), suggested: suggested.has(p.id) }))
      .sort(oldestFirst),
    totals: { count: projects.length, bytes: sum(projects, (p) => p.sizeBytes), byType: totalsByType(projects) },
    shared: { count: shared.length, bytes: sum(shared, (p) => p.sizeBytes) },
    archive: archive
      ? { configured: true, connected: archive.space !== null, space: spaceDetails(archive.space), path: archive.path }
      : { configured: false, connected: false, space: null, path: '' },
  };
}

// --- GET /api/notion: the "Notion: connected / not connected" line ------------

//   syncing – a sync is running right now
function notionView({ db, config, syncing = false }) {
  const settings = notionSettings(config);
  const lastSync = latestNotionSync(db, 'finished');
  const lastAttempt = latestNotionSync(db);
  const lastFailure =
    lastAttempt && lastAttempt.status === 'failed' && (!lastSync || lastAttempt.id > lastSync.id)
      ? { at: iso(lastAttempt.finishedMs), message: lastAttempt.error }
      : null;
  let state;
  if (!settings.token) state = 'no-token';
  else if (!settings.dataSourceId) state = 'no-data-source';
  else if (lastFailure) state = 'failed';
  else if (!lastSync) state = 'never-synced';
  else state = 'connected';
  const details = {
    'no-token': 'No Notion token in config.json yet (notion.token). The README walks you through making one.',
    'no-data-source': 'No data source ID in config.json yet (notion.dataSourceId).',
    failed: lastFailure?.message,
    'never-synced': 'Press Refresh Notion to read your Projects board.',
    connected: null,
  };
  const pages = listNotionPages(db).filter((p) => p.inLastSync).length;
  return {
    state, // connected | never-synced | failed | no-token | no-data-source
    connected: state === 'connected',
    configured: settings.configured,
    headline: { connected: 'Notion: connected', 'never-synced': 'Notion: not synced yet' }[state] ?? 'Notion: not connected',
    detail: details[state],
    syncing,
    lastSync: lastSync ? { at: iso(lastSync.finishedMs), pageCount: lastSync.pageCount } : null,
    lastFailure,
    // Not connected, but statuses from an earlier sync are still being used.
    usingSavedStatuses: state !== 'connected' && Boolean(lastSync),
    pageCount: pages,
    counts: notionLinkCounts(db),
    doneStatuses: config.doneStatuses,
  };
}

// --- GET /api/notion/links: the Link to Notion page ---------------------------

const LINK_SHOWS = ['todo', 'linked', 'none'];
const LINK_STATES = { todo: null, linked: 'confirmed', none: 'none' };

// Filters (all optional):
//   show   – todo (not linked yet, the default) | linked | none ("No Notion page")
//   client – only this container's folders ("" for folders with no container)
//   id     – just this one project, whatever its link (the project page's "Change")
// Each row has its top 3 suggested Notion pages. The to-do list is sorted best
// suggestion first, so the easy confirmations come first.
function notionLinksView({ db, config, query = {}, syncing = false }) {
  const show = readString(query, 'show') || 'todo';
  if (!LINK_SHOWS.includes(show)) throw new RequestError(400, `"show" must be one of: ${LINK_SHOWS.join(', ')}.`);
  const client = readString(query, 'client');
  const idText = readString(query, 'id');
  if (idText !== undefined && !/^\d+$/.test(idText)) throw new RequestError(400, '"id" must be a project id.');

  const projects = presentProjects(db, 'working');
  const pages = listNotionPages(db);
  const current = pages.filter((p) => p.inLastSync);
  // Which folders each page is already linked to (to say so, and to rank it lower).
  const linkedTo = new Map();
  for (const p of projects) {
    if (p.notionLink !== 'confirmed') continue;
    if (!linkedTo.has(p.notionPageId)) linkedTo.set(p.notionPageId, []);
    linkedTo.get(p.notionPageId).push({ id: p.id, name: p.name });
  }
  const matcher = createMatcher(
    projects,
    current.map((p) => ({ pageId: p.pageId, title: p.title, status: p.status, linkedTo: linkedTo.get(p.pageId) })),
  );
  const pageById = new Map(pages.map((p) => [p.pageId, p]));

  const inClient = projects.filter((p) => client === undefined || (client === '' ? !p.client : p.client === client));
  const counts = Object.fromEntries(LINK_SHOWS.map((id) => [id, inClient.filter((p) => p.notionLink === LINK_STATES[id]).length]));
  const chosen =
    idText !== undefined
      ? projects.filter((p) => p.id === Number(idText))
      : inClient.filter((p) => p.notionLink === LINK_STATES[show]);
  if (idText !== undefined && chosen.length === 0) {
    throw new RequestError(404, "There's no Working SSD project with that id (it may no longer be on the SSD).");
  }

  const rows = chosen.map((p) => {
    const page = p.notionPageId ? pageById.get(p.notionPageId) : undefined;
    return {
      id: p.id,
      name: p.name,
      relPath: p.relPath,
      client: p.client,
      sizeBytes: p.sizeBytes,
      lastEdited: iso(p.lastEditedMs),
      link: {
        state: p.notionLink,
        pageId: p.notionPageId,
        title: p.notionTitle,
        status: p.notionStatus,
        pageGone: page ? !page.inLastSync : false,
      },
      suggestions: matcher.suggest(p),
    };
  });
  const best = (row) => row.suggestions[0]?.score ?? 0;
  rows.sort((a, b) => (show === 'todo' && idText === undefined ? best(b) - best(a) : 0) || a.name.localeCompare(b.name));

  return {
    notion: notionView({ db, config, syncing }),
    show,
    counts,
    clients: [...new Set(projects.map((p) => p.client).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    rows,
    // Every page from the last sync, A to Z, for the "other page" dropdown.
    pages: current.map((p) => ({ pageId: p.pageId, title: p.title || '(Untitled)', status: p.status })),
    likelyScore: Math.round(LIKELY_SCORE * 100),
  };
}

// setNotionLinks()'s outcome, in plain words for the page.
function notionLinkResultView(outcome, { action, count }) {
  if (outcome.result !== 'ok') return { ok: false, result: outcome.result, message: outcome.problem };
  const what = count === 1 ? `"${outcome.projects[0]?.name ?? 'The project'}"` : `${count} folders`;
  const messages = {
    confirm: `Linked ${what} to "${outcome.projects[0]?.notionTitle}".`,
    none: `Marked ${what}: no Notion page.`,
    clear: `${what} ${count === 1 ? 'is' : 'are'} back on the "not linked yet" list.`,
  };
  return {
    ok: true,
    result: 'ok',
    message: messages[action],
    projects: outcome.projects.map((p) => ({ id: p.id, name: p.name, score: p.scoring.score, bucket: p.scoring.bucket })),
  };
}

module.exports = {
  RequestError,
  drivesView,
  summaryView,
  projectsView,
  projectDetailView,
  pinResultView,
  libraryView,
  notionView,
  notionLinksView,
  notionLinkResultView,
  folderTree,
  tagList,
  endDateHint,
};
