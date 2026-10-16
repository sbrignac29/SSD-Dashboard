'use strict';

// The database: saves scan results so they can be shown again without
// re-scanning the drives (`npm run report`, and the dashboard: `npm start`).
//
// SQLite is a whole database inside ONE file: data/dashboard.db. You can open
// that file yourself with "DB Browser for SQLite" (see the README).
// better-sqlite3 is the library Node uses to talk to it. We send it SQL, the
// language databases understand: "SELECT ... FROM projects" reads rows,
// "INSERT" adds rows, "UPDATE" changes them.
//
// SAFETY: this is the only file in the app that writes, and it only writes
// inside data/:
//   - openDatabase() refuses any database path outside data/ (checked again
//     after following shortcuts, so a symlink can't point it at the SSD)
//   - it never deletes rows: a project that's gone from the SSD is marked
//     `missing`, so its history stays
// tests/safety.test.js allows exactly one file-changing call here: creating
// the data/ folder itself if it's missing.

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, ROOT_DIR, isInside } = require('./config');
const { scoreProjects } = require('./scoring/score');
const { folderKey, isPinnedByConfig } = require('./scanner/scan');

const DEFAULT_DB_PATH = path.join(DATA_DIR, 'dashboard.db');

// For messages that should be printed plainly, like ConfigError and ScanError.
class DatabaseError extends Error {}

// --- The schema --------------------------------------------------------------
//
// The schema is the database's layout: its tables and their columns. Each
// entry below is one "migration": a step that upgrades the layout. SQLite
// remembers which steps a file already has (a number called user_version), so
// when a later phase adds a column it appends a new step here, and your existing
// database is upgraded in place, keeping its data.
//
// Conventions:
//   - Dates are text in ISO 8601 format, in UTC (the "Z" at the end), e.g.
//     2026-10-15T07:00:00.000Z. Readable, sorts correctly, and SQLite's date
//     functions understand it: datetime(last_modified, 'localtime').
//   - Yes/no values are 1 or 0 (SQLite has no true/false type).
//   - CHECK (...) is a rule SQLite enforces on every write, e.g. a bucket can
//     only be Ready, Review or Keep.
const MIGRATIONS = [
  // 1 — Phase 2: the first tables.
  `
  -- One row per scan run, including failed ones.
  CREATE TABLE scans (
    id            INTEGER PRIMARY KEY,  -- run number, assigned by SQLite
    started_at    TEXT    NOT NULL,     -- when the scan started (file ages are measured from here)
    finished_at   TEXT    NOT NULL,     -- when it finished or failed
    status        TEXT    NOT NULL CHECK (status IN ('finished', 'failed')),
    root          TEXT    NOT NULL,     -- the folder scanned (your Working SSD, drives.working)
    project_count INTEGER,              -- ranked projects found (empty if the scan failed)
    file_count    INTEGER,              -- files measured
    total_bytes   INTEGER,              -- everything measured: projects + shared folders + loose files
    errors        TEXT    NOT NULL DEFAULT '[]'  -- warnings or the failure, as a JSON list of messages
  );

  -- One row per project folder (and per shared folder) on the Working SSD,
  -- updated by each scan.
  CREATE TABLE projects (
    id                 INTEGER PRIMARY KEY,
    path               TEXT    NOT NULL UNIQUE,  -- from the top of the SSD, e.g. 'NCHS Football/Week 1'.
                                                 -- UNIQUE: a rescan updates this row, never adds a second one
    name               TEXT    NOT NULL,         -- display name, e.g. 'NCHS Football / Week 1'
    kind               TEXT    NOT NULL CHECK (kind IN ('project', 'shared')),  -- shared = measured, never ranked
    client             TEXT,                     -- the container for container shoots; later also from Notion
    size_bytes         INTEGER NOT NULL,         -- total size (decimal GB = size_bytes / 1e9)
    raw_bytes          INTEGER NOT NULL,         -- size by type ...
    proxy_bytes        INTEGER NOT NULL,
    export_bytes       INTEGER NOT NULL,
    cache_bytes        INTEGER NOT NULL,
    project_bytes      INTEGER NOT NULL,
    other_bytes        INTEGER NOT NULL,
    file_count         INTEGER NOT NULL,
    last_modified      TEXT,                     -- newest real file (empty if no dated files)
    last_modified_file TEXT,                     -- ... and which file, to check in Finder
    last_nle_save      TEXT,                     -- last save of a .drp/.prproj/... in the folder
    last_nle_save_file TEXT,
    has_export         INTEGER NOT NULL CHECK (has_export IN (0, 1)),          -- any export, drafts included
    export_file        TEXT,                     -- the file that made has_export = 1
    has_final_export   INTEGER NOT NULL CHECK (has_final_export IN (0, 1)),    -- a video named "Final"/"FD": finished
    final_export_file  TEXT,                     -- the file that made has_final_export = 1
    future_dated_files INTEGER NOT NULL DEFAULT 0,                             -- files with impossible future dates
    incomplete         INTEGER NOT NULL DEFAULT 0 CHECK (incomplete IN (0, 1)),  -- some folders couldn't be read
    score              REAL,                     -- 0-100 (empty for shared folders)
    bucket             TEXT    CHECK (bucket IN ('Ready', 'Review', 'Keep')),
    score_notes        TEXT,                     -- why the bucket was overridden, if it was
    pinned_keep        INTEGER NOT NULL DEFAULT 0 CHECK (pinned_keep IN (0, 1)),  -- your pin (npm run pin); scans never change it
    first_seen         TEXT    NOT NULL,         -- first scan that found it
    last_scanned       TEXT    NOT NULL,         -- latest scan that found it
    missing            INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1))       -- 1 = no longer on the Working SSD
  );

  -- One row per move of a project to another drive (Phase 4): Working SSD →
  -- Library, later Library → Archive. Together the rows are each project's
  -- trail of "hops", so any project can be found. Empty until then.
  CREATE TABLE archive_log (
    id                INTEGER PRIMARY KEY,
    archived_at       TEXT    NOT NULL,  -- when the move finished
    project_id        INTEGER NOT NULL REFERENCES projects (id),  -- "foreign key": must be a real projects row
    project_path      TEXT    NOT NULL,  -- copy of the path at the time, so the log reads on its own
    destination_drive TEXT    NOT NULL CHECK (destination_drive IN ('library', 'archive')),  -- drives.* in config
    size_bytes        INTEGER,
    checksum_result   TEXT               -- Vericopy's verification result
  );
  `,

  // 2 — the "newer footage" check: a finished project isn't Ready while it
  // has footage more than a day newer than its final export (maybe another
  // shoot still to edit). Scoring reads it, so it's saved like every other
  // scoring fact; otherwise re-scoring after a pin could wrongly say Ready.
  `
  ALTER TABLE projects ADD COLUMN newer_footage_file TEXT;  -- media newer than the final export (blocks Ready)
  `,

  // 3 — Phase 3, the dashboard:
  //   - the Library HDD is saved too (the Done HDD page). Its projects have the
  //     same paths as their old Working SSD rows, so a row is now identified by
  //     (drive, path) instead of path alone. SQLite can't change a UNIQUE rule
  //     in place, so this step rebuilds the table the way SQLite's manual
  //     describes: new table, copy every row (same ids), drop the old one,
  //     rename the new one. Foreign keys are off while it runs (see migrate()).
  //   - subfolders: each project's biggest folders, for the folder tree
  //   - scans remember which drive they read and how full it was, so the
  //     dashboard can show an unplugged drive's last-known space
  `
  CREATE TABLE projects_v3 (
    id                 INTEGER PRIMARY KEY,
    drive              TEXT    NOT NULL DEFAULT 'working' CHECK (drive IN ('working', 'library', 'archive')),
    path               TEXT    NOT NULL,         -- from the top of the drive, e.g. 'NCHS Football/Week 1'
    name               TEXT    NOT NULL,
    kind               TEXT    NOT NULL CHECK (kind IN ('project', 'shared')),
    client             TEXT,
    size_bytes         INTEGER NOT NULL,
    raw_bytes          INTEGER NOT NULL,
    proxy_bytes        INTEGER NOT NULL,
    export_bytes       INTEGER NOT NULL,
    cache_bytes        INTEGER NOT NULL,
    project_bytes      INTEGER NOT NULL,
    other_bytes        INTEGER NOT NULL,
    file_count         INTEGER NOT NULL,
    last_modified      TEXT,
    last_modified_file TEXT,
    last_nle_save      TEXT,
    last_nle_save_file TEXT,
    has_export         INTEGER NOT NULL CHECK (has_export IN (0, 1)),
    export_file        TEXT,
    has_final_export   INTEGER NOT NULL CHECK (has_final_export IN (0, 1)),
    final_export_file  TEXT,
    newer_footage_file TEXT,
    future_dated_files INTEGER NOT NULL DEFAULT 0,
    incomplete         INTEGER NOT NULL DEFAULT 0 CHECK (incomplete IN (0, 1)),
    subfolders         TEXT    NOT NULL DEFAULT '[]',  -- JSON: [{"path","sizeBytes","fileCount"}], biggest first
    score              REAL,
    bucket             TEXT    CHECK (bucket IN ('Ready', 'Review', 'Keep')),  -- Working SSD rows only
    score_notes        TEXT,
    pinned_keep        INTEGER NOT NULL DEFAULT 0 CHECK (pinned_keep IN (0, 1)),
    first_seen         TEXT    NOT NULL,         -- first scan of this drive that found it
    last_scanned       TEXT    NOT NULL,
    missing            INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),  -- 1 = no longer on this drive
    UNIQUE (drive, path)                         -- one row per folder per drive
  );
  INSERT INTO projects_v3 (
    id, drive, path, name, kind, client,
    size_bytes, raw_bytes, proxy_bytes, export_bytes, cache_bytes, project_bytes, other_bytes,
    file_count, last_modified, last_modified_file, last_nle_save, last_nle_save_file,
    has_export, export_file, has_final_export, final_export_file, newer_footage_file, future_dated_files, incomplete,
    score, bucket, score_notes, pinned_keep, first_seen, last_scanned, missing
  )
  SELECT
    id, 'working', path, name, kind, client,
    size_bytes, raw_bytes, proxy_bytes, export_bytes, cache_bytes, project_bytes, other_bytes,
    file_count, last_modified, last_modified_file, last_nle_save, last_nle_save_file,
    has_export, export_file, has_final_export, final_export_file, newer_footage_file, future_dated_files, incomplete,
    score, bucket, score_notes, pinned_keep, first_seen, last_scanned, missing
  FROM projects;
  DROP TABLE projects;
  ALTER TABLE projects_v3 RENAME TO projects;

  ALTER TABLE scans ADD COLUMN drive TEXT NOT NULL DEFAULT 'working' CHECK (drive IN ('working', 'library', 'archive'));
  ALTER TABLE scans ADD COLUMN drive_total_bytes INTEGER;  -- the drive's size at the scan (empty if unknown)
  ALTER TABLE scans ADD COLUMN drive_free_bytes INTEGER;   -- ... and its free space
  `,

  // 4 — the dashboard's Settings page. Exactly one row (id 1), so saving is
  // always an UPDATE, never a delete. `overrides` holds only what you changed
  // on the page, as JSON keyed by setting name, e.g.
  //   {"drives.working": "/Volumes/NEWSSD", "weights": {"done": 0.5, "age": 0.3, "size": 0.2}}
  // Those win over config.json; everything else still comes from the files.
  `
  CREATE TABLE settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    overrides  TEXT NOT NULL DEFAULT '{}',  -- JSON: setting name -> value
    updated_at TEXT                          -- when the Settings page last saved (empty: never)
  );
  INSERT INTO settings (id) VALUES (1);
  `,

  // 5 — Phase 4, Notion:
  //   - notion_pages: a copy of the pages in your Notion Projects database,
  //     refreshed by each sync, so the dashboard still knows them (and their
  //     statuses) when Notion can't be reached. Rows are never deleted: a page
  //     that's gone from Notion gets in_last_sync = 0.
  //   - notion_syncs: one row per sync, like scans (failed ones too).
  //   - projects gets the link you confirmed on the Link to Notion page, plus a
  //     copy of that page's title/status/end date from the last sync. Scoring
  //     reads notion_status from here (every scoring fact is a column, see
  //     rescoreProjects). A rescan's upsert doesn't touch these columns, so
  //     links survive rescans, like pins.
  //     link_source: NULL = not decided yet, 'confirmed' = linked to
  //     notion_page_id, 'none' = you said this folder has no Notion page.
  `
  CREATE TABLE notion_pages (
    page_id      TEXT    PRIMARY KEY,         -- Notion's id for the page, e.g. '1a2b3c4d-...'
    title        TEXT    NOT NULL,            -- its "Project name"
    status       TEXT,                        -- its "Status" (empty if not set)
    end_date     TEXT,                        -- its "End date" as Notion gives it: '2026-10-03' (or with a time)
    url          TEXT,                        -- the page's address, to open it in Notion
    last_edited  TEXT,                        -- when the page was last edited in Notion
    first_seen   TEXT    NOT NULL,            -- first sync that found it
    last_synced  TEXT    NOT NULL,            -- latest sync that found it
    in_last_sync INTEGER NOT NULL DEFAULT 1 CHECK (in_last_sync IN (0, 1))  -- 0 = deleted, or no longer shared
  );

  CREATE TABLE notion_syncs (
    id             INTEGER PRIMARY KEY,
    started_at     TEXT    NOT NULL,
    finished_at    TEXT    NOT NULL,
    status         TEXT    NOT NULL CHECK (status IN ('finished', 'failed')),
    triggered_by   TEXT    NOT NULL CHECK (triggered_by IN ('button', 'scan')),  -- Refresh Notion, or Scan now
    data_source_id TEXT,                      -- which Notion data source was read
    page_count     INTEGER,                   -- pages read (empty if it failed)
    error          TEXT                       -- why it failed, in plain words
  );

  ALTER TABLE projects ADD COLUMN notion_page_id   TEXT REFERENCES notion_pages (page_id);  -- the confirmed page
  ALTER TABLE projects ADD COLUMN notion_title     TEXT;  -- that page's title ...
  ALTER TABLE projects ADD COLUMN notion_status    TEXT;  -- ... status (scoring reads this) ...
  ALTER TABLE projects ADD COLUMN notion_end_date  TEXT;  -- ... and end date, as of:
  ALTER TABLE projects ADD COLUMN notion_synced_at TEXT;
  ALTER TABLE projects ADD COLUMN link_decided_at  TEXT;  -- when you pressed Confirm or No Notion page
  ALTER TABLE projects ADD COLUMN link_source      TEXT CHECK (
    (link_source IS NULL AND notion_page_id IS NULL) OR
    (link_source = 'confirmed' AND notion_page_id IS NOT NULL) OR
    (link_source = 'none' AND notion_page_id IS NULL)
  );
  `,

  // 6 — Phase 5, moves through VeriCopy: archive_log becomes the full record
  // of every move, one row per move, written the moment you press Start and
  // updated as VeriCopy reports progress. VeriCopy forgets its jobs when it
  // quits, so this table is the durable history.
  // The old table (from step 1) had no room for that and was never written
  // to, but any rows in it are copied over (state 'lost', no details), the
  // same rebuild as step 3: new table, copy, drop, rename.
  //   state – the dashboard's verdict:
  //     starting      the row is saved, VeriCopy is being asked (POST /api/jobs)
  //     refused       VeriCopy said no (e.g. destination_exists); nothing copied
  //     queued | copying | verifying   VeriCopy's own status, while it works
  //     checking      VeriCopy said verified; the dashboard's spot check is running
  //     copied        verified AND the spot check passed: the ONLY success
  //     check_failed  verified, but the copy didn't match the original's count/bytes
  //     failed | cancelled   VeriCopy's status (partial folder left behind)
  //     unverified    VeriCopy said copied_unverified (never for API jobs)
  //     lost          VeriCopy no longer knows the job (quit / restarted)
  // The CHECK rule at the end makes "copied" impossible to save unless
  // VeriCopy said verified and the spot check passed.
  `
  CREATE TABLE archive_log_v6 (
    id                 INTEGER PRIMARY KEY,
    project_id         INTEGER NOT NULL REFERENCES projects (id),  -- the row moved (Working SSD row for Move 1, Library row for Move 2)
    project_path       TEXT    NOT NULL,  -- path from the drive top, at the time, e.g. 'NCHS Football/Week 1'
    project_name       TEXT    NOT NULL,
    from_drive         TEXT    NOT NULL CHECK (from_drive IN ('working', 'library')),
    to_drive           TEXT    NOT NULL CHECK (to_drive IN ('library', 'archive')),
    source_path        TEXT    NOT NULL,  -- full path of the original folder
    destination_parent TEXT    NOT NULL,  -- the folder sent to VeriCopy as "destination"
    destination_path   TEXT    NOT NULL,  -- where the copy lands: destination_parent/<folder name>
    vericopy_url       TEXT    NOT NULL,  -- which VeriCopy was asked
    job_id             TEXT    UNIQUE,    -- VeriCopy's job id (empty until it accepted the copy)
    size_bytes         INTEGER,           -- the original, measured just before starting
    file_count         INTEGER,
    state              TEXT    NOT NULL CHECK (state IN ('starting', 'refused', 'queued', 'copying', 'verifying', 'checking',
                                                         'copied', 'check_failed', 'failed', 'cancelled', 'unverified', 'lost')),
    vericopy_status    TEXT,              -- the last status VeriCopy reported
    status_history     TEXT    NOT NULL DEFAULT '[]',  -- JSON: [{ at, state, vericopyStatus, note }]
    progress           REAL,              -- VeriCopy's 0–1 figure (copy + verify)
    bytes_copied       INTEGER,
    bytes_total        INTEGER,
    files_total        INTEGER,
    files_copied       INTEGER,
    files_verified     INTEGER,
    files_failed       INTEGER,
    seconds_remaining  INTEGER,
    failed_files       TEXT    NOT NULL DEFAULT '[]',  -- JSON: [{ path, message }] from VeriCopy
    fatal_error        TEXT,              -- VeriCopy's reason a job couldn't start
    spot_check         TEXT,              -- JSON: the dashboard's own count of both folders
    spot_check_ok      INTEGER CHECK (spot_check_ok IN (0, 1)),
    error              TEXT,              -- what went wrong, in plain words
    created_at         TEXT    NOT NULL,  -- when you pressed Start
    submitted_at       TEXT,              -- when VeriCopy accepted it
    updated_at         TEXT    NOT NULL,
    finished_at        TEXT,              -- when it reached a final state
    CHECK ((from_drive = 'working' AND to_drive = 'library') OR (from_drive = 'library' AND to_drive = 'archive')),
    -- (IS, not =: with =, an empty value would make the rule "unknown", which SQLite lets through.)
    CHECK (state <> 'copied' OR (vericopy_status IS 'verified' AND spot_check_ok IS 1))
  );
  INSERT INTO archive_log_v6 (id, project_id, project_path, project_name, from_drive, to_drive, source_path,
                              destination_parent, destination_path, vericopy_url, size_bytes, state, error,
                              created_at, updated_at, finished_at)
    SELECT id, project_id, project_path, project_path,
           CASE destination_drive WHEN 'library' THEN 'working' ELSE 'library' END, destination_drive,
           project_path, '', '', '', size_bytes, 'lost', 'Recorded before moves were built: no details.',
           archived_at, archived_at, archived_at
    FROM archive_log;
  DROP TABLE archive_log;
  ALTER TABLE archive_log_v6 RENAME TO archive_log;
  CREATE INDEX archive_log_by_project ON archive_log (project_id);
  `,
];

// The drives whose folders can be saved: the Working SSD (scored for Move 1)
// and the Library HDD (listed oldest first for Move 2). The Archive is only
// measured (how full it is); nothing reads its folders yet.
const SAVED_DRIVES = ['working', 'library'];

// --- Opening -----------------------------------------------------------------

// better-sqlite3 includes compiled code, so it can fail to load in ways a
// plain JavaScript library can't. Turn those into instructions.
//
// Its compiled part needs Node-API version 10 (Node 22.14 or newer). On an
// older Node it doesn't fail politely: the whole program just crashes with
// "Segmentation fault". So check the version before loading it.
const REQUIRED_NODE_API = 10;
const REINSTALL_ADVICE = 'Delete the node_modules folder in the app folder, then run `npm install`.';

// A message if this Node.js is too old for the database library, else null.
function nodeApiProblem(napiVersion = process.versions.napi) {
  if (Number(napiVersion) >= REQUIRED_NODE_API) return null;
  return (
    `Your Node.js (${process.version}) is too old for the database library: it needs Node 22.14 or newer ` +
    '(on Node 23, 23.6 or newer).\n' +
    'Install the current LTS version from https://nodejs.org, then run `npm install` in the app folder.'
  );
}

function loadDriver() {
  const problem = nodeApiProblem();
  if (problem) throw new DatabaseError(problem);
  try {
    return require('better-sqlite3');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new DatabaseError("The database library isn't installed. Run `npm install` in the app folder, then try again.");
    }
    throw new DatabaseError(`The database library couldn't load (${error.message}).\n${REINSTALL_ADVICE}`);
  }
}

// SAFETY: refuses any database file that isn't inside data/.
function assertInsideDataDir(file) {
  if (file === DATA_DIR || !isInside(file, DATA_DIR)) {
    throw new DatabaseError(`Refusing to open a database outside the app's data/ folder: ${file}`);
  }
  // Also compare the real locations, after following shortcuts (symlinks), so a
  // shortcut inside data/ can't lead somewhere else.
  let realFolder;
  try {
    realFolder = fs.realpathSync(path.dirname(file));
  } catch {
    throw new DatabaseError(`The folder for the database doesn't exist: ${path.dirname(file)}`);
  }
  if (!isInside(realFolder, fs.realpathSync(DATA_DIR))) {
    throw new DatabaseError(`Refusing to open a database outside the app's data/ folder: ${file}`);
  }
  // lstat looks at the shortcut itself. (existsSync would follow it, and say
  // "not there" for a shortcut to a file that doesn't exist yet — then SQLite
  // would create that file wherever the shortcut points.)
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new DatabaseError(`Refusing to open a database file that is a shortcut (symlink): ${file}`);
  }
}

// Brings an older database file up to the current layout.
// Runs with foreign keys off (SQLite's rule for rebuilding a table): step 3
// drops and recreates `projects`, which archive_log points at. Each step then
// checks that every archive_log row still points at a real project before it
// commits.
function migrate(db, { readonly }) {
  const version = db.pragma('user_version', { simple: true });
  if (version > MIGRATIONS.length) {
    throw new DatabaseError('This database was made by a newer version of the app. Update the app (git pull) and try again.');
  }
  if (version === MIGRATIONS.length) return;
  if (readonly) {
    const error = new DatabaseError('The database needs a quick upgrade for this version of the app. Run `npm run scan` once.');
    // Lets loadAppConfig() tell "older file, so no saved settings yet" apart from real problems.
    error.outdated = true;
    throw error;
  }
  for (let step = version; step < MIGRATIONS.length; step += 1) {
    // A transaction: the step either fully happens or not at all.
    db.transaction(() => {
      db.exec(MIGRATIONS[step]);
      if (db.pragma('foreign_key_check').length > 0) {
        throw new DatabaseError(`Upgrading the database (step ${step + 1}) would break the move log. Nothing was changed.`);
      }
      db.pragma(`user_version = ${step + 1}`);
    })();
  }
}

// Opens (and if needed, creates) the database.
//   file      – defaults to data/dashboard.db. Must be inside data/.
//   readonly  – for commands that only read (`npm run report`): they can't
//               change anything, even by accident.
//   mustExist – fail with a friendly message if there's no database yet,
//               instead of creating an empty one (always on when readonly).
// Remember to call db.close() when done.
function openDatabase({ file = DEFAULT_DB_PATH, readonly = false, mustExist = readonly } = {}) {
  const target = path.resolve(file);
  if (mustExist && !fs.existsSync(target)) {
    throw new DatabaseError('No saved results yet. Run `npm run scan` first.');
  }
  if (!readonly && target !== DATA_DIR && isInside(target, DATA_DIR)) {
    // SAFETY: the one file-changing call the safety test allows: create data/
    // itself if it was deleted (only data/, never any other folder).
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  assertInsideDataDir(target);

  const Database = loadDriver();
  let db;
  try {
    db = new Database(target, { readonly, fileMustExist: readonly });
  } catch (error) {
    // better-sqlite3 loads its compiled part here, the first time it's used.
    if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_DLOPEN_FAILED') {
      throw new DatabaseError(`The database library couldn't load (${error.message}).\n${REINSTALL_ADVICE}`);
    }
    throw error;
  }
  try {
    // better-sqlite3 turns foreign keys ON for every new connection; upgrading
    // needs them off (see migrate()). This only works outside a transaction.
    db.pragma('foreign_keys = OFF');
    migrate(db, { readonly });
  } catch (error) {
    db.close();
    throw error;
  }
  // SQLite only enforces REFERENCES (foreign keys) when asked, per connection.
  // (Turned on after migrating: see migrate().)
  db.pragma('foreign_keys = ON');
  return db;
}

// "data/dashboard.db" — for messages.
function displayPath(file = DEFAULT_DB_PATH) {
  return path.relative(ROOT_DIR, file) || file;
}

// Plain-English versions of database problems you can fix yourself, or null
// for anything else (a bug, which should show its full details).
function describeDatabaseError(error) {
  if (error instanceof DatabaseError) return error.message;
  if (error?.code === 'SQLITE_BUSY') {
    // Another program is in the middle of changing the file and didn't let go
    // within 5 seconds (better-sqlite3's default wait).
    return (
      `The database (${displayPath()}) is busy: another program is changing it.\n` +
        'Is it open in DB Browser for SQLite with unsaved edits? Click "Write Changes" or "Revert Changes" ' +
        '(or close it), then try again. Tip: open it with "Open Database Read Only" to just look.'
    );
  }
  if (error?.code === 'SQLITE_READONLY_DBMOVED') {
    // The file was deleted or renamed while the dashboard had it open.
    return (
      `The database file (${displayPath()}) was moved or deleted while the dashboard was running.\n` +
      'Stop the dashboard (Ctrl+C in its Terminal window) and run `npm start` again.'
    );
  }
  return null;
}

// --- Converting between JavaScript and database rows -------------------------

function toIso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function fromIso(text) {
  return text === null || text === undefined ? null : Date.parse(text);
}

function parseSubfolders(text) {
  try {
    const list = JSON.parse(text ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// A database row -> the same shape the scanner and scoring use (sizeBytes,
// lastEditedMs, ...), so the report and scoring code work on both.
function rowToProject(row) {
  return {
    id: row.id,
    drive: row.drive,
    relPath: row.path,
    name: row.name,
    kind: row.kind,
    client: row.client,
    sizeBytes: row.size_bytes,
    bytesByType: {
      raw: row.raw_bytes,
      proxy: row.proxy_bytes,
      export: row.export_bytes,
      cache: row.cache_bytes,
      project: row.project_bytes,
      other: row.other_bytes,
    },
    fileCount: row.file_count,
    lastEditedMs: fromIso(row.last_modified),
    lastEditedFile: row.last_modified_file,
    lastProjectSaveMs: fromIso(row.last_nle_save),
    lastProjectSaveFile: row.last_nle_save_file,
    hasExport: row.has_export === 1,
    exportExampleFile: row.export_file,
    hasFinalExport: row.has_final_export === 1,
    finalExportFile: row.final_export_file,
    newerFootageFile: row.newer_footage_file,
    futureDatedFiles: row.future_dated_files,
    incomplete: row.incomplete === 1,
    subfolders: parseSubfolders(row.subfolders),
    pinnedInDatabase: row.pinned_keep === 1,
    // The score saved by the last scan or pin (shared folders have none).
    scoring: row.bucket ? { score: row.score, bucket: row.bucket, notes: row.score_notes ? [row.score_notes] : [] } : null,
    firstSeenMs: fromIso(row.first_seen),
    lastScannedMs: fromIso(row.last_scanned),
    missing: row.missing === 1,
    // Notion (Phase 4): the link you confirmed, and the page's facts as of the
    // last sync. Scoring reads notionStatus (donePart in score.js).
    notionLink: row.link_source ?? null, // 'confirmed' | 'none' | null (not decided yet)
    notionPageId: row.notion_page_id ?? null,
    notionTitle: row.notion_title ?? null,
    notionStatus: row.link_source === 'confirmed' ? (row.notion_status ?? null) : null,
    notionEndDate: row.notion_end_date ?? null,
    notionSyncedMs: fromIso(row.notion_synced_at ?? null),
    linkDecidedMs: fromIso(row.link_decided_at ?? null),
  };
}

// Everything a scan learned about one folder, as named values for the SQL
// below (@path, @name, ...).
function factsToRow(facts, scannedAtIso, drive) {
  // "NCHS Football/Week 1" -> client "NCHS Football". A top-level project has
  // no container, so its client stays empty (Notion can fill it in later).
  const slash = facts.relPath.lastIndexOf('/');
  return {
    drive,
    path: facts.relPath,
    name: facts.name,
    kind: facts.kind,
    client: slash === -1 ? null : facts.relPath.slice(0, slash),
    size_bytes: facts.sizeBytes,
    raw_bytes: facts.bytesByType.raw,
    proxy_bytes: facts.bytesByType.proxy,
    export_bytes: facts.bytesByType.export,
    cache_bytes: facts.bytesByType.cache,
    project_bytes: facts.bytesByType.project,
    other_bytes: facts.bytesByType.other,
    file_count: facts.fileCount,
    last_modified: toIso(facts.lastEditedMs),
    last_modified_file: facts.lastEditedFile,
    last_nle_save: toIso(facts.lastProjectSaveMs),
    last_nle_save_file: facts.lastProjectSaveFile,
    has_export: facts.hasExport ? 1 : 0,
    export_file: facts.exportExampleFile,
    has_final_export: facts.hasFinalExport ? 1 : 0,
    final_export_file: facts.finalExportFile,
    newer_footage_file: facts.newerFootageFile ?? null,
    future_dated_files: facts.futureDatedFiles,
    incomplete: facts.incomplete ? 1 : 0,
    subfolders: JSON.stringify(facts.subfolders ?? []),
    scanned_at: scannedAtIso,
  };
}

// --- Saving a scan -----------------------------------------------------------

// "Upsert" = insert, or update if it's already there. ON CONFLICT (drive, path)
// is the "already there" case: each folder has one row per drive (UNIQUE), so
// instead of adding a second row, SQLite updates the existing one.
//
// Columns the update leaves alone, on purpose:
//   pinned_keep – your pin survives every rescan
//   first_seen  – stays the date it was first found
//   client      – COALESCE keeps a client that's already filled in
//   notion_* and link_source – your Notion link survives every rescan
// Scores are cleared here and recalculated right after (same transaction).
const UPSERT_PROJECT_SQL = `
  INSERT INTO projects (
    drive, path, name, kind, client,
    size_bytes, raw_bytes, proxy_bytes, export_bytes, cache_bytes, project_bytes, other_bytes,
    file_count, last_modified, last_modified_file, last_nle_save, last_nle_save_file,
    has_export, export_file, has_final_export, final_export_file, newer_footage_file, future_dated_files, incomplete,
    subfolders, first_seen, last_scanned, missing
  ) VALUES (
    @drive, @path, @name, @kind, @client,
    @size_bytes, @raw_bytes, @proxy_bytes, @export_bytes, @cache_bytes, @project_bytes, @other_bytes,
    @file_count, @last_modified, @last_modified_file, @last_nle_save, @last_nle_save_file,
    @has_export, @export_file, @has_final_export, @final_export_file, @newer_footage_file, @future_dated_files, @incomplete,
    @subfolders, @scanned_at, @scanned_at, 0
  )
  ON CONFLICT (drive, path) DO UPDATE SET
    name = excluded.name,
    kind = excluded.kind,
    client = COALESCE(excluded.client, projects.client),
    size_bytes = excluded.size_bytes,
    raw_bytes = excluded.raw_bytes,
    proxy_bytes = excluded.proxy_bytes,
    export_bytes = excluded.export_bytes,
    cache_bytes = excluded.cache_bytes,
    project_bytes = excluded.project_bytes,
    other_bytes = excluded.other_bytes,
    file_count = excluded.file_count,
    last_modified = excluded.last_modified,
    last_modified_file = excluded.last_modified_file,
    last_nle_save = excluded.last_nle_save,
    last_nle_save_file = excluded.last_nle_save_file,
    has_export = excluded.has_export,
    export_file = excluded.export_file,
    has_final_export = excluded.has_final_export,
    final_export_file = excluded.final_export_file,
    newer_footage_file = excluded.newer_footage_file,
    future_dated_files = excluded.future_dated_files,
    incomplete = excluded.incomplete,
    subfolders = excluded.subfolders,
    score = NULL,
    bucket = NULL,
    score_notes = NULL,
    last_scanned = excluded.last_scanned,
    missing = 0
`;

function sum(items, pick) {
  return items.reduce((total, item) => total + pick(item), 0);
}

// Every warning from a scan, as one list of messages (like the report shows).
function scanMessages(scan) {
  const messages = [...scan.warnings];
  for (const folder of [...scan.projects, ...scan.shared]) {
    for (const warning of folder.warnings) messages.push(`${folder.name}: ${warning}`);
    if (folder.warningsDropped > 0) messages.push(`${folder.name}: …and ${folder.warningsDropped} more warning(s)`);
  }
  return messages;
}

// Which drive a scan can be saved as: 'working' or 'library' for a scan of
// that WHOLE drive, otherwise null. A scan of one folder (`--root`), of the
// Archive, or of a folder on no drive only saw part of the picture: saving it
// would mark everything it didn't see as missing.
function savableDrive(scan) {
  if (scan.scope === 'working') return 'working';
  if (scan.drive === 'library' && scan.wholeDrive) return 'library';
  return null;
}

// Saves one full scan of the Working SSD or the Library HDD (the result of
// scanDrive). Working SSD scans are re-scored; Library projects aren't scored
// (Move 2 just goes oldest first). All of it happens in one transaction: if
// anything fails partway, SQLite undoes the whole save, so the database never
// holds half a scan.
//   space – the drive's { totalBytes, freeBytes } at the scan (from space.js), or null
//
// Returns { scanId, drive, projects, added, updated, returned, markedMissing }:
// `projects` are the scored Working SSD projects (with pins), or the Library's projects.
function saveScan(db, scan, config, { finishedAt = Date.now(), space = null } = {}) {
  const drive = savableDrive(scan);
  if (!drive) {
    throw new Error(
      'Only full scans of the Working SSD or the Library HDD can be saved (this scan covered one folder or another drive).',
    );
  }
  const scannedAtIso = toIso(scan.scannedAt);
  const findExisting = db.prepare('SELECT missing FROM projects WHERE drive = ? AND path = ?');
  const upsert = db.prepare(UPSERT_PROJECT_SQL);
  const counts = { added: 0, updated: 0, returned: 0, markedMissing: 0 };

  const save = db.transaction(() => {
    for (const facts of [...scan.projects, ...scan.shared]) {
      const existing = findExisting.get(drive, facts.relPath);
      if (!existing) counts.added += 1;
      else if (existing.missing === 1) counts.returned += 1;
      else counts.updated += 1;
      upsert.run(factsToRow(facts, scannedAtIso, drive));
    }

    // Anything this scan didn't see is marked missing. Never deleted.
    // Except: rows inside a folder the scan couldn't open (e.g. a container
    // macOS wouldn't let it read) are probably still there, so they aren't
    // reported as gone. Their facts are from an older scan, though, so they're
    // flagged incomplete: that keeps them out of Ready until a scan can read
    // them again (the next successful scan resets the flag).
    const unreadable = (scan.unreadable || []).map(folderKey);
    const insideUnreadable = (rowPath) => {
      const key = folderKey(rowPath);
      return unreadable.some((folder) => key === folder || key.startsWith(`${folder}/`));
    };
    const markMissing = db.prepare('UPDATE projects SET missing = 1 WHERE id = ?');
    const markIncomplete = db.prepare('UPDATE projects SET incomplete = 1 WHERE id = ?');
    const notSeen = db.prepare('SELECT id, path FROM projects WHERE drive = ? AND missing = 0 AND last_scanned <> ?');
    for (const row of notSeen.all(drive, scannedAtIso)) {
      if (insideUnreadable(row.path)) {
        markIncomplete.run(row.id);
        continue;
      }
      markMissing.run(row.id);
      counts.markedMissing += 1;
    }

    const projects =
      drive === 'working'
        ? rescoreProjects(db, config, scan.scannedAt)
        : listProjects(db, { drive }).filter((p) => p.kind === 'project' && !p.missing);

    const allBytes =
      sum(scan.projects, (p) => p.sizeBytes) + sum(scan.shared, (p) => p.sizeBytes) + sum(scan.looseFiles, (f) => f.sizeBytes);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO scans (started_at, finished_at, status, drive, root, project_count, file_count, total_bytes, errors,
                            drive_total_bytes, drive_free_bytes)
         VALUES (?, ?, 'finished', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scannedAtIso,
        toIso(finishedAt),
        drive,
        scan.root,
        scan.projects.length,
        scan.filesScanned + scan.looseFiles.length,
        allBytes,
        JSON.stringify(scanMessages(scan)),
        space?.totalBytes ?? null,
        space?.freeBytes ?? null,
      );
    return { scanId: Number(lastInsertRowid), drive, projects };
  });

  // .immediate() claims the right to write at the start. If another program
  // is writing (the Scan now button, or DB Browser with unsaved edits), SQLite
  // then waits up to 5 seconds for it, instead of failing straight away.
  return { ...save.immediate(), ...counts };
}

// Records a scan that failed (e.g. the SSD wasn't plugged in at 2 AM), so
// you can see it was attempted. Projects are left exactly as they were: a
// failed scan never marks anything missing.
function recordFailedScan(db, { root, startedAt, finishedAt = Date.now(), error, drive = 'working' }) {
  db.prepare(
    `INSERT INTO scans (started_at, finished_at, status, drive, root, errors) VALUES (?, ?, 'failed', ?, ?, ?)`,
  ).run(toIso(startedAt), toIso(finishedAt), drive, root, JSON.stringify([String(error?.message ?? error)]));
}

// --- Scoring what's saved ----------------------------------------------------

// Re-scores every ranked project still on the Working SSD, from the facts saved in the
// database, and saves the new scores. Pins count from both places:
//   pinned_keep (npm run pin)  OR  folders.keepPinned in config.json.
// `now` is the time file ages are measured from: the last scan's start, so
// re-scoring after a pin gives exactly the scores that scan gave (only the
// pinned project's bucket changes).
// Returns the scored projects.
function rescoreProjects(db, config, now = latestScanTime(db)) {
  const projects = db
    .prepare("SELECT * FROM projects WHERE drive = 'working' AND kind = 'project' AND missing = 0")
    .all()
    .map((row) => {
      const project = rowToProject(row);
      project.pinnedInConfig = isPinnedByConfig(project.relPath, config.folders.keepPinned);
      project.pinnedKeep = project.pinnedInDatabase || project.pinnedInConfig;
      return project;
    });
  const scored = scoreProjects(projects, config, now);

  const update = db.prepare('UPDATE projects SET score = ?, bucket = ?, score_notes = ? WHERE id = ?');
  db.transaction(() => {
    for (const p of scored) {
      update.run(p.scoring.score, p.scoring.bucket, p.scoring.notes.join(' ') || null, p.id);
    }
  })();
  return scored;
}

// --- Settings saved on the dashboard's Settings page --------------------------

// What the Settings page saved: { overrides: { name: value }, updatedMs }.
// (src/settings.js decides what the names mean and checks the values.)
function readSavedSettings(db) {
  const row = db.prepare('SELECT overrides, updated_at FROM settings WHERE id = 1').get();
  let overrides;
  try {
    overrides = JSON.parse(row?.overrides ?? '{}');
  } catch {
    throw new DatabaseError(
      `The settings saved in ${displayPath()} aren't readable (was the settings table edited by hand?). ` +
        "Open DB Browser, set the settings row's overrides back to {} and write the change.",
    );
  }
  const isObject = overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides);
  return { overrides: isObject ? overrides : {}, updatedMs: fromIso(row?.updated_at ?? null) };
}

// Saves the Settings page's overrides and re-scores every Working SSD project
// with the new settings (`config`), in one transaction: either both happen or
// neither. Returns the re-scored projects.
function writeSavedSettings(db, overrides, config, { now = Date.now() } = {}) {
  return db
    .transaction(() => {
      db.prepare('UPDATE settings SET overrides = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(overrides), toIso(now));
      return rescoreProjects(db, config);
    })
    .immediate(); // claim the write first (see saveScan)
}

// --- Reading -----------------------------------------------------------------

// The most recent scan row of one drive (the Working SSD unless `drive` says
// otherwise): `status` 'finished' or 'failed', or leave it out for the most
// recent of either. Returns undefined if there are none.
function latestScan(db, status, { drive = 'working' } = {}) {
  const row = status
    ? db.prepare('SELECT * FROM scans WHERE drive = ? AND status = ? ORDER BY id DESC LIMIT 1').get(drive, status)
    : db.prepare('SELECT * FROM scans WHERE drive = ? ORDER BY id DESC LIMIT 1').get(drive);
  if (!row) return undefined;
  return {
    id: row.id,
    startedMs: fromIso(row.started_at),
    finishedMs: fromIso(row.finished_at),
    status: row.status,
    drive: row.drive,
    root: row.root,
    projectCount: row.project_count,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    errors: JSON.parse(row.errors),
    // How full the drive was at the scan, or null for older scans / failed ones.
    driveSpace:
      row.drive_total_bytes === null || row.drive_total_bytes === undefined || row.drive_free_bytes === null
        ? null
        : { totalBytes: row.drive_total_bytes, freeBytes: row.drive_free_bytes },
  };
}

function latestScanTime(db) {
  return latestScan(db, 'finished')?.startedMs ?? Date.now();
}

// Every saved project and shared folder of one drive (the Working SSD unless
// `drive` says otherwise), including missing ones.
function listProjects(db, { drive = 'working' } = {}) {
  return db.prepare('SELECT * FROM projects WHERE drive = ? ORDER BY name').all(drive).map(rowToProject);
}

// One saved row by its id (any drive), or undefined.
function getProject(db, id) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? rowToProject(row) : undefined;
}

// Finds a Working SSD project by its name as the report shows it ("NCHS Football /
// Week 1") or its path ("NCHS Football/Week 1"), ignoring upper/lower case.
// Returns { project } or, if there's no exact match, { suggestions }: names
// that contain what you typed.
//
// After a rename that only changes upper/lower case ("soccer" -> "Soccer"),
// the old name (now missing) and the new one match the same text, so the
// project still on the SSD wins.
function findProject(db, typedName) {
  const wanted = folderKey(typedName);
  const all = listProjects(db);
  const matches = wanted === '' ? [] : all.filter((p) => folderKey(p.relPath) === wanted);
  const project = matches.find((p) => !p.missing) ?? matches[0];
  // `sameName`: the other rows with the same name (an old spelling, now missing).
  if (project) return { project, sameName: matches.filter((p) => p !== project) };
  const suggestions = wanted === '' ? [] : all.filter((p) => folderKey(p.relPath).includes(wanted)).map((p) => p.name);
  return { suggestions: suggestions.slice(0, 10) };
}

// --- Pins --------------------------------------------------------------------

// `npm run pin`: flips your pin on one Working SSD project and re-scores.
// Returns what happened, for the command to explain:
//   { result: 'pinned' | 'unpinned', project (re-scored), stillPinnedByConfig }
//   { result: 'pinned-in-config', project } – pinned in config.json; the app never edits that file
//                                             (re-scores, so the saved bucket shows that pin too)
//   { result: 'shared', project }           – shared folders aren't ranked
//   { result: 'not-found', suggestions }
function togglePin(db, config, typedName) {
  const { project, sameName, suggestions } = findProject(db, typedName);
  if (!project) return { result: 'not-found', suggestions };
  if (project.kind === 'shared') return { result: 'shared', project };

  const pinnedInConfig = isPinnedByConfig(project.relPath, config.folders.keepPinned);
  if (pinnedInConfig && !project.pinnedInDatabase) {
    // Nothing to toggle, but if config.json changed since the last scan, the
    // saved bucket doesn't show this pin yet. Re-score so it does.
    const scored = db.transaction(() => rescoreProjects(db, config)).immediate();
    // A missing project isn't re-scored, so it has no current bucket to show.
    return { result: 'pinned-in-config', project: scored.find((p) => p.id === project.id) ?? { ...project, scoring: null } };
  }

  const pinned = !project.pinnedInDatabase;
  const scored = db
    .transaction(() => {
      db.prepare('UPDATE projects SET pinned_keep = ? WHERE id = ?').run(pinned ? 1 : 0, project.id);
      // Same project under an old spelling (e.g. before a case-only rename):
      // its pin moves to this row, so no pin is left behind that can't be reached.
      const clearOld = db.prepare('UPDATE projects SET pinned_keep = 0 WHERE id = ?');
      for (const old of sameName) clearOld.run(old.id);
      return rescoreProjects(db, config);
    })
    .immediate(); // claim the write first (see saveScan)
  return {
    result: pinned ? 'pinned' : 'unpinned',
    // A missing project isn't re-scored (it's not on the SSD to score), so its
    // saved bucket is from when it was last seen; don't pass that off as current.
    project: scored.find((p) => p.id === project.id) ?? { ...project, pinnedInDatabase: pinned, scoring: null },
    stillPinnedByConfig: !pinned && pinnedInConfig,
  };
}

// The dashboard's Pin button: the same as `npm run pin` for the project with
// this id (a Working SSD row). Found by its path, so it follows the same rules
// (e.g. after a case-only rename, the row still on the SSD gets the pin).
// Returns togglePin()'s result, or { result: 'not-found' } / { result: 'not-on-working' }.
function togglePinById(db, config, id) {
  const project = getProject(db, id);
  if (!project) return { result: 'not-found', suggestions: [] };
  if (project.drive !== 'working') return { result: 'not-on-working', project };
  return togglePin(db, config, project.relPath);
}

// Paths you've pinned with `npm run pin`, as folderKey()s. Used by `--root`
// scans, which aren't saved but should still respect your pins.
function pinnedPathKeys(db) {
  return new Set(
    db
      .prepare("SELECT path FROM projects WHERE drive = 'working' AND pinned_keep = 1")
      .all()
      .map((row) => folderKey(row.path)),
  );
}

// --- Notion (Phase 4) ---------------------------------------------------------
//
// Notion is only ever READ (src/notion/sync.js). What it said is saved here,
// so the dashboard keeps working with the last synced statuses when Notion
// can't be reached.

function rowToNotionPage(row) {
  return {
    pageId: row.page_id,
    title: row.title,
    status: row.status,
    endDate: row.end_date,
    url: row.url,
    lastEditedMs: fromIso(row.last_edited),
    firstSeenMs: fromIso(row.first_seen),
    lastSyncedMs: fromIso(row.last_synced),
    inLastSync: row.in_last_sync === 1,
  };
}

// Saves one successful sync: every page read from Notion, a fresh copy of the
// title/status/end date on each linked project, a notion_syncs row, and new
// scores. One transaction, like saveScan: all of it, or none of it.
//   pages – [{ pageId, title, status, endDate, url, lastEdited }] from sync.js
// Returns { syncId, pageCount, gone (pages no longer in Notion), projects (re-scored) }.
function saveNotionSync(db, config, { pages, startedAt, finishedAt = Date.now(), triggeredBy, dataSourceId }) {
  const syncedIso = toIso(startedAt);
  const save = db.transaction(() => {
    const before = db.prepare('SELECT page_id FROM notion_pages WHERE in_last_sync = 1').all().map((row) => row.page_id);
    // Every page starts as "not in this sync"; the pages read are switched back on.
    db.prepare('UPDATE notion_pages SET in_last_sync = 0').run();
    const upsert = db.prepare(`
      INSERT INTO notion_pages (page_id, title, status, end_date, url, last_edited, first_seen, last_synced, in_last_sync)
      VALUES (@page_id, @title, @status, @end_date, @url, @last_edited, @synced_at, @synced_at, 1)
      ON CONFLICT (page_id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        end_date = excluded.end_date,
        url = excluded.url,
        last_edited = excluded.last_edited,
        last_synced = excluded.last_synced,
        in_last_sync = 1
    `);
    for (const page of pages) {
      upsert.run({
        page_id: page.pageId,
        title: page.title ?? '',
        status: page.status ?? null,
        end_date: page.endDate ?? null,
        url: page.url ?? null,
        last_edited: page.lastEdited ?? null,
        synced_at: syncedIso,
      });
    }
    const readNow = new Set(pages.map((page) => page.pageId));

    // Linked projects get the page's new title/status/end date. A page that
    // wasn't in this sync (deleted, or no longer shared) keeps its last values:
    // the project page says so.
    db.prepare(
      `UPDATE projects SET
         notion_title = p.title, notion_status = p.status, notion_end_date = p.end_date, notion_synced_at = p.last_synced
       FROM notion_pages AS p
       WHERE projects.notion_page_id = p.page_id AND p.in_last_sync = 1`,
    ).run();

    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO notion_syncs (started_at, finished_at, status, triggered_by, data_source_id, page_count)
         VALUES (?, ?, 'finished', ?, ?, ?)`,
      )
      .run(syncedIso, toIso(finishedAt), triggeredBy, dataSourceId ?? null, pages.length);

    return {
      syncId: Number(lastInsertRowid),
      pageCount: pages.length,
      gone: before.filter((pageId) => !readNow.has(pageId)).length,
      projects: rescoreProjects(db, config),
    };
  });
  return save.immediate(); // claim the write first (see saveScan)
}

// Records a sync that failed (no internet, wrong token, ...). Nothing else
// changes: the last synced statuses stay in use.
function recordFailedNotionSync(db, { startedAt, finishedAt = Date.now(), error, triggeredBy, dataSourceId }) {
  db.prepare(
    `INSERT INTO notion_syncs (started_at, finished_at, status, triggered_by, data_source_id, error)
     VALUES (?, ?, 'failed', ?, ?, ?)`,
  ).run(toIso(startedAt), toIso(finishedAt), triggeredBy, dataSourceId ?? null, String(error?.message ?? error));
}

// The latest sync ('finished' or 'failed', or either), or undefined.
function latestNotionSync(db, status) {
  const row = status
    ? db.prepare('SELECT * FROM notion_syncs WHERE status = ? ORDER BY id DESC LIMIT 1').get(status)
    : db.prepare('SELECT * FROM notion_syncs ORDER BY id DESC LIMIT 1').get();
  if (!row) return undefined;
  return {
    id: row.id,
    startedMs: fromIso(row.started_at),
    finishedMs: fromIso(row.finished_at),
    status: row.status,
    triggeredBy: row.triggered_by,
    dataSourceId: row.data_source_id,
    pageCount: row.page_count,
    error: row.error,
  };
}

// One synced Notion page by its id, or undefined.
function getNotionPage(db, pageId) {
  const row = db.prepare('SELECT * FROM notion_pages WHERE page_id = ?').get(pageId);
  return row ? rowToNotionPage(row) : undefined;
}

// How many Working SSD projects are linked, marked "No Notion page", or not
// decided yet: { linked, none, todo }.
function notionLinkCounts(db) {
  const counts = { linked: 0, none: 0, todo: 0 };
  const rows = db
    .prepare(
      `SELECT link_source, COUNT(*) AS n FROM projects
       WHERE drive = 'working' AND kind = 'project' AND missing = 0 GROUP BY link_source`,
    )
    .all();
  for (const row of rows) counts[{ confirmed: 'linked', none: 'none' }[row.link_source] ?? 'todo'] += row.n;
  return counts;
}

// Every Notion page ever synced, A to Z (including ones gone from Notion).
function listNotionPages(db) {
  return db.prepare('SELECT * FROM notion_pages ORDER BY title COLLATE NOCASE').all().map(rowToNotionPage);
}

const LINK_ACTIONS = ['confirm', 'none', 'clear'];

// The Link to Notion page's buttons. For one or more Working SSD projects:
//   'confirm' – link them to the Notion page `pageId`
//   'none'    – No Notion page: never suggest one again
//   'clear'   – undo either: back to "not linked yet"
// Then re-scores (a Done page makes its project finished), like a pin.
// Returns { result: 'ok', projects (re-scored) }, or { result, problem } when
// nothing was changed: 'bad-request' | 'not-found' | 'not-on-working' | 'unknown-page'.
function setNotionLinks(db, config, { projectIds, action, pageId = null, now = Date.now() }) {
  if (!LINK_ACTIONS.includes(action)) return { result: 'bad-request', problem: `"action" must be one of: ${LINK_ACTIONS.join(', ')}.` };
  if (!Array.isArray(projectIds) || projectIds.length === 0 || !projectIds.every((id) => Number.isInteger(id) && id > 0)) {
    return { result: 'bad-request', problem: '"projectIds" must be a list of project ids.' };
  }
  const projects = [...new Set(projectIds)].map((id) => getProject(db, id));
  if (projects.some((p) => !p)) return { result: 'not-found', problem: "There's no project with that id." };
  if (projects.some((p) => p.drive !== 'working' || p.kind !== 'project' || p.missing)) {
    return {
      result: 'not-on-working',
      problem: 'Only projects on the Working SSD can be linked to Notion (not shared folders, or folders no longer there).',
    };
  }
  let page = null;
  if (action === 'confirm') {
    page = typeof pageId === 'string' ? db.prepare('SELECT * FROM notion_pages WHERE page_id = ?').get(pageId) : undefined;
    if (!page) return { result: 'unknown-page', problem: "That Notion page isn't in the last sync. Press Refresh Notion, then try again." };
  }

  const update = db.prepare(`
    UPDATE projects SET
      link_source = @link_source, notion_page_id = @page_id, notion_title = @title, notion_status = @status,
      notion_end_date = @end_date, notion_synced_at = @synced_at, link_decided_at = @decided_at
    WHERE id = @id
  `);
  const values = {
    link_source: { confirm: 'confirmed', none: 'none', clear: null }[action],
    page_id: page?.page_id ?? null,
    title: page?.title ?? null,
    status: page?.status ?? null,
    end_date: page?.end_date ?? null,
    synced_at: page?.last_synced ?? null,
    decided_at: action === 'clear' ? null : toIso(now),
  };
  const scored = db
    .transaction(() => {
      for (const p of projects) update.run({ ...values, id: p.id });
      return rescoreProjects(db, config);
    })
    .immediate();
  const ids = new Set(projects.map((p) => p.id));
  return { result: 'ok', projects: scored.filter((p) => ids.has(p.id)) };
}

// --- Moves (Phase 5): archive_log --------------------------------------------
//
// One row per move (see migration 6). The dashboard writes these rows only;
// the copying itself is VeriCopy's.

// Moves still in progress: the tracker (offload/moves.js) keeps asking VeriCopy about these.
const UNFINISHED_MOVE_STATES = ['starting', 'queued', 'copying', 'verifying', 'checking'];

function parseJsonList(text) {
  try {
    const list = JSON.parse(text ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rowToMove(row) {
  let spotCheck = null;
  try {
    spotCheck = row.spot_check ? JSON.parse(row.spot_check) : null;
  } catch {
    spotCheck = null;
  }
  return {
    id: row.id,
    projectId: row.project_id,
    projectPath: row.project_path,
    projectName: row.project_name,
    fromDrive: row.from_drive,
    toDrive: row.to_drive,
    sourcePath: row.source_path,
    destinationParent: row.destination_parent,
    destinationPath: row.destination_path,
    vericopyUrl: row.vericopy_url,
    jobId: row.job_id,
    sizeBytes: row.size_bytes,
    fileCount: row.file_count,
    state: row.state,
    vericopyStatus: row.vericopy_status,
    history: parseJsonList(row.status_history),
    progress: row.progress,
    bytesCopied: row.bytes_copied,
    bytesTotal: row.bytes_total,
    filesTotal: row.files_total,
    filesCopied: row.files_copied,
    filesVerified: row.files_verified,
    filesFailed: row.files_failed,
    secondsRemaining: row.seconds_remaining,
    failedFiles: parseJsonList(row.failed_files),
    fatalError: row.fatal_error,
    spotCheck,
    spotCheckOk: row.spot_check_ok === null ? null : row.spot_check_ok === 1,
    error: row.error,
    createdMs: fromIso(row.created_at),
    submittedMs: fromIso(row.submitted_at),
    updatedMs: fromIso(row.updated_at),
    finishedMs: fromIso(row.finished_at),
    unfinished: UNFINISHED_MOVE_STATES.includes(row.state),
  };
}

// Saves a new move the moment you press Start, before VeriCopy is asked, so
// even a crash right after leaves a record. Returns the move.
//   move: { projectId, projectPath, projectName, fromDrive, toDrive, sourcePath,
//           destinationParent, destinationPath, vericopyUrl, sizeBytes, fileCount }
function createMove(db, move, { now = Date.now() } = {}) {
  const at = toIso(now);
  const history = JSON.stringify([{ at, state: 'starting', vericopyStatus: null, note: 'Asked VeriCopy to start the copy' }]);
  const id = db
    .transaction(
      () =>
        db
          .prepare(
            `INSERT INTO archive_log (project_id, project_path, project_name, from_drive, to_drive, source_path,
               destination_parent, destination_path, vericopy_url, size_bytes, file_count, state, status_history,
               created_at, updated_at)
             VALUES (@projectId, @projectPath, @projectName, @fromDrive, @toDrive, @sourcePath,
               @destinationParent, @destinationPath, @vericopyUrl, @sizeBytes, @fileCount, 'starting', @history, @at, @at)`,
          )
          .run({ ...move, history, at }).lastInsertRowid,
    )
    .immediate();
  return getMove(db, Number(id));
}

// The columns updateMove may change, by their JavaScript names.
const MOVE_COLUMNS = {
  jobId: 'job_id',
  state: 'state',
  vericopyStatus: 'vericopy_status',
  progress: 'progress',
  bytesCopied: 'bytes_copied',
  bytesTotal: 'bytes_total',
  filesTotal: 'files_total',
  filesCopied: 'files_copied',
  filesVerified: 'files_verified',
  filesFailed: 'files_failed',
  secondsRemaining: 'seconds_remaining',
  failedFiles: 'failed_files',
  fatalError: 'fatal_error',
  spotCheck: 'spot_check',
  spotCheckOk: 'spot_check_ok',
  error: 'error',
  submittedMs: 'submitted_at',
  finishedMs: 'finished_at',
};

// Changes one move. A new state or VeriCopy status is added to the move's
// history (with `note`, if given). Returns the updated move, or undefined if
// there's no such move.
function updateMove(db, id, changes, { now = Date.now(), note = null } = {}) {
  return db
    .transaction(() => {
      const row = db.prepare('SELECT * FROM archive_log WHERE id = ?').get(id);
      if (!row) return undefined;
      const values = { id, updated_at: toIso(now) };
      for (const [key, value] of Object.entries(changes)) {
        const column = MOVE_COLUMNS[key];
        if (!column) throw new Error(`updateMove can't change "${key}"`);
        if (key === 'failedFiles') values[column] = JSON.stringify(value ?? []);
        else if (key === 'spotCheck') values[column] = value === null ? null : JSON.stringify(value);
        else if (key === 'spotCheckOk') values[column] = value === null ? null : value ? 1 : 0;
        else if (key === 'submittedMs' || key === 'finishedMs') values[column] = toIso(value);
        else values[column] = value ?? null;
      }
      const newState = changes.state ?? row.state;
      const newStatus = 'vericopyStatus' in changes ? changes.vericopyStatus : row.vericopy_status;
      if (newState !== row.state || newStatus !== row.vericopy_status || note) {
        const history = parseJsonList(row.status_history);
        history.push({ at: values.updated_at, state: newState, vericopyStatus: newStatus ?? null, note });
        values.status_history = JSON.stringify(history);
      }
      const columns = Object.keys(values).filter((c) => c !== 'id');
      db.prepare(`UPDATE archive_log SET ${columns.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(values);
      return rowToMove(db.prepare('SELECT * FROM archive_log WHERE id = ?').get(id));
    })
    .immediate();
}

function getMove(db, id) {
  const row = db.prepare('SELECT * FROM archive_log WHERE id = ?').get(id);
  return row ? rowToMove(row) : undefined;
}

// Moves, newest first: all of them (up to `limit`), or one project's.
function listMoves(db, { limit = 50, projectId = null } = {}) {
  const rows =
    projectId === null
      ? db.prepare('SELECT * FROM archive_log ORDER BY id DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM archive_log WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit);
  return rows.map(rowToMove);
}

function unfinishedMoves(db) {
  const marks = UNFINISHED_MOVE_STATES.map(() => '?').join(', ');
  return db.prepare(`SELECT * FROM archive_log WHERE state IN (${marks}) ORDER BY id`).all(...UNFINISHED_MOVE_STATES).map(rowToMove);
}

module.exports = {
  DEFAULT_DB_PATH,
  DatabaseError,
  nodeApiProblem,
  openDatabase,
  displayPath,
  describeDatabaseError,
  saveScan,
  savableDrive,
  recordFailedScan,
  rescoreProjects,
  latestScan,
  listProjects,
  getProject,
  findProject,
  togglePin,
  togglePinById,
  pinnedPathKeys,
  readSavedSettings,
  writeSavedSettings,
  saveNotionSync,
  recordFailedNotionSync,
  latestNotionSync,
  listNotionPages,
  getNotionPage,
  notionLinkCounts,
  setNotionLinks,
  createMove,
  updateMove,
  getMove,
  listMoves,
  unfinishedMoves,
  UNFINISHED_MOVE_STATES,
  MIGRATIONS,
  SAVED_DRIVES,
};
