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
          for 14 days                     (Phase 2)
```

**Phase 1 (now):** a Terminal command, `npm run scan`, that ranks the working
SSD's projects for Move 1 and shows how full each drive is.
**Phase 2 (next):** results saved in a database, a dashboard in your browser,
and the Library → Archive list for Move 2.

> **Safety promise.** This app only ever *reads* your drives. It never deletes,
> moves, renames, or writes anything on the Working SSD, the Library, or the
> Archive. The only folder it writes to is its own `data/` folder. A test
> (`tests/safety.test.js`) fails if code that can change files ever sneaks into
> the app. Moving projects stays your job (with Vericopy) until you ask for
> that feature.

---

## 1. What you need

- A Mac with your Working SSD plugged in (plug in the Library too, so the app
  can check how much room it has).
- **Node.js 22 or newer** (20 still works). Check in Terminal:
  ```
  node -v
  ```
  If it prints `v22.x` or higher, you're set. If it says "command not found" or
  a lower number, install the **LTS** version from <https://nodejs.org>.

## 2. Get the code

Put the app on your Mac's internal drive, **not on any of your media drives**
(the app refuses to run from one). For example:

```
mkdir -p ~/Code && cd ~/Code
git clone https://github.com/sbrignac29/SSD-Dashboard.git
cd SSD-Dashboard
git checkout claude/brave-ritchie-gwhc1j
```

Already cloned it before? Just run `git pull` inside the folder.

## 3. Set up

```
npm install
cp config.example.json config.json
```

- `npm install` downloads the packages the app depends on. Phase 1 has none, so
  it just finishes instantly. Phase 2 will add some.
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

Other ways to run it:

| Command | What it does |
|---|---|
| `npm run scan` | Scan the Working SSD and print the ranked table, drive space, and move plan |
| `npm run scan:details` | Same, plus per project: size by type, the newest file, the project-file save date, which export counted, and the score math |
| `npm run scan -- --root "/Volumes/BRIGSMEDIA/NCHS Football"` | Scan just one folder of shoots (its subfolders are treated as projects). Use it on a container like `NCHS Football` or on a whole drive — pointed at a single project folder, it would list that project's Footage/Exports subfolders as if they were separate projects. Your config lists still apply, but Size is compared only within that folder, so scores can run higher — decide what to move from a full `npm run scan` |
| `npm run scan -- --root "/Volumes/BRIGSMEDIA LIBRARY"` | Peek at what's on the Library (its buckets still describe Move 1; the proper Move 2 view comes in Phase 2) |
| `npm run scan -- --help` | List the options |

(The `--` tells npm "everything after this goes to the scan command, not to npm".)

The first time, macOS may ask whether Terminal can access files on a removable
volume. Click **Allow**.

## 5. Reading the report

**Projects table** — Ready projects first (biggest first, because moving those
frees the most space), then Review, then Keep (highest score first):

| Column | Meaning |
|---|---|
| Size (GB) | Total size of the project folder, in the same units Finder uses |
| Last edited | Date of the newest file in the project (hidden system files like `.DS_Store` don't count — Finder rewrites those just from browsing) |
| Export | **final** — the project is finished: there's a video export named with **"Final" or "FD"** (e.g. `Soccer 8-24 FD.mp4`, `Promo FINALv2.mov`) or saved in a final-exports folder (`Final Exports/`, `Exports/FD/`). **draft** — there are exports, but none that say final, so it may still be in revisions. **no** — no exports found. See section 6 for the details |
| Score | 0–100: how good a candidate it is (see section 6). Orders Review and Keep |
| Bucket | **Ready** — finished (final export) and untouched for 14+ days: move it to the Library. **Review** — finished but not safe to move yet (see Notes), or unfinished but old and big. **Keep** — unfinished, or pinned |

Below the table:
- **Buckets** — how many projects and GB are in each bucket.
- **Ready — finished because of** — for each Ready project, the export file that
  made it count as finished. Glance at this list before moving anything.
- **Notes** — why a finished project isn't Ready yet (e.g. "edited 3 days ago —
  Ready in 11 days if left alone", or "footage newer than its final export"),
  and pinned projects.
- **Drives** — how full the Working SSD, Library and Archive are, and how much
  is free (or "not connected").
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

## 6. When is a project Ready?

**Ready = finished + untouched for 14 days + nothing uncertain.**

- **Finished** means a **final export**, inside the project folder:
  - a video export whose name contains the word **"Final" or "FD"** (a short
    version number on the end is fine: `FINALv2`, `FD2`), or
  - a video export saved in a final-exports folder: one whose name says both
    final and export/render (`Final Exports`, `FINAL FINAL RENDERS`), or a
    `Final`/`FD` folder inside `Exports`.
  - For a **photo-only** project (no video exports at all), a photo export
    named or filed the same way counts.

  What does **not** count, so drafts aren't mistaken for finals:
  - a "Final"/"FD" that's only part of the **project's own name** — in
    `NCHS Basketball Regional Final`, `Regional Final Highlights v1.mp4` is a
    draft, while `Regional Final Highlights FD.mp4` is final;
  - "Semi-Final", "Quarter-Final", "Pre-Final", "Not Final";
  - names with **Draft**, **Rough** or **WIP** (`fileTypes.notFinalWords`);
  - long numbers and random IDs that phones put in file names.

  Later, Notion status (Complete/Delivered) will count as finished too.
- **Untouched for 14 days** means no file in the project changed in that time.
- **No newer footage:** if there's footage shot more than a day *after* the
  final export (say, Game 2 in a folder where Game 1 is finished), the project
  waits in Review — there may be another shoot still to edit.
- **Nothing uncertain:** a project isn't Ready if some of its folders couldn't
  be read, or if it has files with future dates (a camera with a wrong clock),
  because then the app can't be sure when you last worked on it.
- A project pinned in `folders.keepPinned` is always Keep.

**The score** ranks everything else:

```
Score = 0.45 × Done + 0.35 × Age + 0.20 × Size        (each part 0–100)
```

- **Done:** 100 if Notion says Complete/Delivered (later phase), 70 if there's a
  final export, otherwise 0.
- **Age:** 0 if edited in the last 14 days, then rising evenly to 100 at 120 days.
- **Size:** the project's size as a percentage of the biggest project in the scan.

Unfinished projects scoring 40 or more are **Review**; below 40 they're
**Keep**. An unfinished project has to be both old *and* big to reach 40
(roughly: untouched 120+ days and at least a quarter the size of the biggest
project) — those probably need a final export or a decision.

Example: final export (70), last edited 67 days ago (halfway from 14 to 120 →
50), half the size of the biggest project (50):
`0.45×70 + 0.35×50 + 0.20×50 = 31.5 + 17.5 + 10 = 59` — and it's **Ready**,
because it's finished and untouched for 14+ days.

## 7. Settings (`config.json`)

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
| `folders.keepPinned` | Projects that must always stay (bucket = Keep). Pinning a container (e.g. `"NCHS Football"`) keeps every shoot inside it |
| `fileTypes.finalExportWords` | Words in an export's name (or its folder's) that mean "final" (`final`, `fd`) |
| `fileTypes.notFinalWords` | Words that mean "not final" even if Final/FD is there too (`draft`, `rough`, `wip`) |
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

## 8. Checking the numbers against Finder

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
(also in the "Ready — finished because of" list) names the file that made the
project count as finished. `draft only` names an export that didn't count.

**Drive space.** Select the drive in Finder's sidebar and press **⌘I**:
"Capacity" and "Available" should match the Drives section (both in decimal
TB/GB).

If something looks wrong, note the project name and what Finder says, and we'll
adjust the rules.

## 9. Naming exports and where to save things

You **don't need to rename project folders** — folder names don't change scores.
What matters:

1. **Name the finished export with "FD" or "Final"** — e.g.
   `Soccer 8-24 FD.mp4` — or save it in a `Final Exports` folder. That's how the
   app knows a project is done. Leave drafts and revision cuts without it
   (`Soccer 8-24 v3.mp4`), or call them "Draft". For a playoff project like
   `Regional Final`, the export still needs its own FD/Final: the "Final" in the
   game's name doesn't count.
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

## 10. Run the tests

```
npm test
```

Tests are small programs that run the app's code with known inputs and check
the answers — including the scoring rules, the file sorting rules, the move
plan, a scan of a fake drive, and the safety checks. All should say `pass`.

## 11. Troubleshooting

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
- **Odd syntax errors when running anything** — check `node -v` is 20 or newer.

## Known limitations

- **DaVinci Resolve project library.** Your Resolve projects live in the shared
  `Resolve Project Library`, not in each project folder. If you edit a project
  in Resolve without rendering or adding files, that project folder's dates
  don't change, so it can look untouched when it isn't. Check before moving
  anything Resolve-based. (A later phase can read the library's per-project
  save dates.)
- **Exports and project files saved outside the project folder** aren't linked
  to their project. See section 9.
- **A final-looking name isn't proof.** The app ignores "Final" that comes from
  the project's own name, but a draft named, say, `State Final Recap v1.mp4` in
  a project called `NCHS Basketball` would still look final. That's why the
  report lists the file behind every Ready project — check it before moving.
- **Copied footage keeps its original dates.** Finder keeps a file's modified
  date when copying, so footage copied from an old card looks old until you
  start editing (your project file and renders will then be newer).
- **Move 2 (Library → Archive) list** comes in Phase 2. For now the move plan
  tells you how much to move once the Library hits 90%.

## Project layout

```
config.example.json      default settings (copy to config.json)
src/config.js            loads settings, runs safety checks
src/cli/scan.js          the `npm run scan` command
src/cli/report.js        formats the printed report
src/scanner/scan.js      walks a drive (read-only) and collects facts
src/scanner/classify.js  decides raw / proxy / export / cache / project / other, and final exports
src/scanner/parseName.js pulls dates out of folder names ("Soccer 8-24")
src/scanner/space.js     how full each drive is (read-only)
src/scoring/score.js     the scoring formula and the Ready/Review/Keep rule
src/scoring/plan.js      the move plan: will it fit, is the Library full
src/server.js, src/db.js, src/notion/, src/offload/, src/jobs/   later phases (stubs)
public/                  the dashboard web page (Phase 2)
tests/                   automated tests
data/                    the only folder the app writes to (not uploaded to GitHub)
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
- **Route** *(Phase 2)* — a web address the server answers, like
  `/api/projects`, paired with the function that builds the answer.
- **Schema** *(Phase 2)* — the layout of the database: which tables exist and
  which columns each has, like the column headers of a spreadsheet.
- **SQLite** *(Phase 2)* — a complete database stored in one file
  (`data/dashboard.db`).

## Roadmap

1. ✅ Scanner, file classifier, scoring, `npm run scan`, three-drive config, drive space and move plan
2. Database (SQLite) + dashboard web page + Library → Archive list (Move 2)
3. Notion sync for project status, nightly scans
4. Moving projects through Vericopy + a log of where each project went (only when you ask for it)
