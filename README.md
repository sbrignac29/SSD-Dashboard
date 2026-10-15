# SSD Offload Dashboard

Scans your working SSD, finds video/photo projects that are finished, and tells
you which ones to move off it — and whether they'll fit where they're going.

**Your workflow, which the app follows:**

```
 cards ──▶  Working SSD (2TB)  ──▶  Library HDD (2TB)  ──▶  Archive HDD (28TB)
            /Volumes/BRIGSMEDIA     /Volumes/BRIGSMEDIA     /Volumes/Expansion/
            offload + edit here     LIBRARY                 BRIGSMEDIA ARCHIVE
                                    finished, recent        everything older,
                                    projects                once the Library
                                                            reaches 90% full
          Move 1: finished + untouched    Move 2: oldest first
          for 14 days                     (Phase 3)
```

**Phase 1 (done):** a Terminal command, `npm run scan`, that ranks the working
SSD's projects for Move 1 and shows how full each drive is.
**Phase 2 (now):** scan results are saved in a database (`data/dashboard.db`),
so `npm run report` shows them instantly without rescanning, and
`npm run pin` marks projects you want to keep.
**Phase 3 (next):** a dashboard in your browser, nightly scans, the Library →
Archive list for Move 2, and Notion status.

> **Safety promise.** This app only ever *reads* your drives. It never deletes,
> moves, renames, or writes anything on the Working SSD, the Library, or the
> Archive. The only folder it writes to is its own `data/` folder (where the
> database lives). A test
> (`tests/safety.test.js`) fails if code that can change files ever sneaks into
> the app. Moving projects stays your job (with Vericopy) until you ask for
> that feature.

---

## 1. What you need

- A Mac with your Working SSD plugged in (plug in the Library too, so the app
  can check how much room it has).
- **Node.js 22 or newer.** Check in Terminal:
  ```
  node -v
  ```
  If it prints `v22.x` or higher, you're set. If it says "command not found" or
  a lower number (like `v20.x`), install the **LTS** version from
  <https://nodejs.org>. Phase 2's database library needs Node 22, and Node 20
  stopped getting security updates in April 2026.

## 2. Get the code

Put the app on your Mac's internal drive, **not on any of your media drives**
(the app refuses to run from one). For example:

```
mkdir -p ~/Code && cd ~/Code
git clone https://github.com/sbrignac29/SSD-Dashboard.git
cd SSD-Dashboard
git checkout claude/clever-babbage-gcsvh9
```

Already cloned it for Phase 1? Inside the folder, run:

```
git fetch
git checkout claude/clever-babbage-gcsvh9
npm install
```

(Phase 1 lives on the `claude/brave-ritchie-gwhc1j` branch; Phase 2 is on
`claude/clever-babbage-gcsvh9`.)

## 3. Set up

```
npm install
cp config.example.json config.json
```

- `npm install` downloads the two packages the app depends on into a folder
  called `node_modules`: **better-sqlite3** (talks to the database) and
  **node-cron** (runs the nightly scan on a schedule). better-sqlite3 includes
  ready-made versions for Apple Silicon and Intel Macs, so nothing needs to be
  compiled. Run `npm install` again whenever you pull an update that changes
  `package.json`.
- `cp` copies the example settings into **your own** `config.json`. Git ignores
  that file, so your paths (and later, your Notion key) never get uploaded.

The example settings already have your three drives. Open `config.json` in a
code editor (like VS Code) if you want to change anything. If you use TextEdit,
first turn off **Edit → Substitutions → Smart Quotes** — JSON needs straight
`"` quotes, not curly `“ ”` ones. If you skip this step, the app uses the
example settings as-is and tells you so.

Made a `config.json` before the three-drive update? The app will say
`"ssdPath" was replaced by the "drives" section` — just copy the example again
(`cp config.example.json config.json`) and redo any edits.

## 4. Run a scan

```
npm run scan
```

This scans the Working SSD, **saves the results to the database**, and prints
the ranked table, drive space, and move plan. At the bottom it says what
changed in the database, e.g.
`Saved to data/dashboard.db — 2 new · 41 updated · 1 no longer found`.

All the commands:

| Command | What it does |
|---|---|
| `npm run scan` | Scan the Working SSD, save to the database, and print the ranked table, drive space, and move plan |
| `npm run scan:details` | Same, plus per project: size by type, the newest file, the project-file save date, which export counted, and the score math |
| `npm run report` | Print the saved results from the database, **without scanning**. Instant, and works with the SSD unplugged |
| `npm run pin -- "Project name"` | Pin a project as Keep, or unpin it (see section 7) |
| `npm run pin` | List the pinned projects |
| `npm run scan -- --root "/Volumes/BRIGSMEDIA/NCHS Football"` | Scan just one folder as a quick preview (its subfolders are treated as projects). **Not saved**: it only sees part of the SSD, and saving it would mark everything else as missing. Your config lists and pins still apply, but Size is compared only within that folder, so scores can run higher — decide what to move from a full `npm run scan` |
| `npm run scan -- --root "/Volumes/BRIGSMEDIA LIBRARY"` | Peek at what's on the Library. **Not saved** (its buckets still describe Move 1; the proper Move 2 view comes in Phase 3) |
| `npm run scan -- --help` | List the options |

(The `--` tells npm "everything after this goes to the command, not to npm".)

The first time, macOS may ask whether Terminal can access files on a removable
volume. Click **Allow**.

**When does the database update?** Every `npm run scan` of the whole Working
SSD (without `--root`). A rescan updates each project's row; it never creates
duplicates. A project that's gone from the SSD (moved to the Library, renamed,
deleted) is **marked missing, not deleted**, so its history stays.
`npm run report` lists those under "No longer on the Working SSD". A scan
that fails (SSD not plugged in) is recorded as failed and changes nothing else.

**Nightly scans (not running yet).** The job that scans at 2:00 AM every night
is built (`src/jobs/nightly.js`), but it starts with the dashboard server in
Phase 3. Until then, the database updates only when you run `npm run scan`.
Once it runs: your Mac needs to be awake and the SSD plugged in at 2 AM. A
missed or failed night is harmless; it's logged, and the next one tries again.

## 5. Reading the report

**Projects table** — Ready projects first (biggest first, because moving those
frees the most space), then Review, then Keep (highest score first):

| Column | Meaning |
|---|---|
| Size (GB) | Total size of the project folder, in the same units Finder uses |
| Last edited | Date of the newest file in the project (hidden system files like `.DS_Store` don't count — Finder rewrites those just from browsing) |
| Export | **final** — a video export named with **"Final" or "FD"** (e.g. `Soccer 8-24 FD.mp4`, `Promo FINALv2.mov`): the project is finished. **draft** — there are exports, but none named Final/FD, so it may still be in revisions. **no** — no exports found |
| Score | 0–100: how good a candidate it is (see section 6). Orders Review and Keep |
| Bucket | **Ready** — finished (final export) and untouched for 14+ days: move it to the Library. **Review** — finished but edited in the last 14 days, or unfinished but old/big. **Keep** — unfinished, or pinned |

Below the table:
- **Buckets** — how many projects and GB are in each bucket.
- **Notes** — why a finished project isn't Ready yet (e.g. "edited 3 days ago —
  Ready in 11 days if left alone"), and pinned projects.
- **Drives** — how full the Working SSD, Library and Archive are (or "not
  connected").
- **Move plan** — how much moving the Ready projects frees on the SSD, whether
  they fit on the Library, and a warning when the Library is (or would be) 90%
  full, with roughly how much of its oldest work to move to the Archive.
- **Shared folders** — folders used by many projects (like `Resolve Project
  Library`). Measured, never ranked. Moving the Resolve library would break
  every Resolve project.
- **Loose files** — files sitting at the top of the drive (or directly inside a
  container folder) rather than in a project.
- **Skipped** — the recycle bin, system folders, shortcuts, hidden items.
- **Warnings** — folders that couldn't be read, settings that name a folder
  that doesn't exist (probably a typo), files with impossible future dates.

`npm run report` prints the same table from the database, plus:
- the **date of the last scan** and how long ago it was (and a red warning if
  a later scan failed, e.g. the SSD wasn't plugged in),
- **Your pins**: projects you pinned with `npm run pin`,
- **No longer on the Working SSD**: projects a scan used to see but the latest
  one didn't (usually because you moved them to the Library), with the date
  they were last seen and their last bucket.

Its Drives and Move plan sections use how full the drives are right now, with
the Ready projects from the last scan. It doesn't list loose files or skipped
items (those aren't saved); run `npm run scan` for those.

## 6. When is a project Ready?

**Ready = finished + untouched for 14 days + nothing uncertain.**

- **Finished** means a **final export**: a video file in the project whose name
  contains the word "Final" or "FD" (a version or number on the end is fine:
  `FINALv2`, `FD2`). Draft exports don't count. Later, Notion status
  (Complete/Delivered) will count too.
- **Untouched for 14 days** means no file in the project changed in that time.
- **Nothing uncertain:** a project isn't Ready if some of its folders couldn't
  be read, or if it has files with future dates (a camera with a wrong clock),
  because then the app can't be sure when you last worked on it.
- A pinned project (with `npm run pin`, or in `folders.keepPinned`) is always
  Keep.

**The score** ranks everything else:

```
Score = 0.45 × Done + 0.35 × Age + 0.20 × Size        (each part 0–100)
```

- **Done:** 100 if Notion says Complete/Delivered (later phase), 70 if there's a
  final export, otherwise 0.
- **Age:** 0 if edited in the last 14 days, then rising evenly to 100 at 120 days.
- **Size:** the project's size as a percentage of the biggest project in the scan.

Unfinished projects scoring 40 or more are **Review** (big or old projects that
probably need a final export or a decision); below 40 they're **Keep**.

Example: final export (70), last edited 67 days ago (halfway from 14 to 120 →
50), half the size of the biggest project (50):
`0.45×70 + 0.35×50 + 0.20×50 = 31.5 + 17.5 + 10 = 59` — and it's **Ready**,
because it's finished and untouched for 14+ days.

## 7. Pinning projects (always Keep)

Some projects should stay on the Working SSD however finished they look: a
client who comes back for re-edits, your reel, a template project. Pin them:

```
npm run pin -- "Parker Soccer 10-3"
```

```
Pinned "Parker Soccer 10-3" as Keep.
  Pinned as Keep (would be Ready).
  Run the same command again to unpin it.
```

- Use the name exactly as the report shows it, **in quotes**. Upper/lower case
  doesn't matter. For a container shoot, `"NCHS Football / Week 1"` and
  `"NCHS Football/Week 1"` both work.
- Typo? It suggests close matches.
- Run the **same command again** to unpin. `npm run pin` on its own lists
  everything that's pinned.
- A pinned project is **always Keep**, through every future scan, until you
  unpin it. The score still shows, so you can see what it would be.
- Only the database changes; nothing on any drive does.

**Two ways to pin.** `npm run pin` saves your pin in the database. You can
also list folders under `folders.keepPinned` in `config.json` (handy for a
whole container, like `"NCHS Football"`). Either one makes a project Keep. The
app never edits `config.json` itself, so to unpin something that's pinned
there, remove it from that list by hand. `npm run pin` tells you when that's
the case.

**Renamed a pinned folder?** A rename looks like a new project to the app (the
old name is marked missing), so pin it again under its new name.

## 8. The database: open it yourself

All saved results live in one file: **`data/dashboard.db`** inside the app
folder (e.g. `~/Code/SSD-Dashboard/data/dashboard.db`). It's an **SQLite**
database: a complete database stored as a single file. Git ignores it, so it
stays on your Mac.

### Look inside with DB Browser for SQLite (free)

1. **Install it.** Download the macOS version from
   <https://sqlitebrowser.org/dl/> (pick Apple Silicon or Intel to match your
   Mac), open the `.dmg`, and drag it to Applications. Or, if you use
   Homebrew: `brew install --cask db-browser-for-sqlite`. If macOS says it
   can't check the app, right-click it in Applications → **Open** → **Open**.
2. **Open the database read-only.** In DB Browser choose
   **File → Open Database Read Only…** and pick `data/dashboard.db` in the app
   folder. (In the file picker, **⌘⇧G** lets you type a path like
   `~/Code/SSD-Dashboard/data`.)
   **Read-only matters:** if you edit something and leave it unsaved, DB Browser
   locks the file, and a scan or pin will stop with "The database is busy".
3. **Look around:**
   - **Database Structure** tab: the **schema**, i.e. the three tables
     (`projects`, `scans`, `archive_log`) and their columns.
   - **Browse Data** tab: pick a table from the **Table** menu to see its rows.
     Click a column header to sort; type in the box under a header to filter
     (e.g. `Ready` under `bucket`).
   - **Execute SQL** tab: paste a question (a "query") and press the ▶ button.

Things to know when reading it:
- **Dates are in UTC** (world time; the `Z` at the end), e.g.
  `2026-10-15T07:00:00.000Z`. The queries below convert them to your Mac's
  time with `datetime(…, 'localtime')`.
- **Sizes are in bytes.** Divide by 1,000,000,000 for GB (`size_bytes / 1e9`).
- **1 = yes, 0 = no** (for `has_final_export`, `pinned_keep`, `missing`, …).

### Queries to paste into "Execute SQL"

Projects still on the Working SSD, in bucket order (Ready, Review, Keep):

```sql
SELECT name, round(size_bytes / 1e9, 2) AS size_gb, score, bucket,
       datetime(last_modified, 'localtime') AS last_edited, pinned_keep
FROM projects
WHERE kind = 'project' AND missing = 0
ORDER BY CASE bucket WHEN 'Ready' THEN 0 WHEN 'Review' THEN 1 ELSE 2 END, score DESC;
```

How many projects and GB are in each bucket:

```sql
SELECT bucket, COUNT(*) AS projects, round(SUM(size_bytes) / 1e9, 2) AS gb
FROM projects
WHERE kind = 'project' AND missing = 0
GROUP BY bucket;
```

Projects no longer on the Working SSD (moved to the Library, renamed, or deleted):

```sql
SELECT name, round(size_bytes / 1e9, 2) AS size_gb,
       datetime(last_scanned, 'localtime') AS last_seen, bucket AS last_bucket
FROM projects
WHERE missing = 1;
```

Every scan, newest first, including failed ones:

```sql
SELECT id, datetime(started_at, 'localtime') AS started, status,
       project_count, round(total_bytes / 1e9, 1) AS total_gb, errors
FROM scans
ORDER BY id DESC;
```

### What's in each table

**`projects`**: one row per project folder (and per shared folder) on the
Working SSD, updated by every scan.

| Column | Meaning |
|---|---|
| `id` | Row number. Never changes |
| `path` | Where the folder is, from the top of the drive (`NCHS Football/Week 1`). Unique: a rescan updates this row instead of adding another |
| `name` | Name as the report shows it (`NCHS Football / Week 1`) |
| `kind` | `project` (ranked) or `shared` (measured, never ranked) |
| `client` | The container for container shoots (`NCHS Football`); empty for others until Notion sync (Phase 3) |
| `size_bytes` | Total size |
| `raw_bytes` … `other_bytes` | Size by type: raw, proxy, export, cache, project, other |
| `file_count` | Number of files |
| `last_modified`, `last_modified_file` | Newest real file, and which file |
| `last_nle_save`, `last_nle_save_file` | Last save of a project file (.drp, .prproj, …). NLE = "non-linear editor" (Resolve, Premiere) |
| `has_export`, `export_file` | Whether any export exists (drafts too), and an example file |
| `has_final_export`, `final_export_file` | Whether a video export named "Final"/"FD" exists (the project is finished), and which file |
| `future_dated_files`, `incomplete` | Signs the last-edit date is uncertain (camera clock, unreadable folders), which block Ready |
| `score`, `bucket`, `score_notes` | The result, and why a finished project isn't Ready yet or that it's pinned |
| `pinned_keep` | 1 = you pinned it with `npm run pin`. Scans never change this |
| `first_seen` | The first scan that found it |
| `last_scanned` | The latest scan that found it |
| `missing` | 1 = the latest scan didn't find it on the Working SSD. The row is kept for history |

**`scans`**: one row per scan: `started_at`, `finished_at`, `status`
(`finished` or `failed`), `root` (the folder scanned), `project_count`,
`file_count`, `total_bytes`, and `errors` (the warnings, or why it failed, as a
JSON list).

**`archive_log`**: empty for now. When moving projects arrives (Phase 4) it
gets one row per move: `archived_at`, `project_id` (points at the `projects`
row), `project_path`, `destination_drive` (`library` or `archive`),
`size_bytes`, `checksum_result`. Together, those rows are each project's trail
(SSD → Library on one date → Archive on another), so you can always find it.

### Prefer Terminal?

macOS includes the `sqlite3` command:

```
sqlite3 -readonly data/dashboard.db
```

Then type `.mode box` (nicer tables), paste any query above, and type `.quit`
to leave.

### Back up or start over

- **Back up:** copy `data/dashboard.db` somewhere while no scan is running.
- **Start over:** delete `data/dashboard.db`; the next `npm run scan` makes a
  new one. You lose your pins, the scan history, and the "no longer on the
  Working SSD" list.

## 9. Settings (`config.json`)

| Setting | What it does |
|---|---|
| `drives.working` | Your Working SSD (`/Volumes/BRIGSMEDIA`). Run `ls /Volumes` to see drive names |
| `drives.library` | Your Library HDD (`/Volumes/BRIGSMEDIA LIBRARY`) |
| `drives.archive` | Your Archive folder (`/Volumes/Expansion/BRIGSMEDIA ARCHIVE`). Use `""` for a drive you don't have |
| `libraryFull.startAtPercent` | When the Library is this full (90%), it's time to move its oldest projects to the Archive |
| `libraryFull.targetPercent` | How far down to bring the Library when that happens (70% — change it if you prefer) |
| `ageDays.recent` / `ageDays.max` | The 14-day "still being worked on" window and the 120-day "fully old" point |
| `weights` | The 0.45 / 0.35 / 0.20 mix. Must add up to 1 |
| `buckets.review` | Unfinished projects scoring this or more (40) are Review instead of Keep |
| `doneStatuses` | Notion statuses that mean "done" (later phase) |
| `folders.ignore` | Top-level folders to skip completely |
| `folders.shared` | Folders used across projects: measured, never ranked |
| `folders.containers` | Folders that hold many shoots (like `NCHS Football`). Each subfolder becomes its own project |
| `folders.keepPinned` | Projects that must always stay (bucket = Keep). Pinning a container (e.g. `"NCHS Football"`) keeps every shoot inside it. For single projects, `npm run pin` is easier (section 7) |
| `fileTypes.finalExportWords` | Words in a video export's name that mean "final" (`final`, `fd`) |
| `fileTypes.*` (the rest) | The extensions and folder words used to sort files into raw / proxy / export / cache / project |

The folder lists apply to every drive (they're laid out the same way). Folder
names are matched ignoring upper/lower case. To name a subfolder of a
container, write `"NCHS Football/Graphics"`.

**Please review these lists** — they were guessed from your folder names:
- Should `NCHS Basketball`, `HAWK TV`, or any other folder be a **container**?
- Are `FINAL EXPORTS`, `FINAL FINAL RENDERS`, `Project files`, `Proxy`,
  `ProRes Proxies`, `BrigsMedia Assets` really **shared**, or are any of them a
  single project?

JSON tips: text goes in "double quotes", items in a list are separated by
commas, and there's **no comma after the last item**. If you break the file,
the app tells you where.

## 10. Checking the numbers against Finder

Run `npm run scan:details`, pick a project, and compare:

**Size.** In Finder, select the project folder and press **⌘I** (Get Info).
Finder shows something like `Size: 87,512,345,678 bytes (87.6 GB on disk)`.
Compare the **bytes** number with the `= … bytes` number in the details. They
should match closely. Notes:
- Both use decimal GB (1 GB = 1,000,000,000 bytes). Don't compare with
  `du -h` in Terminal — it uses a different unit (about 7% smaller numbers).
- "On disk" is usually a bit bigger than the size, because the drive stores
  files in fixed-size blocks. The details show both.
- Get Info may take a few seconds to finish counting a big folder — wait until
  the number stops changing.
- Small differences (a few MB) can come from hidden `._` helper files that
  macOS creates on non-Mac drives.

**Last edited.** The details name the exact newest file, e.g.
`Last edited 2026-06-09 14:03   Exports/Week 1 Highlights FD.mp4`. Find that
file in Finder, Get Info, and check **Modified** matches. Note that Finder's
"Date Modified" on a *folder* means something different (when files were last
added or removed in it), so compare the file, not the folder.

To double-check nothing in the project is newer, paste this into Terminal
(change the folder name):

```
find "/Volumes/BRIGSMEDIA/Soccer 8-24" -type f ! -name '.*' -exec stat -f '%Sm  %N' -t '%Y-%m-%d %H:%M' {} + | sort | tail -3
```

It lists the 3 most recently modified files, newest last.

**Export.** The details line `Export  final — Exports/Week 1 Highlights FD.mp4`
names the file that made the project count as finished. `draft only` names an
export that didn't count because it isn't named Final/FD.

**Drive space.** Select the drive in Finder's sidebar and press **⌘I**:
"Capacity" and "Available" should match the Drives section (both in decimal
TB/GB).

If something looks wrong, note the project name and what Finder says, and we'll
adjust the rules.

## 11. Naming exports and where to save things

You **don't need to rename project folders** — folder names don't change scores.
What matters:

1. **Name the finished export with "FD" or "Final"** — e.g.
   `Soccer 8-24 FD.mp4`. That's how the app knows a project is done. Leave
   drafts and revision cuts without it (`Soccer 8-24 v3.mp4`).
2. **Save it inside the project folder**, ideally in an `Exports` subfolder:
   `Soccer 8-24/Exports/Soccer 8-24 FD.mp4`. Exports saved in the shared
   `FINAL EXPORTS` / `FINAL FINAL RENDERS` folders, or loose at the top of the
   drive, can't be linked back to their project, so it never counts as finished.
3. **Save each project's Premiere project (`.prproj`) inside its folder.**
   Project files kept in the shared `Project files` folder don't count as
   editing that project, so a project you're revising could look untouched.
4. **Container shoots:** put each game's exports inside that game's folder
   (`NCHS Football/Week 3 vs X/Exports/`), not in one shared
   `NCHS Football/Exports` folder.
5. **Resolve projects:** before moving a Resolve project to the Library, export
   a `.drp` (or a Resolve project archive) into its folder. Its timeline lives
   in `Resolve Project Library` on the SSD, not in the project folder.

For **new** folders, a date-first name helps you (and later, Notion matching):
`2026-08-24 Next Elite - Soccer Training`. It sorts by date in Finder and
includes the year. The app already understands it.

⚠️ Don't rename folders of projects that are open in Resolve or Premiere — the
media links break. And if you rename a folder that's listed in `config.json`
(shared, containers, pinned...), update the name there too; the scan warns you
about names it can't find.

## 12. Run the tests

```
npm test
```

Tests are small programs that run the app's code with known inputs and check
the answers — including the scoring rules, the file sorting rules, the move
plan, a scan of a fake drive, the database (scanning twice creates no
duplicates, missing projects are kept, a pinned project is never Ready), the
nightly schedule, and the safety checks. All should say `pass`.

The database tests use their own throwaway database inside `data/`; they never
touch your real `data/dashboard.db`.

## 13. Troubleshooting

- **"Can't find /Volumes/BRIGSMEDIA. Is the drive plugged in?"** — plug it in,
  or run `ls /Volumes` and fix `drives.working` in `config.json`.
- **"macOS blocked access" / "Operation not permitted"** — System Settings →
  Privacy & Security → Files and Folders → Terminal → turn on
  **Removable Volumes**. Then run the scan again.
- **"This app is stored inside your …"** — move the app folder off your media
  drives (e.g. to `~/Code`).
- **"config.json isn't valid JSON"** — look for a missing or extra comma, or
  curly quotes (`“ ”`) that TextEdit swapped in for straight ones (`"`).
- **"The SSD disconnected during the scan"** — the drive went away mid-scan
  (cable, dock, sleep). Plug it back in and run the scan again.
- **Library shows "not connected"** — plug it in to get the move plan's
  "will it fit" check. Everything else works without it.
- **"The database library isn't installed"** — run `npm install` in the app
  folder (needed once after pulling Phase 2).
- **"The database library couldn't load"** — run `npm rebuild better-sqlite3`.
  If that doesn't help, delete the `node_modules` folder and run `npm install`.
- **"The database is busy"** — another program is changing
  `data/dashboard.db`, usually DB Browser with unsaved edits. Click **Write
  Changes** or **Revert Changes** (or close it) and try again. Open it with
  **Open Database Read Only** to avoid this.
- **"No saved results yet"** — run `npm run scan` once; `npm run report` and
  `npm run pin` read what it saves.
- **"No project called … in the database"** (pin) — use the name the report
  shows, in quotes. Names come from the last scan, so rescan after renaming.
- **Odd syntax errors, or npm warnings about "engine"** — check `node -v` is
  22 or newer.

## Known limitations

- **DaVinci Resolve project library.** Your Resolve projects live in the shared
  `Resolve Project Library`, not in each project folder. If you edit a project
  in Resolve without rendering or adding files, that project folder's dates
  don't change, so it can look untouched when it isn't. Check before moving
  anything Resolve-based. (A later phase can read the library's per-project
  save dates.)
- **Exports and project files saved outside the project folder** aren't linked
  to their project. See section 11.
- **A final-looking name isn't proof.** A video named with "Final" (say, footage
  of a "State Final" game) counts as a final export. `scan:details` always names
  the file that counted, so you can check.
- **Copied footage keeps its original dates.** Finder keeps a file's modified
  date when copying, so footage copied from an old card looks old until you
  start editing (your project file and renders will then be newer).
- **Move 2 (Library → Archive) list** comes in Phase 3. For now the move plan
  tells you how much to move once the Library hits 90%.
- **Renaming a project folder** makes it look like a new project: the old name
  is marked missing and the new name starts fresh (pin it again if it was
  pinned).
- **One Working SSD per database.** Projects are tracked by their path from the
  top of the drive. If you point `drives.working` at a different drive, the
  first drive's projects show as no longer on the SSD.
- **Settings changes apply at the next scan.** `npm run report` shows the
  scores saved by the last scan, so after editing `config.json` (weights,
  pins, shared folders…) run `npm run scan` to see the effect.

## Project layout

```
config.example.json      default settings (copy to config.json)
src/config.js            loads settings, runs safety checks
src/cli/scan.js          the `npm run scan` command
src/cli/report.js        the `npm run report` command
src/cli/pin.js           the `npm run pin` command
src/cli/format.js        formats the printed reports
src/db.js                the database: tables, saving scans, pins (writes only in data/)
src/jobs/scanAndSave.js  one full scan + save (used by `npm run scan` and the nightly job)
src/jobs/nightly.js      the 2 AM nightly scan (starts with the dashboard server in Phase 3)
src/scanner/scan.js      walks a drive (read-only) and collects facts
src/scanner/classify.js  decides raw / proxy / export / cache / project / other, and final exports
src/scanner/parseName.js pulls dates out of folder names ("Soccer 8-24")
src/scanner/space.js     how full each drive is (read-only)
src/scoring/score.js     the scoring formula and the Ready/Review/Keep rule
src/scoring/plan.js      the move plan: will it fit, is the Library full
src/server.js, src/notion/, src/offload/   later phases (stubs)
public/                  the dashboard web page (Phase 3)
tests/                   automated tests
data/                    the only folder the app writes to: dashboard.db (not uploaded to GitHub)
```

## Glossary

- **Module** — a JavaScript file that shares some of its functions with other
  files (`module.exports`), which load them with `require(...)`.
- **npm script** — a shortcut in `package.json`: `npm run scan` runs the
  command listed under `"scan"`.
- **CLI** — command-line interface: a program you run by typing in Terminal.
- **mtime** — a file's "modified time": when its contents last changed. The app
  uses this, never "access time" (which changes whenever anything reads a file).
- **statfs** — the operating system's "how big is this drive, how much is free"
  question. Read-only.
- **Symlink** — a shortcut to another file or folder. The scanner never follows
  them, so it can't wander outside your drives.
- **Test** — code that runs other code with known inputs and checks the answers.
- **Route** *(Phase 3)* — a web address the server answers, like
  `/api/projects`, paired with the function that builds the answer.
- **SQLite** — a complete database stored in one file (`data/dashboard.db`).
- **Table / row / column** — a table is like one spreadsheet tab: each column
  has a fixed name and type, and each row is one thing (one project, one scan).
- **Schema** — the layout of the database: which tables exist and which
  columns each has, like the column headers of a spreadsheet.
- **SQL** — the language for asking a database questions (`SELECT … FROM
  projects WHERE …`) and changing it (`INSERT`, `UPDATE`).
- **Upsert** — "insert, or update if it's already there". How a rescan updates
  a project's row instead of adding a duplicate.
- **Transaction** — a group of database changes that happen all together or
  not at all. A scan is saved in one transaction, so a crash halfway can't
  leave half a scan behind.
- **Migration** — a step that upgrades the database's layout (e.g. adds a
  column) while keeping its data. The database remembers which steps it has.
- **Cron expression** — five fields that describe a repeating time:
  minute, hour, day of month, month, day of week. `0 2 * * *` = 2:00 AM daily.

## Roadmap

1. ✅ Scanner, file classifier, scoring, `npm run scan`, three-drive config, drive space and move plan
2. ✅ Database (SQLite), `npm run report`, `npm run pin`, the nightly scan job
3. Dashboard web page (the server also starts the nightly scans), Library →
   Archive list (Move 2), Notion sync for project status
4. Moving projects through Vericopy + a log of where each project went (only when you ask for it)
