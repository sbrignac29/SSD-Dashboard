# SSD Offload Dashboard

A local Node.js app that scans the owner's working SSD (video/photo production
projects), finds projects that are old or finished, and ranks them so the owner
can offload them to archive storage.

The owner is a newer developer: explain what you're doing and any concept they
might not know (route, schema, module, ...). Don't just hand over code.

## SAFETY RULES — non-negotiable

- The app must NEVER delete, move, rename, or write anything on the SSD.
- The only place the app writes is the `data/` folder.
- Offload/delete features stay as empty stubs until the owner explicitly asks for them.

How this is enforced today:
- The scanner only uses read-only calls (`readdir`, `lstat`, `stat`, `realpath`) and never follows symlinks.
- `tests/safety.test.js` fails if file-changing calls (writeFile, rm, rename, mkdir, ...) or
  `child_process` appear anywhere in `src/` (direct calls, references like `map(fsp.unlink)`,
  bracket lookups, destructuring). It checks every match on a line, so an allowed name can't
  hide another call. The allowlist is exactly `db.js: ['mkdir']` (creating `data/` itself if
  missing). Don't widen it without the owner asking.
- `new Database(path)` (better-sqlite3) writes files but isn't a name the guard knows, so
  `src/db.js` → `openDatabase()` refuses any path outside `DATA_DIR` (checked again after
  `realpath`) and a database file that is a symlink. Tests use their own DB files in
  `data/.test-*`, never `data/dashboard.db`.
- `src/db.js` never deletes rows: projects gone from the SSD get `missing = 1`.
  `npm run report` opens the database read-only.
- `src/config.js` → `assertSafeLocations()` refuses to run if the app itself lives on the SSD,
  if `data/` resolves onto the SSD (e.g. a symlink), or if `archivePath` overlaps `ssdPath`.
  `npm run scan`, `npm run pin` and the nightly job call it before writing.
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
  - Paths are always relative to the SSD top, so `--root` scans of a subfolder still match
    config lists (shared/ignore/pins also apply to anything *inside* a listed folder).
    "Name not found" config warnings only run on whole-SSD scans, and the Size part is relative
    to the largest project in the current scan — the report warns that --root scores can run high.
- The scanner records per project: total size, size by type (raw, proxy, export, cache,
  project, other), newest modified date, last save of a project file (.drp/.prproj/...),
  and whether it has exports (any file classified `export`: inside an export-word folder
  *within* the project, or a video whose name has an export word — the project's own name
  never counts, e.g. "Soccer Finals Temp"). It records which file set has-export. It uses **modification time (mtime), never access time**.
  Hidden/housekeeping files (`.DS_Store`, `._*`, `Thumbs.db`) count toward size but
  never toward "last edited" — Finder rewrites them just from browsing.
- Scoring: `Score = 0.45*Done + 0.35*Age + 0.20*Size`, each part 0–100.
  - Done: 100 if Notion says Complete/Delivered, 70 if a final export exists, else 0
  - Age: 0 if edited in the last 14 days, rising linearly to 100 at 120+ days
  - Size: project size relative to the largest ranked project
  - Buckets: Ready (70+), Review (40–69), Keep (<40); score is rounded to 1 decimal
    before bucketing so the shown number and the bucket always agree
  - Never "Ready" (capped at Review) if edited in the last 14 days, or if the last edit is
    uncertain: no dated files, future-dated files (scanner ignores dates > 1 day ahead), or
    unreadable folders (`incomplete`). Pinned as Keep (`npm run pin`, or `folders.keepPinned`
    where a container pin covers all its subfolders) → always Keep.
  - Report order: Ready, Review, Keep; then score; then size.
  - If the drive disappears mid-scan, the scan throws `ScanError` rather than reporting 0 GB.
- Results are saved in SQLite (`data/dashboard.db`, via better-sqlite3), so reports and the
  dashboard load without rescanning. See "Storage" below.
- Later phases: Notion sync for project status, offloading through the owner's existing
  Vericopy app (localhost:7743, a Node rsync UI with checksum verification), archive log.

## Storage (Phase 2)

- Only full-SSD scans are saved: `saveScan()` refuses a scan whose `scope` isn't `'ssd'`, because
  saving part of the drive would mark everything else missing. `--root` scans are a printed
  preview (they still apply database pins).
- `src/jobs/scanAndSave.js` is the one "scan, then save" path, used by `npm run scan` and the
  nightly job. A failed scan (e.g. `ScanError`, SSD unplugged) is recorded as a `failed` row in
  `scans` and changes no projects.
- One save = one IMMEDIATE transaction: upsert every project/shared folder by `path`, mark
  rows this scan didn't see `missing = 1`, re-score, insert the `scans` row. Upserts keep
  `pinned_keep`, `first_seen`, and an already-filled `client`; a returning project gets
  `missing = 0` with its old `id`.
- Scores are always computed from the saved rows (`rescoreProjects`), with `now` = the last
  finished scan's start, so toggling a pin reproduces the scan's scores and changes only that
  project's bucket. The scan command prints those saved scores (merged onto the in-memory
  facts by `relPath`).
- Pins: effective pin = `pinned_keep` (set by `npm run pin`) OR `folders.keepPinned` in config
  (`isPinnedByConfig` in scan.js, same rules as the scanner). The app never edits
  `config.json`, so `togglePin` won't "unpin" a config pin; it returns `pinned-in-config` and
  the command explains. Pin lookup matches the report name or path via `folderKey`
  (case-insensitive) and suggests substrings on a miss.
- `npm run report` prints stored values; config edits take effect at the next scan or pin.
- Write transactions use `.immediate()` so a busy database waits (5 s) instead of failing at
  once; `describeDatabaseError()` turns `SQLITE_BUSY` (e.g. DB Browser with unsaved edits),
  a missing or broken better-sqlite3, etc. into instructions.
- Conventions: dates are ISO-8601 UTC text, yes/no are 0/1, CHECK constraints guard enums.
  No `STRICT` tables (older DB Browser versions can't open them).
- Schema changes: append a step to `MIGRATIONS` in db.js (tracked by `PRAGMA user_version`);
  never edit a step that has shipped. A read-only open of an outdated file asks the owner to
  run `npm run scan`.

Schema (version 1):
- `projects`: `id`, `path` (UNIQUE, relative to SSD top), `name`, `kind` (project/shared),
  `client` (container name for container shoots), `size_bytes`, `raw|proxy|export|cache|project|other_bytes`,
  `file_count`, `last_modified`(+`_file`), `last_nle_save`(+`_file`), `has_export`, `export_file`,
  `future_dated_files`, `incomplete`, `score`, `bucket`, `score_notes`, `pinned_keep`,
  `first_seen`, `last_scanned`, `missing`.
- `scans`: `id`, `started_at`, `finished_at`, `status` (finished/failed), `root`, `project_count`,
  `file_count`, `total_bytes`, `errors` (JSON list of messages).
- `archive_log` (empty until Phase 4): `id`, `archived_at`, `project_id` → projects, `project_path`,
  `destination`, `size_bytes`, `checksum_result`.

## Phases

1. **Done:** scaffold, scanner + classifier, `npm run scan` table, scoring + tests.
2. **Done:** SQLite storage (`src/db.js`), `npm run scan` saves, `npm run report`, `npm run pin`,
   nightly job (`src/jobs/nightly.js`, 2 AM via node-cron; built but not started yet).
3. Express server (`src/server.js`) + Alpine.js dashboard (`public/`); the server calls
   `scheduleNightlyScan()` at startup (and `task.stop()` on shutdown). Notion sync
   (`src/notion/sync.js`): add `notion_status` as migration 2 and pass it to scoring.
4. Offload via Vericopy (`src/offload/vericopy.js`) + archive log — only when explicitly asked.

## Stack and conventions

- Node.js ≥ 22 (better-sqlite3 13 requires it), CommonJS modules (`require` / `module.exports`),
  `'use strict'`.
- Dependencies only when a phase needs them. Now: better-sqlite3 13 (ships Node-API prebuilt
  binaries, incl. darwin-arm64/x64, so no compiler and no rebuild after a Node upgrade) and
  node-cron 4 (`schedule(expr, fn, { noOverlap })`, `task.execute()`, `task.match(date)`).
  Phase 3 adds express, later @notionhq/client. UI: plain HTML + Alpine.js.
- Tests use Node's built-in runner (`node:test` + `node:assert/strict`), files in `tests/*.test.js`.
- Settings: `config.example.json` (defaults, tracked) + `config.json` (owner's copy, gitignored),
  deep-merged by `src/config.js`. Folder names in config are matched case-insensitively;
  container subfolders are written `"Container/Subfolder"`.
- Sizes are shown in decimal GB (1 GB = 1,000,000,000 bytes) to match Finder.

## Commands

- `npm run scan` — scan the SSD, save to `data/dashboard.db`, and print the ranked table
- `npm run scan:details` — same, plus size by type, newest file, and score math per project
- `npm run scan -- --root "/some/folder"` — preview a different folder (treats its subfolders as
  projects); never saved
- `npm run report` — print the saved results without scanning (read-only)
- `npm run pin -- "<project name>"` — toggle the owner's Keep pin and re-score; `npm run pin` lists pins
- `npm test` — run all tests

## Layout

```
src/config.js            settings loader + safety location checks
src/cli/scan.js          the `npm run scan` command
src/cli/report.js        the `npm run report` command
src/cli/pin.js           the `npm run pin` command
src/cli/format.js        turns results into the printed reports (no disk, no database)
src/db.js                SQLite schema + migrations, saving scans, re-scoring, pins (writes only in data/)
src/jobs/scanAndSave.js  one full scan + save, used by `npm run scan` and the nightly job
src/jobs/nightly.js      node-cron 2 AM scan (started by the server in Phase 3)
src/scanner/scan.js      walks the SSD (read-only), collects facts per project
src/scanner/classify.js  sorts files into raw/proxy/export/cache/project/other
src/scanner/parseName.js pulls a date + subject out of folder names
src/scoring/score.js     the scoring formula
src/server.js, src/notion/, src/offload/   stubs for later phases
public/                  dashboard UI (Phase 3)
tests/                   unit tests
data/                    the only place the app writes: dashboard.db (gitignored)
```

## Known limitations / ideas

- Exports saved in the shared `FINAL EXPORTS` / `FINAL FINAL RENDERS` folders or loose at the
  drive root, and `.prproj` files kept in the shared `Project files` folder, are not linked to
  their project (it shows Export: no, and edits there don't refresh its date). The README asks
  the owner to save these inside each project folder. A later phase could match by name.

- Renaming a project folder looks like a new project: the old path is marked missing and the
  new one starts fresh (its pin, `first_seen` and history don't carry over). Matching renames
  (e.g. same size + files) is an idea for later.

- One SSD per database: rows are keyed by path from the SSD top, so pointing `ssdPath` at a
  different drive marks the first drive's projects missing.

- The saved report has no loose files or skipped items (not stored); `npm run scan` shows them.

- The nightly scan only runs while the Mac is awake and the server is running; node-cron
  doesn't catch up on missed nights.

- DaVinci Resolve projects live in the shared `Resolve Project Library` database, not in
  project folders. Editing in Resolve without rendering new files doesn't change a project
  folder's dates, so such a project can look older than it is. Idea for a later phase:
  read the per-project `Project.db` modified times inside the library and match them to
  folder names.
