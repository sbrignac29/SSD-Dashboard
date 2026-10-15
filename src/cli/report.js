'use strict';

// Turns scan results into the text report that `npm run scan` prints.
// Only formatting lives here: no disk access and no scoring math.

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

// Terminal colors, using "ANSI escape codes" — special characters that most
// terminals understand as "switch to green", etc. Turned off when the output
// goes to a file or another program.
function makePainter(enabled) {
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { bold: wrap('1'), dim: wrap('2'), green: wrap('32'), yellow: wrap('33'), red: wrap('31') };
}

// Lines up rows of text into columns.
//   columns: [{ header, align: 'left'|'right', flex?, paint? }]
//   rows:    arrays of strings, one per column
// The one `flex` column (the project name) shrinks to fit the terminal width.
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
    const fitted = shortenText(text, natural[i]);
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
  ];
}

function projectTableSection({ projects, scored, width }, paint) {
  const lines = [
    '',
    paint.bold(scored ? 'Projects — best offload candidates first' : 'Projects — largest first'),
  ];
  if (projects.length === 0) return [...lines, '  (no project folders found)'];

  const columns = [
    { header: '#', align: 'right' },
    { header: 'Project', align: 'left', flex: true },
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
        { header: 'Folder', align: 'left', flex: true },
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
        { header: 'File', align: 'left', flex: true },
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
  const ageWhy = daysSinceEdit === null ? 'no dated files' : `${Math.floor(daysSinceEdit)} days since last edit`;
  return (
    `${weights.done} × ${parts.done} done (${doneWhy}) + ` +
    `${weights.age} × ${parts.age} age (${ageWhy}) + ` +
    `${weights.size} × ${parts.size} size = ${score.toFixed(1)} → ${bucket}`
  );
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
      `     From name     ${nameParts}`,
    );
    if (scored) lines.push(`     Score         ${scoreExplanation(p, weights)}`);
    if (p.pinnedKeep) lines.push('     Pinned        yes — always Keep (folders.keepPinned)');
    if (p.skippedLinks > 0) lines.push(`     Not followed  ${plural(p.skippedLinks, 'shortcut')} (symlinks)`);
  });
  return lines;
}

// Builds the whole report as one string.
//   scan         – result of scanDrive()
//   projects     – scan.projects in display order (with `scoring` added once scored)
//   scored       – whether projects have scores to show
//   weights      – config.weights, for the score explanation
//   details      – include the per-project details section
//   color/width  – terminal settings
function renderReport({ scan, projects, scored = false, weights, configSource, elapsedMs, details, color, width }) {
  const paint = makePainter(color);
  const context = { scan, projects, scored, weights, configSource, elapsedMs, width };
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
  } else {
    lines.push(
      '',
      paint.dim('Tip: `npm run scan:details` adds each project\'s size by type, its newest file, and the score math.'),
    );
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { renderReport, renderTable, formatGB, formatDate, shortenText };
