'use strict';

// Turns results into the text reports that `npm run scan` and `npm run report`
// print. Only formatting lives here: no disk access, no database, and no
// scoring math.

// Finder counts in decimal units: 1 GB = 1,000,000,000 bytes. (Some tools,
// like `du -h`, use 1,073,741,824 instead, which gives ~7% smaller numbers.)
const BYTES_PER_GB = 1e9;
const CATEGORY_ORDER = ['raw', 'proxy', 'export', 'cache', 'project', 'other'];

function formatGB(bytes, decimals = 2) {
  return (bytes / BYTES_PER_GB).toFixed(decimals);
}

function formatCount(n) {
  return n.toLocaleString('en-US');
}

function plural(n, word, pluralWord = `${word}s`) {
  return `${formatCount(n)} ${n === 1 ? word : pluralWord}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Dates are shown in your computer's local time zone.
function formatDate(ms, { withTime = false } = {}) {
  if (ms === null || ms === undefined) return '—';
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return withTime ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date;
}

function shortenText(text, width) {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

// Shortens a path-like name but keeps its LAST part whole, because that's the
// part that tells rows apart:
//   "Next Elite Soccer Training / Session 2" -> "Next Elite Soc… / Session 2"
function shortenPath(text, width, separator = ' / ') {
  if (text.length <= width) return text;
  const cut = text.lastIndexOf(separator);
  if (cut === -1) return shortenText(text, width);
  const tail = text.slice(cut + separator.length);
  const room = width - tail.length - separator.length;
  if (room < 4) {
    // Even the last part alone is too long: keep as much of it as fits.
    const tailRoom = width - separator.length - 1;
    return tailRoom >= 4 ? `…${separator}${shortenText(tail, tailRoom)}` : shortenText(text, width);
  }
  return `${shortenText(text.slice(0, cut), room)}${separator}${tail}`;
}

// Terminal colors, using "ANSI escape codes" — special characters that most
// terminals understand as "switch to green", etc. Turned off when the output
// goes to a file or another program.
function makePainter(enabled) {
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { bold: wrap('1'), dim: wrap('2'), green: wrap('32'), yellow: wrap('33'), red: wrap('31') };
}

// Lines up rows of text into columns.
//   columns: [{ header, align: 'left'|'right', flex?, shorten?, paint? }]
//   rows:    arrays of strings, one per column
// The one `flex` column (the project name) shrinks to fit the terminal width,
// using the column's `shorten` function if it has one. Pass width: Infinity
// to never shorten (e.g. when saving the report to a file).
function renderTable(columns, rows, { width = 100, indent = '  ', gap = '  ' } = {}) {
  const natural = columns.map((col, i) => Math.max(col.header.length, ...rows.map((row) => row[i].length)));
  const flexIndex = columns.findIndex((col) => col.flex);
  if (flexIndex !== -1) {
    const fixed = natural.reduce((sum, w, i) => (i === flexIndex ? sum : sum + w), 0);
    const room = width - 1 - indent.length - gap.length * (columns.length - 1) - fixed;
    natural[flexIndex] = Math.min(natural[flexIndex], Math.max(20, room));
  }
  const last = columns.length - 1;
  const formatCell = (text, i, isHeader) => {
    const col = columns[i];
    const fitted = (col.shorten || shortenText)(text, natural[i]);
    let cell = col.align === 'right' ? fitted.padStart(natural[i]) : fitted;
    if (col.align !== 'right' && i !== last) cell = cell.padEnd(natural[i]);
    return !isHeader && col.paint ? col.paint(cell, text) : cell;
  };
  const lines = [indent + columns.map((col, i) => formatCell(col.header, i, true)).join(gap)];
  for (const row of rows) lines.push(indent + row.map((cell, i) => formatCell(cell, i, false)).join(gap));
  return lines;
}

function bucketPainter(paint) {
  return (cell, bucket) => {
    if (bucket === 'Ready') return paint.green(cell);
    if (bucket === 'Review') return paint.yellow(cell);
    return paint.dim(cell);
  };
}

function sum(items, pick) {
  return items.reduce((total, item) => total + pick(item), 0);
}

// --- Sections ----------------------------------------------------------------

function headerSection({ scan, configSource, elapsedMs }, paint) {
  const projectBytes = sum(scan.projects, (p) => p.sizeBytes);
  const sharedBytes = sum(scan.shared, (p) => p.sizeBytes);
  const looseBytes = sum(scan.looseFiles, (f) => f.sizeBytes);
  return [
    paint.bold('SSD Offload Dashboard — scan report'),
    `  Drive     ${scan.root}`,
    `  Settings  ${configSource}`,
    `  Scanned   ${plural(scan.projects.length, 'project')} + ${plural(scan.shared.length, 'shared folder')} · ` +
      `${plural(scan.filesScanned + scan.looseFiles.length, 'file')} · ${formatGB(projectBytes + sharedBytes + looseBytes)} GB · ` +
      `${(elapsedMs / 1000).toFixed(1)} s`,
    `  Finished  ${formatDate(scan.scannedAt + elapsedMs, { withTime: true })}`,
    ...scopeNote(scan.scope).map((line) => paint.dim(line)),
  ];
}

function scopeNote(scope) {
  const sizeCaveat = [
    '            Size scores only compare projects within THIS scan, so scores can be higher than in a full',
    '            `npm run scan`. Use a full scan before deciding what to offload.',
  ];
  if (scope === 'inside-ssd') {
    return [
      '  Note      This scan covers one folder (--root). Config folder lists still match by their path on the SSD;',
      '            "name not found" warnings are off because the rest of the SSD wasn\'t looked at.',
      ...sizeCaveat,
    ];
  }
  if (scope === 'elsewhere') {
    return [
      '  Note      This folder isn\'t on your SSD ("ssdPath" in config), so config folder lists are matched',
      '            from this folder down, and "name not found" warnings are off.',
      ...sizeCaveat,
    ];
  }
  return [];
}

function projectTableSection({ projects, scored, width }, paint) {
  const lines = [
    '',
    paint.bold(scored ? 'Projects — best offload candidates first' : 'Projects — largest first'),
  ];
  if (projects.length === 0) return [...lines, '  (no project folders found)'];

  const columns = [
    { header: '#', align: 'right' },
    { header: 'Project', align: 'left', flex: true, shorten: shortenPath },
    { header: 'Size (GB)', align: 'right' },
    { header: 'Last edited', align: 'left' },
    { header: 'Export', align: 'left' },
  ];
  if (scored) {
    columns.push({ header: 'Score', align: 'right' }, { header: 'Bucket', align: 'left', paint: bucketPainter(paint) });
  }

  const rows = projects.map((p, i) => {
    const row = [String(i + 1), p.name, formatGB(p.sizeBytes), formatDate(p.lastEditedMs), p.hasExport ? 'yes' : 'no'];
    if (scored) row.push(p.scoring.score.toFixed(1), p.scoring.bucket);
    return row;
  });
  return [...lines, ...renderTable(columns, rows, { width })];
}

function bucketSummarySection({ projects }, paint) {
  const lines = ['', paint.bold('Buckets')];
  const descriptions = {
    Ready: 'old and/or finished — good offload candidates',
    Review: 'worth a look',
    Keep: 'recent, unfinished, small, or pinned',
  };
  for (const bucket of ['Ready', 'Review', 'Keep']) {
    const inBucket = projects.filter((p) => p.scoring.bucket === bucket);
    const label = bucketPainter(paint)(bucket.padEnd(6), bucket);
    lines.push(
      `  ${label}  ${plural(inBucket.length, 'project').padStart(12)}  ` +
        `${formatGB(sum(inBucket, (p) => p.sizeBytes)).padStart(9)} GB   ${paint.dim(descriptions[bucket])}`,
    );
  }
  const noted = projects.filter((p) => p.scoring.notes.length > 0);
  if (noted.length > 0) {
    lines.push('', paint.bold('Safety overrides'));
    for (const p of noted) lines.push(`  • ${p.name}: ${p.scoring.notes.join(' ')}`);
  }
  return lines;
}

function sharedSection({ scan, width }, paint) {
  if (scan.shared.length === 0) return [];
  const rows = [...scan.shared]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .map((p) => [p.name, formatGB(p.sizeBytes), formatDate(p.lastEditedMs)]);
  return [
    '',
    paint.bold('Shared folders — measured but never ranked (folders.shared in config)'),
    ...renderTable(
      [
        { header: 'Folder', align: 'left', flex: true, shorten: shortenPath },
        { header: 'Size (GB)', align: 'right' },
        { header: 'Last edited', align: 'left' },
      ],
      rows,
      { width },
    ),
  ];
}

function looseFilesSection({ scan, width }, paint) {
  if (scan.looseFiles.length === 0) return [];
  const rows = [...scan.looseFiles]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .map((f) => [f.relPath, formatGB(f.sizeBytes), formatDate(f.modifiedMs)]);
  return [
    '',
    paint.bold(
      `Loose files — not inside a project folder, not ranked ` +
        `(${plural(scan.looseFiles.length, 'file')}, ${formatGB(sum(scan.looseFiles, (f) => f.sizeBytes))} GB)`,
    ),
    ...renderTable(
      [
        { header: 'File', align: 'left', flex: true, shorten: (text, width) => shortenPath(text, width, '/') },
        { header: 'Size (GB)', align: 'right' },
        { header: 'Modified', align: 'left' },
      ],
      rows,
      { width },
    ),
  ];
}

function skippedSection({ scan }, paint) {
  const parts = scan.skipped.map((s) => `${s.relPath} (${s.reason})`);
  if (scan.hiddenCount > 0) parts.push(`${plural(scan.hiddenCount, 'hidden system item')} (names starting with ".")`);
  if (parts.length === 0) return [];
  return ['', paint.bold('Skipped'), ...parts.map((part) => `  ${part}`)];
}

function warningsSection({ scan }, paint) {
  const lines = scan.warnings.map((w) => `  • ${w}`);
  for (const folder of [...scan.projects, ...scan.shared]) {
    for (const w of folder.warnings) lines.push(`  • ${folder.name}: ${w}`);
    if (folder.warningsDropped > 0) lines.push(`  • ${folder.name}: …and ${plural(folder.warningsDropped, 'more warning')}`);
  }
  if (lines.length === 0) return [];
  return ['', paint.red(paint.bold('Warnings')), ...lines];
}

function scoreExplanation(p, weights) {
  const { parts, bucket, score, daysSinceEdit } = p.scoring;
  const doneWhy = parts.done === 100 ? 'Notion says done' : parts.done === 70 ? 'has an export' : 'no export found';
  const ageWhy = daysSinceEdit === null ? 'no dated files' : `${daysSinceEdit.toFixed(1)} days since last edit`;
  // The parts are shown rounded to 0.1, so adding them up by hand can land
  // 0.1 away from the real score. Say so instead of looking like a mistake.
  const handSum = weights.done * parts.done + weights.age * parts.age + weights.size * parts.size;
  const roundingNote = Math.round(handSum * 10) / 10 === score ? '' : ' (parts are rounded for display)';
  return (
    `${weights.done} × ${parts.done} done (${doneWhy}) + ` +
    `${weights.age} × ${parts.age} age (${ageWhy}) + ` +
    `${weights.size} × ${parts.size} size = ${score.toFixed(1)}${roundingNote} → ${bucket}`
  );
}

// Where a pin comes from: `npm run pin` (saved in the database) and/or
// folders.keepPinned in config.json.
function pinSources(p) {
  const sources = [];
  if (p.pinnedInDatabase) sources.push('npm run pin');
  if (p.pinnedInConfig || !p.pinnedInDatabase) sources.push('folders.keepPinned in config.json');
  return sources.join(' + ');
}

function detailsSection({ projects, scored, weights }, paint) {
  const lines = ['', paint.bold('Details')];
  projects.forEach((p, i) => {
    const byType = CATEGORY_ORDER.map((c) => `${c} ${formatGB(p.bytesByType[c])}`).join(' · ');
    const name = p.parsedName;
    const nameParts = [
      name.subject ? `subject "${name.subject}"` : 'no subject',
      name.dateLabel ? `date ${name.dateLabel}` : 'no date in name',
    ].join('; ');
    lines.push(
      '',
      `  ${paint.bold(`${i + 1}. ${p.name}`)}`,
      `     Size          ${formatGB(p.sizeBytes)} GB = ${formatCount(p.sizeBytes)} bytes ` +
        `(${formatGB(p.diskBytes)} GB on disk) · ${plural(p.fileCount, 'file')} in ${plural(p.folderCount, 'subfolder')}`,
      `     By type (GB)  ${byType}`,
      `     Last edited   ${formatDate(p.lastEditedMs, { withTime: true })}   ${p.lastEditedFile ?? '(no dated files)'}`,
      `     Project file  ${formatDate(p.lastProjectSaveMs, { withTime: true })}   ${p.lastProjectSaveFile ?? '(none found in this folder)'}`,
      `     Export        ${p.hasExport ? `yes — e.g. ${p.exportExampleFile}` : 'no export found in this folder'}`,
      `     From name     ${nameParts}`,
    );
    if (scored) lines.push(`     Score         ${scoreExplanation(p, weights)}`);
    if (p.pinnedKeep) lines.push(`     Pinned        yes — always Keep (${pinSources(p)})`);
    if (p.skippedLinks > 0) lines.push(`     Not followed  ${plural(p.skippedLinks, 'shortcut')} (symlinks)`);
    if (p.incomplete) lines.push("     Incomplete    some folders or files couldn't be read — see Warnings");
  });
  return lines;
}

// What `npm run scan` did with the database, at the end of its report.
//   saved – the result of saving ({ added, updated, returned, markedMissing }),
//           or null when nothing was saved (a --root scan)
function databaseSection({ saved, dbPath }, paint) {
  if (!saved) {
    return [
      '',
      paint.bold('Database'),
      '  Not saved: --root scans cover only part of the SSD, so they are never saved.',
      '  Run `npm run scan` without --root to save results.',
    ];
  }
  const parts = [`${formatCount(saved.added)} new`, `${formatCount(saved.updated)} updated`];
  if (saved.returned > 0) parts.push(`${formatCount(saved.returned)} back on the SSD`);
  parts.push(`${formatCount(saved.markedMissing)} no longer found (marked missing, kept for history)`);
  return [
    '',
    paint.bold(`Saved to ${dbPath}`),
    `  ${parts.join(' · ')}`,
    paint.dim('  `npm run report` shows these results again without rescanning.'),
  ];
}

// Builds the whole `npm run scan` report as one string.
//   scan         – result of scanDrive()
//   projects     – scan.projects in display order (with `scoring` added once scored)
//   scored       – whether projects have scores to show
//   weights      – config.weights, for the score explanation
//   details      – include the per-project details section
//   saved/dbPath – what was saved to the database (see databaseSection);
//                  leave `saved` undefined to leave the section out
//   color/width  – terminal settings
function renderReport({ scan, projects, scored = false, weights, configSource, elapsedMs, details, saved, dbPath, color, width }) {
  const paint = makePainter(color);
  const context = { scan, projects, scored, weights, configSource, elapsedMs, width, saved, dbPath };
  const lines = [
    ...headerSection(context, paint),
    ...projectTableSection(context, paint),
    ...(scored ? bucketSummarySection(context, paint) : []),
    ...sharedSection(context, paint),
    ...looseFilesSection(context, paint),
    ...skippedSection(context, paint),
    ...warningsSection(context, paint),
  ];
  if (details) {
    lines.push(...detailsSection(context, paint));
  }
  if (saved !== undefined) lines.push(...databaseSection(context, paint));
  if (!details) {
    lines.push(
      '',
      paint.dim('Tip: `npm run scan:details` adds each project\'s size by type, its newest file, and the score math.'),
    );
  }
  return `${lines.join('\n')}\n`;
}

// --- The saved report (`npm run report`) ------------------------------------

function formatAgo(ms, now) {
  const days = Math.floor((now - ms) / (24 * 60 * 60 * 1000));
  if (days < 1) return 'today';
  return days === 1 ? '1 day ago' : `${formatCount(days)} days ago`;
}

function savedHeaderSection({ lastScan, lastAttempt, shared, dbPath, now }, paint) {
  const lines = [
    paint.bold('SSD Offload Dashboard — saved results (no rescan)'),
    `  Drive      ${lastScan.root}`,
    `  Last scan  ${formatDate(lastScan.startedMs, { withTime: true })} (${formatAgo(lastScan.startedMs, now)}) · ` +
      `${plural(lastScan.projectCount, 'project')} + ${plural(shared.length, 'shared folder')} · ` +
      `${plural(lastScan.fileCount, 'file')} · ${formatGB(lastScan.totalBytes)} GB · ` +
      `took ${((lastScan.finishedMs - lastScan.startedMs) / 1000).toFixed(1)} s`,
    `  Database   ${dbPath}`,
  ];
  if (lastAttempt && lastAttempt.id !== lastScan.id && lastAttempt.status === 'failed') {
    lines.push(
      paint.red(
        `  ⚠ A later scan, ${formatDate(lastAttempt.startedMs, { withTime: true })}, failed: ` +
          `${String(lastAttempt.errors[0] ?? 'unknown error').split('\n')[0]}`,
      ),
      paint.red('    The results below are from the last scan that finished.'),
    );
  }
  return lines;
}

function yourPinsSection({ projects }, paint) {
  const pinned = projects.filter((p) => p.pinnedInDatabase);
  if (pinned.length === 0) return [];
  return [
    '',
    paint.bold('Your pins (npm run pin) — always Keep'),
    ...pinned.map((p) => `  • ${p.name}`),
  ];
}

function missingSection({ missing, width }, paint) {
  if (missing.length === 0) return [];
  const rows = [...missing]
    .sort((a, b) => b.lastScannedMs - a.lastScannedMs || a.name.localeCompare(b.name))
    .map((p) => [p.name, formatGB(p.sizeBytes), formatDate(p.lastScannedMs), p.scoring ? p.scoring.bucket : '—']);
  return [
    '',
    paint.bold('No longer found on the SSD — kept in the database for history, not ranked'),
    paint.dim('  (offloaded, renamed, deleted, or now skipped by your config)'),
    ...renderTable(
      [
        { header: 'Project', align: 'left', flex: true, shorten: shortenPath },
        { header: 'Size (GB)', align: 'right' },
        { header: 'Last seen', align: 'left' },
        { header: 'Last bucket', align: 'left' },
      ],
      rows,
      { width },
    ),
  ];
}

// Builds the `npm run report` output from what the database holds.
//   lastScan    – the latest finished scan (db.latestScan(db, 'finished'))
//   lastAttempt – the latest scan of any status, to warn if it failed
//   projects    – ranked projects still on the SSD, in display order (with `scoring`)
//   shared      – shared folders still on the SSD
//   missing     – rows no longer found on the SSD
//   now         – the current time, for "3 days ago"
function renderSavedReport({ lastScan, lastAttempt, projects, shared, missing, dbPath, now = Date.now(), color, width }) {
  const paint = makePainter(color);
  const context = { lastScan, lastAttempt, projects, shared, missing, dbPath, now, scored: true, width };
  // The scan's warnings were saved as plain messages, already prefixed with
  // the folder name, so no per-folder warnings are passed here.
  const savedScan = { warnings: lastScan.errors, projects: [], shared: [] };
  const lines = [
    ...savedHeaderSection(context, paint),
    ...projectTableSection(context, paint),
    ...bucketSummarySection(context, paint),
    ...yourPinsSection(context, paint),
    ...sharedSection({ scan: { shared }, width }, paint),
    ...missingSection(context, paint),
    ...warningsSection({ scan: savedScan }, paint),
    '',
    paint.dim('Scores are from the last scan; changes to config.json apply at the next scan.'),
    paint.dim('Refresh: `npm run scan` · Pin or unpin: `npm run pin -- "Project name"`'),
  ];
  return `${lines.join('\n')}\n`;
}

module.exports = { renderReport, renderSavedReport, renderTable, formatGB, formatDate, shortenText, shortenPath };
