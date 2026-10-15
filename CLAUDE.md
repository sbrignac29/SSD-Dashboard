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
  bracket lookups, destructuring). When Phase 2 adds `src/db.js` writing to `data/`, allow
  exactly that in the test's allowlist — nothing broader. Note that `new Database(path)`
  (better-sqlite3) is not a name the guard knows, so db.js must itself assert its path is
  inside `DATA_DIR`.
- `src/config.js` → `assertSafeLocations()` refuses to run if the app itself lives on the SSD,
  or if `archivePath` overlaps `ssdPath`.
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
  - Paths are always relative to the SSD top, so `--root` scans of a subfolder still match
    config lists. "Name not found" config warnings only run on whole-SSD scans.
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
    unreadable folders (`incomplete`). Pinned as Keep (`folders.keepPinned`, a container pin
    covers all its subfolders) → always Keep.
  - Report order: Ready, Review, Keep; then score; then size.
  - If the drive disappears mid-scan, the scan throws `ScanError` rather than reporting 0 GB.
- Results go in SQLite (better-sqlite3) so the dashboard loads instantly (Phase 2).
- Later phases: Notion sync for project status, offloading through the owner's existing
  Vericopy app (localhost:7743, a Node rsync UI with checksum verification), archive log.

## Phases

1. **Done:** scaffold, scanner + classifier, `npm run scan` table, scoring + tests.
2. SQLite storage (`src/db.js`) + Express server (`src/server.js`) + Alpine.js dashboard (`public/`).
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
- `npm run scan -- --root "/some/folder"` — scan a different folder (treats its subfolders as projects)
- `npm test` — run all tests

## Layout

```
src/config.js            settings loader + safety location checks
src/cli/scan.js          the `npm run scan` command
src/cli/report.js        turns scan results into the printed report
src/scanner/scan.js      walks the SSD (read-only), collects facts per project
src/scanner/classify.js  sorts files into raw/proxy/export/cache/project/other
src/scanner/parseName.js pulls a date + subject out of folder names
src/scoring/score.js     the scoring formula
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
