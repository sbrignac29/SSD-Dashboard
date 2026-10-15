# SSD Offload Dashboard

A local Node.js app that scans the owner's working SSD (video/photo production
projects), finds projects that are finished, and tells the owner which to move
off it — following their three-drive workflow. Since Phase 3 it's a dashboard in the
browser (`npm start`, http://localhost:7744); the Terminal commands still work.

```
cards → Working SSD (2TB)        → Library HDD (2TB)              → Archive HDD (28TB)
        /Volumes/BRIGSMEDIA        /Volumes/BRIGSMEDIA LIBRARY      /Volumes/Expansion/BRIGSMEDIA ARCHIVE
        offload cards + edit       finished, recent projects        everything older
   Move 1: finished (final export)    Move 2: when the Library reaches 90% full,
   + untouched 14 days                oldest first, down to ~70% (the Done HDD page lists them)
```

The three drives are laid out alike (same containers/shared folders), and are
configured as `drives.working` / `drives.library` / `drives.archive`. The owner calls the
Library the "Done HDD" (the dashboard page's name) and its 90% limit "hddFillLimit": that's
`libraryFull.startAtPercent` (and `targetPercent` is how far down Move 2 goes).

The owner is a newer developer: explain what you're doing and any concept they
might not know (route, schema, module, ...). Don't just hand over code.

## SAFETY RULES — non-negotiable

- The app must NEVER delete, move, rename, or write anything on the SSD — or on the
  Library or Archive drives.
- The only place the app writes is the `data/` folder. It never edits `config.json`: the
  Settings page saves into the database (`settings` table), see "Settings page" below.
- Offload/delete features stay as empty stubs until the owner explicitly asks for them
  (planned for Phase 5; the dashboard shows "Move to HDD" disabled, "Coming in Phase 5").
  When built, a "move" must be copy → verify (Vericopy checksums) → only then remove the
  source, with explicit confirmation. Nothing is ever deleted from the Archive.
- Nothing scans on its own: starting the server never scans; only the Scan now button
  does (the owner asked for "nothing scans until I press it"; there is no scheduled scan).

How this is enforced today:
- The scanner only uses read-only calls (`readdir`, `lstat`, `stat`, `realpath`, `statfs`) and never follows symlinks.
- `tests/safety.test.js` fails if file-changing calls (writeFile, rm, rename, mkdir, ...) or
  `child_process` appear anywhere in `src/` (direct calls, references like `map(fsp.unlink)`,
  bracket lookups, destructuring). It checks every match on a line (the destructuring pattern's
  closing `,`/`:`/`}` is a lookahead), so an allowed name can't hide another call, even in
  `{ mkdirSync, rmSync }`. The allowlist is exactly `db.js: ['mkdir']` (creating `data/` itself if
  missing). Don't widen it without the owner asking.
- `new Database(path)` (better-sqlite3) writes files but isn't a name the guard knows, so
  `src/db.js` → `openDatabase()` refuses any path outside `DATA_DIR` (checked again after
  `realpath`) and a database file that is a symlink (checked with `lstat`, so a dangling link
  to a not-yet-existing file on a drive counts too). Tests use their own DB files in
  `data/.test-*`, never `data/dashboard.db`.
- `src/db.js` never deletes rows: projects gone from the Working SSD get `missing = 1`.
  `npm run report` opens the database read-only. (Replacing the stale folder tree is a column
  update, `subfolders`, not a delete.)
- `src/config.js` → `assertSafeLocations()` refuses to run if the app itself, or its `data/`
  folder (e.g. via a symlink), is on any of the three drives, or if any two drive paths
  overlap. `assertAppNotInside()` does the same for a `--root` folder. `npm run scan`,
  `npm run pin`, the server at startup, the scan runner (every Scan now), the Pin route and
  every Settings save/reset call `assertSafeLocations()` before writing (a save checks the NEW
  settings, so overlapping drive paths or a drive containing the app are refused).
- The server (`src/server.js`) binds `server.host` (127.0.0.1 by default), answers only
  requests whose Host is localhost/127.0.0.1/[::1] (DNS-rebinding guard; off when the owner
  opts into phone access with host 0.0.0.0), and refuses POSTs without
  `Content-Type: application/json` (so another website's form can't press Scan, Pin or save
  settings). With phone access on, settings can only be changed from a loopback address
  (`fromThisMac`); other devices see the page read-only (`canEdit: false`).
  It serves only `public/` plus two fixed files from node_modules (`/vendor/...`, a Map, not a path).
- The guard also trips on file-changing words inside plain strings (e.g. a message saying
  "window stays open (…)" matched `open(`): reword the text, don't widen the allowlist.
- `tests/scan.test.js` and `tests/db.test.js` snapshot a fake drive before and after a scan
  (and a scan + save) and assert nothing changed.

## The plan

- One Node.js app runs locally and serves a dashboard at a localhost address.
- Each top-level folder on the SSD = one project, with these refinements (all in config):
  - `folders.containers`: folders that hold many shoots (e.g. `NCHS Football`) — each
    subfolder is a project, shown as `NCHS Football / <subfolder>`.
  - `folders.shared`: cross-project folders (e.g. `Resolve Project Library`) — measured
    and listed, never ranked.
  - `folders.ignore`: skipped entirely (`$RECYCLE.BIN`, `System Volume Information`).
    Hidden items (names starting with `.`) are always skipped at the top level.
  - Loose files at the top level (or directly inside a container) are listed, not ranked.
  - Paths are always relative to the top of whichever drive is scanned, so `--root` scans of a
    subfolder (or of the Library) still match config lists (shared/ignore/pins also apply to
    anything *inside* a listed folder). `scan.scope` is `working` only for a whole-Working-SSD
    scan; otherwise `partial`. "Name not found" config warnings and the move plan only run for
    `working`; the Size part is relative to the largest project in the current scan, and the
    report warns that partial-scan scores can run high.
- The scanner records per project: total size, size by type (raw, proxy, export, cache,
  project, other), newest modified date, last save of a project file (.drp/.prproj/...),
  whether it has exports (any file classified `export`: inside an export-word folder
  *within* the project, or a video whose name has an export word — the project's own name
  never counts, e.g. "Soccer Finals Temp"), and whether it has a **final export**
  (`src/scanner/classify.js` → `finalExportKind`): an export whose name has a
  `fileTypes.finalExportWords` word ("Final"/"FD"; version suffixes up to 4 digits, e.g.
  FINALv2; "Final Draft" counts as FD) or that sits in a final-exports folder ("Final Exports",
  "Exports/FD"). Runs of 2+ words repeating the project's path don't count (singular/plural
  folded: "Regional Final Highlights v1" in a "...Regional Final" project, "Soccer Final v1" in
  "Soccer Finals Temp" are drafts; "Highlights FINAL" there is final), nor do game rounds
  (Semi/Quarter/Sectional/Regional/State/District/Conference/Championship-Final, Pre/Not-Final),
  `notFinalWords` (draft/drafts/rough/wip, also as a folder), or UUIDs anywhere in a name.
  Video finals count; photo finals only for projects with no raw video and no video exports. Plain exports may be drafts in revision and don't mean
  finished. It records the newest final export file, and `newerFootageFile` when raw footage
  is more than a day newer than it (another shoot still to edit). It uses **modification time (mtime), never access time**.
  Hidden/housekeeping files (`.DS_Store`, `._*`, `Thumbs.db`) count toward size but
  never toward "last edited" — Finder rewrites them just from browsing.
- Scoring: `Score = 0.45*Done + 0.35*Age + 0.20*Size`, each part 0–100 (owner's formula).
  - Done: 100 if Notion says Complete/Delivered, 70 if a final export exists, else 0
  - Age: 0 if edited in the last 14 days, rising linearly to 100 at 120+ days
  - Size: project size relative to the largest ranked project
  - Score is rounded to 1 decimal before bucketing so the shown number and bucket agree.
- Buckets follow the workflow rule for Move 1 ("move recent projects that are done"), agreed
  with the owner — the formula alone would make finished projects wait ~100 days:
  - Ready: finished (Done > 0) AND untouched for `ageDays.recent` (14) days AND no footage
    newer than the final export AND nothing uncertain (no dated files, future-dated files —
    the scanner ignores dates > 1 day ahead — or unreadable folders, `incomplete`). Otherwise a
    finished project is Review, with a note. The report lists the final-export file behind
    every Ready project, with a reminder that Resolve-library / shared 'Project files' edits
    are invisible to the scan.
  - Unfinished: never Ready; Review if score ≥ `buckets.review` (40), else Keep.
  - Pinned as Keep (`npm run pin`, or `folders.keepPinned` where a container pin covers all
    its subfolders) → Keep.
  - Report order: Ready biggest first (frees most space), then Review, Keep by score, size.
- Drive space (`src/scanner/space.js`, statfs) and the move plan (`src/scoring/plan.js`):
  Ready total vs Library free space, and a warning when the Library is/would be at
  `libraryFull.startAtPercent` (90%), with GB to move to the Archive to reach `targetPercent`.
- If the drive disappears mid-scan, the scan throws `ScanError` rather than reporting 0 GB.
- Results are saved in SQLite (`data/dashboard.db`, via better-sqlite3), so reports and the
  dashboard load without rescanning. See "Storage" below.
- Later phases: Notion sync for project status (Phase 4), moving projects through the owner's
  existing Vericopy app (localhost:7743, a Node rsync UI with checksum verification) and a
  location log recording each hop (SSD → Library on date X → Archive on date Y) so any project
  can be found (Phase 5).

## The dashboard (Phase 3)

- `npm start` → `src/server.js`: Express 5, port `server.port` (7744; 7743 is Vericopy and is
  refused by config validation). It opens the database read-write once at startup (creating
  and migrating it — not a scan), checks the browser libraries are installed (else "run npm
  install"). Ctrl+C closes connections and the database.
- Routes (all JSON; `src/web/views.js` builds the answers, read-only, testable without HTTP):
  `GET /api/drives`, `GET /api/summary`, `GET /api/projects` (filters `drive`, `tag`, `client`
  — empty `client=` means none — `from`/`to` YYYY-MM-DD local days; sorted by score, Library
  oldest first; bad values → 400), `GET /api/projects/:id` (checks, score parts, folder tree),
  `POST /api/projects/:id/pin` (`togglePinById`), `GET /api/library` (Done HDD page + Archive
  list), `POST /api/scan` (202 started, or 200 with `started: false` and `reason`
  already-running / nothing-connected — not an error) and `GET /api/scan` (progress, polled
  every 500 ms by the page), `GET /api/settings`, `POST /api/settings` (`{ values: { key: value } }`,
  400 + reason when invalid) and `POST /api/settings/reset`.
- Scan now (`src/web/scanRunner.js`): one run at a time; scans the Working SSD then the
  Library, each through `scanAndSave` (so failures still get a `failed` scans row), skipping a
  drive whose folder isn't there (no failed row: "Not connected" is not an error). The Archive
  is never scanned (only statfs): nothing reads its folders yet and walking 28 TB would make
  every scan slow. Progress % = files so far / that drive's last file count (else top-level
  folders done / total, from `onProgress`'s `foldersDone`/`foldersTotal`), drives weighted by
  their last file counts.
- Tags (plain language, shown before the score) come from the SAVED bucket: Ready → "Ready to
  move to HDD", Review → "Check first", Keep → "Keep on SSD", Keep + pinned (database or
  config) → "Pinned to SSD". Each row has a one-line reason (`shortReason`, date-based, e.g.
  "can be ready Oct 24"). Status shows "—" until Notion (Phase 4).
- The project page recomputes the score parts with `scoreProject` (same `now` = last scan's
  start, same largest project) to show each part; if that differs from the saved score,
  config.json changed since, and the page says "press Scan now" (`stale`).
- Move 2 (`planArchiveMoves` in plan.js): Library past `startAtPercent` → oldest (by last
  edit; undated never suggested) until it's back at `targetPercent`, counting what's on the
  Library now; under the limit but the SSD's Ready projects would push it past → the list makes
  room for them. Unplugged Library → uses its last scan's space (`scans.drive_total_bytes` /
  `drive_free_bytes`).
- Unplugged drives are never errors or empty screens: "Not connected" + last scanned date (+
  how full at that scan), and every page still shows the saved results.
- Browser side (`public/`): plain HTML pages (`index.html`, `project.html?id=`, `library.html`, `settings.html`),
  each one Alpine component (`public/js/*.js`, global functions loaded before Alpine with
  `defer`), shared helpers in `public/js/common.js` (`Dashboard.api`, formatters, theme,
  Chart.js size chart, folder tree built with `textContent`). Alpine 3 and Chart.js 4 are
  served from node_modules (`/vendor/alpine.min.js`, `/vendor/chart.umd.min.js`) so it works
  offline. Theme: CSS tokens on `:root`, dark via `prefers-color-scheme` or
  `data-theme` (button cycles Auto/Light/Dark, saved in localStorage). Phone: ≤720 px, table
  rows become cards (`.stack-table`, `data-label`). Chart: one series (GB by type), single blue
  `--series-1`, value labels at bar tips, "Show the numbers" table.

## Settings page (`src/settings.js`, `public/settings.html`)

- Three layers: `config.example.json` ← `config.json` ← Settings page overrides (one row in the
  `settings` table, JSON keyed by setting name). `loadAppConfig()` combines them and is what
  every command uses (`npm run scan/report/pin`; it opens the DB read-only, and an
  outdated DB — `error.outdated` — counts as no overrides). The server uses
  `createSettingsStore({ db, loadFileConfig })` → `current()`, `view()`, `save(values)`, `reset()`.
- `SECTIONS`/`FIELDS` list what the page can edit (key, type text/number/list, label, help,
  effect now/rescore/scan); the page renders from `GET /api/settings`, so add a field there, not in
  the HTML. Interdependent numbers save as one group (`saveAs`: `weights`, `ageDays`,
  `libraryFull`) so a later config.json edit can't split them.
- A save parses the values, applies them to the current settings, runs `validateConfig` and
  `assertSafeLocations`, stores only values that differ from the file settings (a value set
  back to config.json's is dropped), and re-scores in the same transaction
  (`writeSavedSettings`).
  Saves are refused (409) while a scan runs: the scan would re-score with the settings it
  started with and undo the change.
- `server.port`/`server.host` are not editable (shown under "Only in config.json"): they apply at
  startup, and phone access should be a deliberate file edit.
- Saved values that stop fitting config.json: `current()` throws a ConfigError pointing to the
  Settings page; `view()` still loads with `problem`, and saving a fix keeps the other overrides.

## Storage (Phase 2, extended in Phase 3)

- Only scans of a WHOLE Working SSD or WHOLE Library are saved (`savableDrive()`: `scope ===
  'working'`, or `drive === 'library' && wholeDrive`); anything else would mark everything it
  didn't see missing. `--root` scans from the CLI are a printed preview (they still apply
  database pins) — only the dashboard's Scan now saves Library scans.
- Every row has a `drive` ('working' | 'library'; 'archive' allowed by the CHECK for later).
  Upserts are keyed by (drive, path); missing-marking, `latestScan(db, status, { drive })` and
  `listProjects(db, { drive })` are per drive and default to 'working', so the CLI report,
  pins and scoring only ever see Working SSD rows. Library rows are never scored (score/bucket
  NULL) and can't be pinned (`togglePinById` → 'not-on-working').
- `src/jobs/scanAndSave.js` is the one "scan, then save" path (`drive` 'working' by default, or
  'library'), used by `npm run scan` and Scan now. It also records the drive's
  statfs space on the scans row. A failed scan (e.g. `ScanError`, drive unplugged) is recorded
  as a `failed` row in `scans` and changes no projects. An empty drive path is refused (it
  would resolve to the current folder).
- One save = one IMMEDIATE transaction: upsert every project/shared folder by `path`, mark
  rows this scan didn't see `missing = 1` (except rows at or under `scan.unreadable`: folders
  the scanner couldn't open or lstat; those stay non-missing but get `incomplete = 1`, so their
  old facts can't make them Ready until a scan reads them again), re-score, insert the `scans`
  row. Upserts keep
  `pinned_keep`, `first_seen`, and an already-filled `client`; a returning project gets
  `missing = 0` with its old `id`.
- Scores are always computed from the saved rows (`rescoreProjects`), with `now` = the last
  finished scan's start, so with an unchanged config.json toggling a pin reproduces the scan's
  scores and changes only that project's bucket. (A pin re-scores with the current config, so it
  also applies edited weights/ageDays/buckets/keepPinned to every project; folder and file-type
  settings need a scan.) Every fact scoring reads (`has_final_export`, `newer_footage_file`,
  `future_dated_files`, `incomplete`, ...) must therefore be a column; a new scoring input
  needs a migration (see `readyBlockers` / `donePart` in score.js and `rowToProject` in db.js). The
  scan command prints the saved scores (merged onto the in-memory facts by `relPath`).
- Pins: effective pin = `pinned_keep` (set by `npm run pin`) OR `folders.keepPinned` in config
  (`isPinnedByConfig` in scan.js, same rules as the scanner). The app never edits
  `config.json`, so `togglePin` won't "unpin" a config pin; it re-scores (so a newly added config
  pin shows) and returns `pinned-in-config`, and the command explains. Pin lookup matches the
  report name or path via `folderKey` (case-insensitive), preferring a row still on the SSD over
  a missing one with the same key (case-only renames); a toggle clears `pinned_keep` on those
  same-key rows, so the pin moves to the present row and none is left unreachable. It suggests
  substrings on a miss. A missing project's pin can be toggled, but it isn't re-scored
  (`scoring: null` in the result, also for `pinned-in-config`).
- `npm run report` prints stored scores; config.json edits take effect at the next scan or pin
  (Settings page saves re-score at once).
  Its Drives/move-plan section reads drive space live (statfs) with the saved Ready projects.
- Write transactions use `.immediate()` so a busy database waits (5 s) instead of failing at
  once; `describeDatabaseError()` turns `SQLITE_BUSY` (e.g. DB Browser with unsaved edits),
  a missing or broken better-sqlite3, etc. into instructions.
- Conventions: dates are ISO-8601 UTC text, yes/no are 0/1, CHECK constraints guard enums.
  No `STRICT` tables (older DB Browser versions can't open them).
- Schema changes: append a step to `MIGRATIONS` in db.js (tracked by `PRAGMA user_version`);
  never edit a step that has shipped. A read-only open of an outdated file asks the owner to
  run `npm run scan` (or `npm start`, which opens read-write). Migrations run with foreign keys
  OFF (better-sqlite3 turns them ON for every connection, so `openDatabase` switches them off
  first; table rebuilds need that) and each step runs `foreign_key_check` before committing;
  foreign keys go back ON afterwards. Changing a UNIQUE rule means a rebuild (migration 3:
  create `projects_v3`, copy rows with their ids, drop, rename).
- Locations/hops: `projects` describes the Working SSD (`missing = 1` = no longer there).
  `archive_log` is the hop log: one row per move, with `destination_drive` `library` or
  `archive`, so a project's location is its latest hop (or the Working SSD while not missing).
  Library scans have their own rows (same path, `drive = 'library'`), so the Library's
  contents are known even while it's unplugged.

Schema (version 4 — migration 1 made the tables, 2 added `newer_footage_file`, 3 rebuilt
`projects` with `drive` + UNIQUE (drive, path) + `subfolders`, and added the scans columns,
4 added `settings`):
- `projects`: `id`, `drive` (working/library/archive), `path` (relative to the drive top; UNIQUE
  with drive), `name`, `kind` (project/shared), `client` (container name for container shoots),
  `size_bytes`, `raw|proxy|export|cache|project|other_bytes`, `file_count`,
  `last_modified`(+`_file`), `last_nle_save`(+`_file`), `has_export`, `export_file`,
  `has_final_export`, `final_export_file`, `newer_footage_file`, `future_dated_files`,
  `incomplete`, `subfolders` (JSON: the biggest 300 folders ≤ 3 levels deep, biggest first —
  `{path, sizeBytes, fileCount}`; a folder is never smaller than its children, so the kept set
  has no gaps), `score`, `bucket`, `score_notes`, `pinned_keep`, `first_seen`, `last_scanned`,
  `missing`.
- `scans`: `id`, `started_at`, `finished_at`, `status` (finished/failed), `root`, `project_count`,
  `file_count`, `total_bytes`, `errors` (JSON list of messages), `drive` (working/library),
  `drive_total_bytes`, `drive_free_bytes` (statfs at the scan; NULL for older/failed scans).
- `settings`: exactly one row (`id` = 1, CHECK), `overrides` (JSON, `{}` = nothing changed),
  `updated_at`. Saving is an UPDATE, never a delete.
- `archive_log` (empty until Phase 5): `id`, `archived_at`, `project_id` → projects, `project_path`,
  `destination_drive` (library/archive), `size_bytes`, `checksum_result`.

## Phases

1. **Done:** scaffold, scanner + classifier, `npm run scan` table, scoring + tests, three-drive
   config, final-export rule, drive space + move plan.
2. **Done:** SQLite storage (`src/db.js`), `npm run scan` saves, `npm run report`, `npm run pin`.
   (A nightly scan job was built, then removed again at the owner's request.)
3. **Done:** Express server (`src/server.js`, `npm start`) + Alpine.js dashboard (`public/`):
   Overview (headline, Scan now with progress, drive bar, filterable/sortable table, size
   chart), project page (Ready checklist, score parts, folder tree, Pin, "Move to HDD"
   disabled), Done HDD page (Library oldest first + Archive list past the limit). Library
   scans saved (migration 3). Settings page (migration 4): edit config from the browser,
   saved in the database.
4. Notion sync (`src/notion/sync.js`): add `notion_status` as a migration, pass it to scoring
   (`donePart` already reads `notionStatus`), and fill the table's Status column.
5. Moves via Vericopy (`src/offload/vericopy.js`) + `archive_log` hops — only when explicitly
   asked. The dashboard's disabled "Move to HDD" / "Move to Archive" buttons are the place.

## Stack and conventions

- Node.js `^22.14.0 || >=23.6.0` (package.json engines): better-sqlite3 13 needs Node-API 10, and
  on older Node it segfaults instead of throwing, so `db.js` checks `process.versions.napi`
  first (`nodeApiProblem`). CommonJS
  modules (`require` / `module.exports`), `'use strict'`.
- Dependencies only when a phase needs them. Now: better-sqlite3 13 (ships Node-API prebuilt
  binaries, incl. darwin-arm64/x64, so no compiler and no rebuild after a Node upgrade),
  express 5 (async route errors reach the error handler), alpinejs 3 and chart.js 4 (browser
  libraries, served from node_modules — no CDN). Phase 4 adds @notionhq/client. UI: plain
  HTML + Alpine.js, no build step.
- Tests use Node's built-in runner (`node:test` + `node:assert/strict`), files in `tests/*.test.js`.
  `tests/server.test.js` runs the real Express app on port 0 over HTTP with fake drives in
  `data/.test-server-*` and fake drive sizes (`getSpaces`), and a gated fake `scanAndSave` to
  look at progress mid-scan.
- Settings: `config.example.json` (defaults, tracked) + `config.json` (owner's copy, gitignored),
  deep-merged by `src/config.js`. Folder names in config are matched case-insensitively;
  container subfolders are written `"Container/Subfolder"`.
- Sizes are shown in decimal GB (1 GB = 1,000,000,000 bytes) to match Finder.

## Commands

- `npm start` — the dashboard at http://localhost:7744 (scans nothing until Scan now)
- `npm run scan` — scan the Working SSD, save to `data/dashboard.db`, and print the ranked
  table with drive space and the move plan
- `npm run scan:details` — same, plus size by type, newest file, and score math per project
- `npm run scan -- --root "/some/folder"` — preview a different folder (treats its subfolders as
  projects), e.g. the Library: `--root "/Volumes/BRIGSMEDIA LIBRARY"`; never saved
- `npm run report` — print the saved results without scanning (read-only)
- `npm run pin -- "<project name>"` — toggle the owner's Keep pin and re-score; `npm run pin` lists pins
- `npm test` — run all tests

## Layout

```
src/config.js            settings loader + safety location checks
src/settings.js          Settings page: editable fields, checks, config.json + saved overrides (loadAppConfig)
src/cli/scan.js          the `npm run scan` command
src/cli/report.js        the `npm run report` command
src/cli/pin.js           the `npm run pin` command
src/cli/format.js        turns results into the printed reports (no disk, no database)
src/server.js            the dashboard server (`npm start`): Express app, routes, guards, startup
src/web/views.js         builds each API answer from the database + settings + drive space (read-only)
src/web/scanRunner.js    Scan now: one run at a time, connected drives only, progress for GET /api/scan
src/db.js                SQLite schema + migrations, saving scans, re-scoring, pins, saved settings (writes only in data/)
src/jobs/scanAndSave.js  one full scan + save, used by `npm run scan` and Scan now
src/scanner/scan.js      walks the SSD (read-only), collects facts per project
src/scanner/classify.js  sorts files into raw/proxy/export/cache/project/other
src/scanner/parseName.js pulls a date + subject out of folder names
src/scanner/space.js     drive size/free space via statfs (read-only)
src/scoring/score.js     the scoring formula + Ready/Review/Keep rule
src/scoring/plan.js      the move plan (fits on Library? Library full?) and planArchiveMoves (Move 2)
src/notion/, src/offload/   stubs for Phases 4 and 5
public/                  the dashboard pages: index.html, project.html, library.html, settings.html, styles.css,
                         js/common.js + one js/*.js per page
tests/                   unit tests
data/                    the only place the app writes: dashboard.db (gitignored)
```

## Known limitations / ideas

- Exports saved in the shared `FINAL EXPORTS` / `FINAL FINAL RENDERS` folders or loose at the
  drive root, and `.prproj` files kept in the shared `Project files` folder, are not linked to
  their project (it shows Export: no, and edits there don't refresh its date). The README asks
  the owner to save these inside each project folder. A later phase could match by name.

- DaVinci Resolve projects live in the shared `Resolve Project Library` database, not in
  project folders. Editing in Resolve without rendering new files doesn't change a project
  folder's dates, so such a project can look older than it is. Idea for a later phase:
  read the per-project `Project.db` modified times inside the library and match them to
  folder names.

- Renaming a project folder looks like a new project: the old path is marked missing and the
  new one starts fresh (its pin, `first_seen` and history don't carry over). Matching renames
  (e.g. same size + files) is an idea for later.

- The database tracks one Working SSD: rows are keyed by path from the drive top, so pointing
  `drives.working` at a different drive marks the first drive's projects missing.

- The saved report has no loose files or skipped items (not stored); `npm run scan` shows them.

- The Archive's folders are never scanned, so the dashboard only knows how full it is.

- Deleting `data/dashboard.db` while `npm start` runs makes writes fail with
  SQLITE_READONLY_DBMOVED (explained by `describeDatabaseError`: restart the server).

- A stale empty `/Volumes/BRIGSMEDIA` folder (macOS sometimes leaves one after an unclean
  eject) looks like a connected, empty SSD: a scan would mark every project missing (not
  deleted; the next real scan brings them back with their pins).
