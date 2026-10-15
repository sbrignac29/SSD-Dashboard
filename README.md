# SSD Offload Dashboard

Scans your working SSD, finds video/photo projects that are old or finished, and
ranks them so you know what to move to archive storage first.

**Phase 1 (now):** a Terminal command, `npm run scan`, that prints a ranked table.
**Phase 2 (next):** results saved in a database + a dashboard in your browser.

> **Safety promise.** This app only ever *reads* your SSD. It never deletes,
> moves, renames, or writes anything there. The only folder it writes to is its
> own `data/` folder. A test (`tests/safety.test.js`) fails if code that can
> change files ever sneaks into the app.

---

## 1. What you need

- A Mac with your SSD plugged in.
- **Node.js 20 or newer.** Check in Terminal:
  ```
  node -v
  ```
  If it prints `v20.x` or higher, you're set. If it says "command not found" or
  a lower number, install the **LTS** version from <https://nodejs.org>.

## 2. Get the code

Put the app on your Mac's internal drive, **not on the SSD** (the app refuses to
run from the drive it scans). For example:

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

Open `config.json` in any text editor and check `ssdPath` is your drive
(`/Volumes/BRIGSMEDIA`). If you skip this step, the app uses the example
settings as-is and tells you so.

## 4. Run a scan

```
npm run scan
```

Other ways to run it:

| Command | What it does |
|---|---|
| `npm run scan` | Scan and print the ranked table |
| `npm run scan:details` | Same, plus per project: size by type, the newest file, the project-file save date, and the score math |
| `npm run scan -- --root "/Volumes/BRIGSMEDIA/NCHS Football"` | Scan a different folder instead (its subfolders are treated as projects). Handy for trying a small folder first |
| `npm run scan -- --help` | List the options |

(The `--` tells npm "everything after this goes to the scan command, not to npm".)

The first time, macOS may ask whether Terminal can access files on a removable
volume. Click **Allow**.

## 5. Reading the report

**Projects table** — best offload candidates first:

| Column | Meaning |
|---|---|
| Size (GB) | Total size of the project folder, in the same units Finder uses |
| Last edited | Date of the newest file in the project (hidden system files like `.DS_Store` don't count — Finder rewrites those just from browsing) |
| Export | `yes` if there are files in an Exports / Deliverables / Renders folder inside the project, or a video named with "final" or "master" |
| Score | 0–100, higher = better candidate to offload (see below) |
| Bucket | **Ready** (70+), **Review** (40–69.9), **Keep** (under 40) |

Below the table:
- **Buckets** — how many projects and GB are in each bucket.
- **Safety overrides** — projects whose bucket was lowered: edited in the last
  14 days (never Ready) or pinned as Keep.
- **Shared folders** — folders used by many projects (like `Resolve Project
  Library`). Measured, never ranked. Offloading the Resolve library would break
  every Resolve project.
- **Loose files** — files sitting at the top of the drive (or directly inside a
  container folder) rather than in a project.
- **Skipped** — the recycle bin, system folders, shortcuts, hidden items.
- **Warnings** — folders that couldn't be read, settings that name a folder
  that doesn't exist (probably a typo), files with impossible future dates.

## 6. How the score works

```
Score = 0.45 × Done + 0.35 × Age + 0.20 × Size        (each part 0–100)
```

- **Done:** 100 if Notion says Complete/Delivered (from a later phase), 70 if the
  project has an export, otherwise 0.
- **Age:** 0 if edited in the last 14 days, then rising evenly to 100 at 120 days.
- **Size:** the project's size as a percentage of the biggest project.

Example: has an export (70), last edited 67 days ago (halfway from 14 to 120 →
50), half the size of the biggest project (50):
`0.45×70 + 0.35×50 + 0.20×50 = 31.5 + 17.5 + 10 = 59` → **Review**.

Safety overrides: a project edited in the last 14 days is never Ready, and a
project pinned in `folders.keepPinned` is always Keep.

## 7. Settings (`config.json`)

| Setting | What it does |
|---|---|
| `ssdPath` | Where your SSD is mounted. Run `ls /Volumes` to see drive names |
| `archivePath` | Where offloaded projects will go (later phase). Leave `""` for now |
| `ageDays.recent` / `ageDays.max` | The 14-day "too recent" window and the 120-day "fully old" point |
| `weights` | The 0.45 / 0.35 / 0.20 mix. Must add up to 1 |
| `buckets.ready` / `buckets.review` | The 70 and 40 cut-offs |
| `doneStatuses` | Notion statuses that mean "done" (later phase) |
| `folders.ignore` | Top-level folders to skip completely |
| `folders.shared` | Folders used across projects: measured, never ranked |
| `folders.containers` | Folders that hold many shoots (like `NCHS Football`). Each subfolder becomes its own project |
| `folders.keepPinned` | Projects that must always stay (bucket = Keep) |
| `fileTypes.*` | The extensions and folder words used to sort files into raw / proxy / export / cache / project |

Folder names are matched ignoring upper/lower case. To name a subfolder of a
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
`Last edited 2026-06-09 14:03   Exports/Week 1 Highlights.mp4`. Find that file
in Finder, Get Info, and check **Modified** matches. Note that Finder's
"Date Modified" on a *folder* means something different (when files were last
added or removed in it), so compare the file, not the folder.

To double-check nothing in the project is newer, paste this into Terminal
(change the folder name):

```
find "/Volumes/BRIGSMEDIA/Soccer 8-24" -type f ! -name '.*' -exec stat -f '%Sm  %N' -t '%Y-%m-%d %H:%M' {} + | sort | tail -3
```

It lists the 3 most recently modified files, newest last.

**Export.** Open the project and look for an Exports / Deliverables / Renders
folder with files in it, or a video with "final" or "master" in its name.

If something looks wrong, note the project name and what Finder says, and we'll
adjust the rules.

## 9. Run the tests

```
npm test
```

Tests are small programs that run the app's code with known inputs and check
the answers — including the scoring formula, the file sorting rules, a scan of
a fake drive, and the safety checks. All should say `pass`.

## 10. Troubleshooting

- **"Can't find /Volumes/BRIGSMEDIA. Is the SSD plugged in?"** — plug it in, or
  run `ls /Volumes` and fix `ssdPath` in `config.json`.
- **"macOS blocked access" / "Operation not permitted"** — System Settings →
  Privacy & Security → Files and Folders → Terminal → turn on
  **Removable Volumes**. Then run the scan again.
- **"This app is stored on the drive it scans"** — move the app folder off the
  SSD (e.g. to `~/Code`).
- **"config.json isn't valid JSON"** — look for a missing or extra comma.
- **Odd syntax errors when running anything** — check `node -v` is 20 or newer.

## Known limitations

- **DaVinci Resolve project library.** Your Resolve projects live in the shared
  `Resolve Project Library`, not in each project folder. If you edit a project
  in Resolve without rendering or adding files, that project folder's dates
  don't change, so it can look older than it is. Check before offloading
  anything Resolve-based. (A later phase can read the library's per-project
  save dates.)
- **Copied footage keeps its original dates.** Finder keeps a file's modified
  date when copying, so footage copied from an old card looks old until you
  start editing (your project file and renders will then be newer).

## Project layout

```
config.example.json      default settings (copy to config.json)
src/config.js            loads settings, runs safety checks
src/cli/scan.js          the `npm run scan` command
src/cli/report.js        formats the printed report
src/scanner/scan.js      walks the SSD (read-only) and collects facts
src/scanner/classify.js  decides raw / proxy / export / cache / project / other
src/scanner/parseName.js pulls dates out of folder names ("Soccer 8-24")
src/scoring/score.js     the scoring formula
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
- **Symlink** — a shortcut to another file or folder. The scanner never follows
  them, so it can't wander outside your SSD.
- **Test** — code that runs other code with known inputs and checks the answers.
- **Route** *(Phase 2)* — a web address the server answers, like
  `/api/projects`, paired with the function that builds the answer.
- **Schema** *(Phase 2)* — the layout of the database: which tables exist and
  which columns each has, like the column headers of a spreadsheet.
- **SQLite** *(Phase 2)* — a complete database stored in one file
  (`data/dashboard.db`).

## Roadmap

1. ✅ Scanner, file classifier, scoring, `npm run scan`
2. Database (SQLite) + dashboard web page
3. Notion sync for project status, nightly scans
4. Offloading through Vericopy + archive log (only when you ask for it)
