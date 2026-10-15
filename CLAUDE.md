# SSD Offload Dashboard

A local Node.js app that scans the owner's working SSD (video/photo production
projects), finds projects that are finished, and tells the owner which to move
off it — following their three-drive workflow:

```
cards → Working SSD (2TB)        → Library HDD (2TB)              → Archive HDD (28TB)
        /Volumes/BRIGSMEDIA        /Volumes/BRIGSMEDIA LIBRARY      /Volumes/Expansion/BRIGSMEDIA ARCHIVE
        offload cards + edit       finished, recent projects        everything older
   Move 1: finished (final export)    Move 2: when the Library reaches 90% full,
   + untouched 14 days                oldest first, down to ~70% (Phase 2 lists them)
```

The three drives are laid out alike (same containers/shared folders), and are
configured as `drives.working` / `drives.library` / `drives.archive`.

The owner is a newer developer: explain what you're doing and any concept they
might not know (route, schema, module, ...). Don't just hand over code.

## SAFETY RULES — non-negotiable

- The app must NEVER delete, move, rename, or write anything on the SSD — or on the
  Library or Archive drives.
- The only place the app writes is the `data/` folder.
- Offload/delete features stay as empty stubs until the owner explicitly asks for them.
  When built, a "move" must be copy → verify (Vericopy checksums) → only then remove the
  source, with explicit confirmation. Nothing is ever deleted from the Archive.

How this is enforced today:
- The scanner only uses read-only calls (`readdir`, `lstat`, `stat`, `realpath`, `statfs`) and never follows symlinks.
- `tests/safety.test.js` fails if file-changing calls (writeFile, rm, rename, mkdir, ...) or
  `child_process` appear anywhere in `src/` (direct calls, references like `map(fsp.unlink)`,
  bracket lookups, destructuring). When Phase 2 adds `src/db.js` writing to `data/`, allow
  exactly that in the test's allowlist — nothing broader. Note that `new Database(path)`
  (better-sqlite3) is not a name the guard knows, so db.js must itself assert its path is
  inside `DATA_DIR`.
- `src/config.js` → `assertSafeLocations()` refuses to run if the app itself lives on any of
  the three drives, or if any two drive paths overlap. `assertAppNotInside()` does the same
  for a `--root` folder.
- `tests/scan.test.js` snapshots a fake drive before and after a scan and asserts nothing changed.

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
  never counts, e.g. "Soccer Finals Temp"), and whether it has a **final export**: a video
  export whose name has a `fileTypes.finalExportWords` word ("Final" or "FD", version
  suffixes like FINALv2 allowed). Plain exports may be drafts in revision and don't mean
  finished. It records which file set each flag. It uses **modification time (mtime), never access time**.
  Hidden/housekeeping files (`.DS_Store`, `._*`, `Thumbs.db`) count toward size but
  never toward "last edited" — Finder rewrites them just from browsing.
- Scoring: `Score = 0.45*Done + 0.35*Age + 0.20*Size`, each part 0–100 (owner's formula).
  - Done: 100 if Notion says Complete/Delivered, 70 if a final export exists, else 0
  - Age: 0 if edited in the last 14 days, rising linearly to 100 at 120+ days
  - Size: project size relative to the largest ranked project
  - Score is rounded to 1 decimal before bucketing so the shown number and bucket agree.
- Buckets follow the workflow rule for Move 1 ("move recent projects that are done"), agreed
  with the owner — the formula alone would make finished projects wait ~100 days:
  - Ready: finished (Done > 0) AND untouched for `ageDays.recent` (14) days AND nothing
    uncertain (no dated files, future-dated files — the scanner ignores dates > 1 day ahead —
    or unreadable folders, `incomplete`). Otherwise a finished project is Review, with a note.
  - Unfinished: never Ready; Review if score ≥ `buckets.review` (40), else Keep.
  - Pinned as Keep (`folders.keepPinned`, a container pin covers all its subfolders) → Keep.
  - Report order: Ready biggest first (frees most space), then Review, Keep by score, size.
- Drive space (`src/scanner/space.js`, statfs) and the move plan (`src/scoring/plan.js`):
  Ready total vs Library free space, and a warning when the Library is/would be at
  `libraryFull.startAtPercent` (90%), with GB to move to the Archive to reach `targetPercent`.
- If the drive disappears mid-scan, the scan throws `ScanError` rather than reporting 0 GB.
- Results go in SQLite (better-sqlite3) so the dashboard loads instantly (Phase 2).
- Later phases: Notion sync for project status, moving projects through the owner's existing
  Vericopy app (localhost:7743, a Node rsync UI with checksum verification), and a location
  log recording each hop (SSD → Library on date X → Archive on date Y) so any project can be found.

## Phases

1. **Done:** scaffold, scanner + classifier, `npm run scan` table, scoring + tests, three-drive
   config, final-export rule, drive space + move plan.
2. SQLite storage (`src/db.js`) + Express server (`src/server.js`) + Alpine.js dashboard (`public/`),
   and the Move 2 view: scan the Library, list oldest projects to move to the Archive until it
   drops to `libraryFull.targetPercent`. Design the DB schema with project locations/hops in mind.
3. Notion sync (`src/notion/sync.js`), nightly scans (`src/jobs/nightly.js`).
4. Offload via Vericopy (`src/offload/vericopy.js`) + archive log — only when explicitly asked.

## Stack and conventions

- Node.js ≥ 20 (22+ recommended), CommonJS modules (`require` / `module.exports`), `'use strict'`.
- No npm dependencies until a phase needs them (Phase 2 adds express, better-sqlite3;
  later node-cron, @notionhq/client). UI: plain HTML + Alpine.js.
- Tests use Node's built-in runner (`node:test` + `node:assert/strict`), files in `tests/*.test.js`.
- Settings: `config.example.json` (defaults, tracked) + `config.json` (owner's copy, gitignored),
  deep-merged by `src/config.js`. Folder names in config are matched case-insensitively;
  container subfolders are written `"Container/Subfolder"`.
- Sizes are shown in decimal GB (1 GB = 1,000,000,000 bytes) to match Finder.

## Commands

- `npm run scan` — scan the SSD and print the ranked table
- `npm run scan:details` — same, plus size by type, newest file, and score math per project
- `npm run scan -- --root "/some/folder"` — scan a different folder (treats its subfolders as projects),
  e.g. the Library: `--root "/Volumes/BRIGSMEDIA LIBRARY"`
- `npm test` — run all tests

## Layout

```
src/config.js            settings loader + safety location checks
src/cli/scan.js          the `npm run scan` command
src/cli/report.js        turns scan results into the printed report
src/scanner/scan.js      walks the SSD (read-only), collects facts per project
src/scanner/classify.js  sorts files into raw/proxy/export/cache/project/other
src/scanner/parseName.js pulls a date + subject out of folder names
src/scanner/space.js     drive size/free space via statfs (read-only)
src/scoring/score.js     the scoring formula + Ready/Review/Keep rule
src/scoring/plan.js      the move plan (fits on Library? Library full?)
src/server.js, src/db.js, src/notion/, src/offload/, src/jobs/   stubs for later phases
public/                  dashboard UI (Phase 2)
tests/                   unit tests
data/                    the only place the app writes (gitignored)
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
