'use strict';

// PHASE 2 — not built yet.
//
// This will store scan results in a SQLite database file at data/dashboard.db,
// so the dashboard can load instantly without re-scanning the SSD.
// SQLite is a whole database inside a single file; better-sqlite3 is the
// library Node will use to talk to it.
//
// SAFETY: this is the only module that will ever write files, and only inside
// the data/ folder (DATA_DIR in src/config.js).
//
// Planned schema (the tables and their columns):
//
//   scans          one row per scan run
//     id, started_at, finished_at, ssd_path, file_count, total_bytes
//
//   projects       one row per project folder, updated by each scan
//     id, rel_path (unique), name, kind (project/shared), container,
//     size_bytes, raw_bytes, proxy_bytes, export_bytes, cache_bytes,
//     project_bytes, other_bytes, file_count, last_edited_at,
//     last_project_save_at, has_export, notion_status, pinned_keep,
//     score, bucket, last_scan_id
//
//   archive_log    one row per offload (Phase 4)
//     id, project_rel_path, archived_at, destination, bytes, verified

function openDatabase() {
  throw new Error('The database arrives in Phase 2.');
}

module.exports = { openDatabase };
