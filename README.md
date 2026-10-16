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
          for 14 days                     (the Done HDD page)
```

**Phase 1 (done):** a Terminal command, `npm run scan`, that ranks the working
SSD's projects for Move 1 and shows how full each drive is.
**Phase 2 (done):** scan results are saved in a database (`data/dashboard.db`),
so `npm run report` shows them instantly without rescanning, and
`npm run pin` marks projects you want to keep.
**Phase 3 (done):** a dashboard in your browser: `npm start`, then open
<http://localhost:7744>. One **Scan now** button, plain-language tags, your
drives (plugged in or not), each project's score explained, and the Done HDD
page with the Library → Archive list for Move 2. See section 4.
**Phase 4 (now):** your Notion **Projects** board: a project marked **Done**
there counts as finished. You link each folder to its Notion page once (the app
suggests, you confirm), and the Status column shows its Notion status. The app
only reads Notion. See section 5.
**Next:** moving projects with Vericopy (Phase 5).

> **Safety promise.** This app only ever *reads* your drives. It never deletes,
> moves, renames, or writes anything on the Working SSD, the Library, or the
> Archive. The only folder it writes to is its own `data/` folder (where the
> database lives). A test
> (`tests/safety.test.js`) fails if code that can change files ever sneaks into
> the app. Moving projects stays your job (with Vericopy) until you ask for
> that feature. The dashboard is read-only too: its "Move to HDD" button is
> greyed out ("Coming in Phase 5"), and nothing scans until you press
> **Scan now**.

---

## 1. What you need

- A Mac with your Working SSD plugged in (plug in the Library too, so the app
  can check how much room it has).
- **Node.js 22.14 or newer.** Check in Terminal:
  ```
  node -v
  ```
  If it prints `v22.14.0` or higher (`v22.14` … `v22.x`, `v24.x`, …), you're
  set. (Node 23 needs `v23.6.0` or higher.) If it says "command not found" or a
  lower number (like `v22.11.0` or `v20.x`), install the **LTS** version from
  <https://nodejs.org>, then run `npm install` again. Phase 2's database library
  needs these versions (older ones crash it, so the app checks first and tells
  you).

## 2. Get the code

Put the app on your Mac's internal drive, **not on any of your media drives**
(the app refuses to run from one). For example:

```
mkdir -p ~/Code && cd ~/Code
git clone https://github.com/sbrignac29/SSD-Dashboard.git
cd SSD-Dashboard
git checkout UI
```

Already cloned it? Inside the folder, run:

```
git fetch
git checkout UI
npm install
```

**`npm install` is required after this update:** the dashboard adds three
packages (see section 3). Without them, `npm start` says so instead of starting.

(Phase 3, the dashboard, is on the `UI` branch. Phase 2 was merged into the main
branch.)

## 3. Set up

```
npm install
cp config.example.json config.json
```

- `npm install` downloads the packages the app depends on into a folder
  called `node_modules`: **better-sqlite3** (talks to the database),
  **express** (the web
  server behind the dashboard), and two libraries the dashboard page uses in
  your browser: **alpinejs** (fills the page with data and makes the buttons
  work) and **chart.js** (draws the size chart). The server hands those two to
  your browser itself, so the dashboard works without internet. better-sqlite3
  includes ready-made versions for Apple Silicon and Intel Macs, so nothing
  needs to be compiled. **@notionhq/client** is Notion's official library for
  reading your Projects board (Phase 4). Run `npm install` again whenever you
  pull an update that changes `package.json`.
- `cp` copies the example settings into **your own** `config.json`. Git ignores
  that file, so your paths and your Notion token never get uploaded.

The example settings already have your three drives. Open `config.json` in a
code editor (like VS Code) if you want to change anything. If you use TextEdit,
first turn off **Edit → Substitutions → Smart Quotes** — JSON needs straight
`"` quotes, not curly `“ ”` ones. If you skip this step, the app uses the
example settings as-is and tells you so.

Made a `config.json` before the three-drive update? The app will say
`"ssdPath" was replaced by the "drives" section` — just copy the example again
(`cp config.example.json config.json`) and redo any edits.

## 4. The dashboard (`npm start`)

```
npm start
```

Then open **<http://localhost:7744>** in Safari or Chrome. Terminal shows:

```
SSD Offload Dashboard is running.
  Open http://localhost:7744 in your browser.
  Nothing is scanned until you press "Scan now".
  Notion: read when you press "Refresh Notion" or "Scan now" (never on its own).
  Settings: config.json · Database: data/dashboard.db
  Press Ctrl+C to stop.
```

Keep that Terminal window open while you use the dashboard; **Ctrl+C** stops
it. Starting it never scans anything: the page shows what the last scan saved
(including scans from `npm run scan`) until you press **Scan now**. (7744 is
the "port", like a door number on your Mac. Vericopy uses 7743, so the
dashboard uses the next one.)

### The Overview page

From top to bottom:

- **Space you could free on the SSD** — the total size of the projects tagged
  *Ready to move to HDD*, how full the SSD would be after moving them, and
  whether they fit on the Library HDD. A yellow box appears when the Library is
  past its 90% limit, with a link to the Done HDD page.
- **Scan now** — the big blue button. It reads the Working SSD and the Library
  HDD (whichever are plugged in) and saves the results. A progress bar shows
  which drive it's on and how many files so far. It never changes anything on
  the drives. "Last scanned" says when the last scan finished.
- **Drives** — one card per drive: a bar of used vs. free space, or **Not
  connected** with when it was last scanned (and how full it was then). The
  Library's bar has a tick at its 90% limit. The Archive shows space only: its
  folders aren't scanned (nothing needs them yet, and 28 TB would make every
  scan slow).
- **Projects on the Working SSD** — every project, with a tag first and the
  score second:

  | Tag | What it means |
  |---|---|
  | ✓ **Ready to move to HDD** | Finished (a final export), untouched for 14+ days, nothing uncertain. Move it to the Library |
  | ! **Check first** | Finished but not safe to move yet (edited recently, newer footage than the final export, …), or old and big with no final export |
  | • **Keep on SSD** | Not finished yet |
  | 📌 **Pinned to SSD** | You pinned it: it stays, whatever the score |

  Under each tag, the main reason ("Edited recently — can be ready Oct 24",
  "Has footage newer than its final export"). These are the same as the
  report's buckets (Ready / Review / Keep), in plain words. **Status** is the
  linked Notion page's status ("—" if the folder isn't linked; see section 5).
  - Click a **column header** to sort by it (again to reverse). The tag column
    sorts Ready first, biggest first, then Check first and Keep by score.
  - **Filters:** the tag buttons (each shows how many projects it has), the
    client (container folders like *NCHS Football*), a *Last edited* date
    range, and **Notion** (*Not linked yet*, *No Notion page*, or one status).
    The filters stay in the address bar, so the Back button keeps them.
  - Click a **project** to open its page.
- **What's using the space** — a chart of the shown projects by file type (raw
  footage, proxies, cache, exports, …). It follows the filters. *Show the
  numbers* lists the same values as a table.

### A project's page

- The tag and score, in big type.
- **What it needs to be ready to move** — the checklist the Ready rule uses, each
  ✓ or ✗ with the details: **Done in Notion** (its linked page's status and End
  date), the final export it found (or why drafts don't count),
  when it was last edited and which file, newer footage, future dates, unreadable
  folders, and pins.
- **How the score adds up** — each part (Done, Age, Size) × its weight = points.
- **Facts from the last scan** (including its Notion page, with **Change →**),
  **Size by file type**, and the **folder tree**:
  its folders, biggest first, three levels deep (click a folder to open it).
- **Pin as Keep** / **Unpin** — the same as `npm run pin` (only the database
  changes). **Move to HDD** is greyed out: *Coming in Phase 5*.

### The Done HDD page

Your Library HDD (the "Done HDD"): its projects, **oldest first**, and how full
it is. When it's past its limit (`libraryFull.startAtPercent`, 90% — what you
called *hddFillLimit*), a yellow banner lists the oldest projects to move to the
Archive HDD, enough to bring it back down to `libraryFull.targetPercent` (70%),
and whether the Archive has room. (Want it to stop just under the limit
instead? Set `targetPercent` to e.g. 85.) If the Library is under the limit but
the projects ready on the SSD would push it past, the banner lists what to move
first to make room. It's a list only: copy them with Vericopy yourself until
Phase 5.

### The Settings page

Change the drive paths, the Done HDD limits, the scoring numbers, the folder
lists and the file types without opening `config.json`.
Section 11 explains how it works.

### When a drive is unplugged

Nothing breaks and nothing turns into an error. The drive's card says **Not
connected** with the date of its last scan, and every page keeps showing what
that scan saved (with a note that it's from then). **Scan now** scans whichever
drives are plugged in and skips the others; with none plugged in, it just says
to plug one in. Plugging a drive back in shows up within 30 seconds (or as soon
as you switch back to the tab).

### Dark mode, and phones

The page follows your Mac's Light/Dark setting. The **Theme** button (top right)
switches between Auto, Light and Dark (remembered in that browser). On a narrow
window or a phone, the table turns into one small card per project.

**Opening it on your phone** (same Wi-Fi): in `config.json` set
`"server": { "host": "0.0.0.0" }`, restart `npm start`, click **Allow** if macOS
asks about incoming connections, and on the phone open
`http://<your Mac's name>.local:7744` (the name is in System Settings → General
→ Sharing, under "Local hostname"). Anyone on that Wi-Fi could then open the
dashboard too and press Scan now or Pin (never move or delete: that code doesn't
exist), so only do this on your home network, and set it back to `"127.0.0.1"`
when you're done.

### How the page and the server talk

The dashboard is two programs. The **server** (`npm start`, `src/server.js`) runs
on your Mac: it's the only part that reads the drives (scans, free space) and the
database. The **page** runs in your browser: it can't see the drives or the
database at all. It asks the server for data at addresses that start with
`/api/`, and the server answers with **JSON** (structured text). Each pair of
"address + what the server does" is a **route**:

| Route | What it answers |
|---|---|
| `GET /api/drives` | Each drive: connected or not, used/free space, last scanned |
| `GET /api/summary` | The headline: space you could free (the Ready projects) |
| `GET /api/projects` | The project list, sorted by score. Filters: `?tag=ready`, `?client=NCHS Football`, `?from=2026-09-01&to=2026-09-30`, `?notion=unlinked`, `?status=Done`, `?drive=library` |
| `GET /api/projects/12` | Project 12: every scoring signal and its biggest folders |
| `POST /api/projects/12/pin` | Pin or unpin project 12 |
| `GET /api/library` | The Done HDD page: Library projects oldest first, and the Archive list |
| `POST /api/scan` | Scan the connected drives now. It answers at once ("started") and keeps scanning |
| `GET /api/scan` | How far the scan is. The page asks twice a second while it runs ("polling") |
| `GET /api/notion` | "Notion: connected / not connected", when it last synced, how many folders are linked |
| `POST /api/notion/sync` | The Refresh Notion button: read the Projects board now |
| `GET /api/notion/links` | The Link to Notion page: folders (`?show=todo`, `linked`, `none`) with their top 3 suggestions, and every Notion page |
| `POST /api/notion/links` | Confirm a link, mark "No Notion page", or undo, for one or more folders (it sends `{"projectIds": [12], "action": "confirm", "pageId": "…"}`) |
| `GET /api/settings` | The Settings page: every setting, its value, and its `config.json` value |
| `POST /api/settings` | Save changed settings (in the database; checked first, nothing saved if anything is wrong) |
| `POST /api/settings/reset` | Forget the Settings page's changes and use `config.json` again |

`GET` means "give me"; `POST` means "do something". You can open the `GET`
ones in your browser to see the raw answers, e.g.
<http://localhost:7744/api/summary>.

### Try it: checking each page

A walkthrough to confirm everything works. Use your real drives; nothing on them
changes.

1. **Update and test:** `git pull`, `npm install`, `npm test` (all `pass`).
2. **Start:** `npm start`, open <http://localhost:7744>. Nothing scans by itself:
   "Last scanned" shows your last `npm run scan`, and the table shows those
   results. (The first start quietly upgrades the database's layout for the
   Library; your pins and history stay.)
3. **Scan:** plug in the Working SSD and the Library HDD and press **Scan now**.
   Watch the progress bar go through the Working SSD, then the Library. When
   it's done the numbers refresh. Check the headline against `npm run report` in
   another Terminal window: its "Buckets" line for Ready shows the same GB.
4. **Overview:** click the *Ready to move to HDD* tag button: only Ready
   projects. Pick a client, then a date range, then **Clear filters**. Click
   *Size* to sort biggest first. Each drive card shows used/free.
5. **A project:** click a Ready project. Every line of the checklist should be
   ✓. Press **Pin as Keep**: the tag becomes *Pinned to SSD*. Go back: the
   headline dropped by that project's size. Open it again and **Unpin**. Open a
   *Check first* project and read which ✗ is holding it back.
6. **Done HDD:** the Library's projects, oldest first. To see the Archive
   banner without filling the drive, set `"libraryFull": { "startAtPercent": 10,
   "targetPercent": 5 }` in `config.json` and refresh the page (no restart
   needed: settings are re-read on every refresh). Then put them back to 90 and 70.
7. **Unplugged:** eject the Working SSD in Finder. Refresh the Overview: its card
   says *Not connected* with the last scan date, and the headline and table are
   still there, with a note that they're from the last scan. Press **Scan now**:
   it scans only the Library. Eject the Library too and refresh **Done HDD**: it
   shows *Not connected* and the last scan's list and space. **Scan now** with
   both unplugged says to plug one in.
8. **Notion:** see section 5 to connect it. Press **Refresh Notion**, link one
   folder on **Link to Notion**, and open that project: its Notion line and
   Status column show the page's status.
9. **Dark mode and phone size:** press **Theme** (Auto → Light → Dark). Make the
   browser window narrow (or Safari: Develop → Enter Responsive Design Mode)
   to see the phone layout.
10. **Stop:** Ctrl+C in Terminal. Start it again: still no scan until you press
   the button.

## 5. Notion: project statuses (Phase 4)

The dashboard can read your Notion **Projects** board, so a project you've
marked **Done** in Notion counts as finished, even without a "Final"/"FD"
export. It only ever **reads** Notion: it never changes a page, a status or
anything else there.

### What's an API, and what's an API token?

An **API** ("application programming interface") is a way for one program to
ask another for things, without a person clicking. Notion's API lives at
`https://api.notion.com`: the dashboard sends it a request ("give me the rows
of this data source") and Notion answers with JSON, the same kind of
structured text the dashboard's own server sends your browser.

Notion has to know who's asking and what they're allowed to see. That's the
**API token**: a long secret string (it starts with `ntn_`) that belongs to an
**integration**, a "robot user" you create in your Notion workspace. Every
request carries the token. Notion then:

- only shows the integration the pages you've **shared with it** (here: just
  the Projects database), and
- only lets it do what you ticked when you made it (here: **Read content**,
  nothing else — so even a bug in this app couldn't change your board).

Treat the token like a password: anyone who has it can read whatever you
shared with the integration. That's why it goes in `config.json`, which git
never uploads, and why a test (`tests/secrets.test.js`) fails if anything that
looks like a Notion token is in a file git would commit.

### Database ID or data source ID?

Since Notion's API version **2025-09-03**, a database is a container, and its
rows live in one or more **data sources** inside it (a database can combine
several). Rows are read from a data source, so the app needs the **data source
ID** (`233517a5-0199-8028-a552-000b7d81cc6b` — already in
`config.example.json`), not the database ID (`233517a5-0199-8055-…`). The
library the app uses, `@notionhq/client` 5, speaks that version, and the app
names it explicitly so a library update can't quietly change the format.

### Step 1: create a read-only integration (once)

Notion moves its menus around now and then; if a label differs a little,
look for the closest match.

1. In your browser, open <https://www.notion.so/profile/integrations> (or in
   Notion: **Settings → Connections → Develop or manage integrations**).
2. Click **New integration**. Name it e.g. `SSD Offload Dashboard`, pick the
   **BrigsMedia** workspace, type **Internal**, and save.
3. Open its **Configuration** (or Capabilities) settings:
   - Content capabilities: tick **Read content** only. **Untick** Update
     content and Insert content.
   - Comment capabilities: untick both.
   - User capabilities: **No user information**.
   - Save.
4. On the same page, next to **Internal Integration Secret**, click **Show**
   and **Copy**. That's your token (`ntn_…`).

### Step 2: share only the Projects database with it

An integration sees nothing until you share pages with it.

1. In Notion, open your **Projects** database (as a full page).
2. Click **•••** (top right) → **Connections** → search for
   `SSD Offload Dashboard` → **Confirm**.
3. That's all: only Projects (and pages inside it) are shared. To check, open
   the integration's **Access** tab on the integrations page: Projects should be
   the only thing listed. Don't share your whole workspace or a parent page.

### Step 3: put the token in `config.json`

Open `config.json` (your copy, never uploaded) and add, or fill in, the
`notion` section:

```json
  "doneStatuses": ["Done"],

  "notion": {
    "token": "ntn_paste_yours_here",
    "dataSourceId": "233517a5-0199-8028-a552-000b7d81cc6b",
    "titleProperty": "Project name",
    "statusProperty": "Status",
    "endDateProperty": "End date"
  },
```

Mind the commas between sections. No restart needed: the dashboard re-reads
`config.json` on every page load. (`config.example.json` keeps `"token": ""`.)

### Step 4: Refresh Notion

On the Overview, under **Scan now**, press **Refresh Notion**. The Notion line
should turn to **● Notion: connected · last synced … · N pages**. If it says
**Notion: not connected**, the message under it says why (wrong token, the
database isn't shared, no internet) and what to do — see Troubleshooting.

When Notion is read:
- **Refresh Notion** (Overview, and the Link to Notion page), and
- **Scan now** (after the drives).

Never on its own: not when the dashboard starts, and never on a schedule.

### Step 5: link your folders (the Link to Notion page)

Notion titles rarely match folder names ("Veterans Video" vs
`Veteran's Day Video`, "Sparrow POS Photos" vs `Sparrow`), so the app never
links anything by itself. It **suggests**, and you confirm. Open **Link to
Notion** in the top bar:

- Each folder that isn't linked yet shows its **top 3 suggested pages**, each
  with a match percentage. A **likely** match (50%+, in green) is picked in
  advance; others aren't.
- Pick a suggestion, or any page from the **Another Notion page…** dropdown,
  and press **Confirm**.
- No page for this folder (a football game, a soccer session)? Press **No
  Notion page**. It won't be suggested again.
- Made a mistake? **Undo** appears after every action. Linked folders are under
  **Linked** (and **No Notion page**), each with **Change** and **Back to "not
  linked yet"**. A project's page also has a **Change →** link.
- Lots of folders without pages? Pick a container in **Folder** (e.g. *In NCHS
  Football*): a button marks all the ones **without a likely match** as "No
  Notion page" in one go. Folders with a likely match (MEDIA DAY) are left for
  you to confirm.

The list puts the best matches first, so you can confirm the easy ones quickly
and then deal with the rest.

**How the suggestions work.** Both names are cleaned the same way: dates
removed (`10-3`, `2026-08-24`), lowercase, apostrophes and punctuation dropped
(`Veteran's` → `veterans`), filler words dropped (`the`, `and`, `vs`), and a
plural "s" removed. Then the app compares the **words**. Words that are the same,
or nearly (`classic`/`classical`, a one-letter typo), count. **Rare words count
more than common ones**: "Sparrow" appears in one name, "Video" in dozens, so
sharing "Sparrow" means much more. (This weighting is called IDF, "inverse
document frequency", a classic search-engine trick.) The percentage mixes how
much of both names the shared words cover with how much of the shorter name
they cover, so the one-word folder `Sparrow` still matches "Sparrow POS
Photos" well. A page already linked to another folder is ranked a bit lower.
Your four examples all come out on top (tested in `tests/notionMatch.test.js`).

Links are saved in the database, so they **survive every rescan**. Renaming a
folder is the exception, as with pins: it looks like a new folder, so link it
again.

### What changes in the score

- **Done = 100** when the linked page's Status is in `doneStatuses` (`["Done"]`
  for your board; any capitalization).
- Otherwise (Not started, In progress, no link, or "No Notion page"), the rule
  is the same as before: **70** for a final export, else **0**.
- A Done project still has to pass the rest of the Ready checklist (untouched
  for 14 days, nothing uncertain, not pinned).

Where you see it:
- **Overview:** the **Status** column shows the Notion status ("—" if not
  linked), and the **Notion** filter shows *Not linked yet*, *No Notion page*,
  or one status.
- **A project's page:** the checklist's **Done in Notion** line (✓ when Done
  — that's why a project with no final export can be Ready), the Done part of
  the score ("Done in Notion ("Veterans Video")"), and under Facts its Notion
  page, status, **End date** as a hint ("Delivered Oct 3, 2026", "Due Oct 20,
  2026") with a link to open it in Notion. The End date isn't part of the score.

### When Notion can't be reached

No internet, a wrong token, Notion down: the dashboard keeps working with the
**last synced statuses** (they're saved in the database) and says so plainly:
**Notion: not connected**, the reason, and "Using the statuses from the last
sync …". Scan now still scans and saves the drives. Press Refresh Notion once
it's fixed.

A page deleted in Notion (or no longer shared) keeps its last status on the
linked project, and the project page says it wasn't in the last sync.

## 6. Run a scan from Terminal

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
| `npm start` | The dashboard in your browser, at <http://localhost:7744> (section 4) |
| `npm run scan` | Scan the Working SSD, save to the database, and print the ranked table, drive space, and move plan |
| `npm run scan:details` | Same, plus per project: size by type, the newest file, the project-file save date, which export counted, and the score math |
| `npm run report` | Print the saved results from the database, **without scanning**. Instant, and works with the SSD unplugged |
| `npm run pin -- "Project name"` | Pin a project as Keep, or unpin it (see section 9) |
| `npm run pin` | List the pinned projects |
| `npm run scan -- --root "/Volumes/BRIGSMEDIA/NCHS Football"` | Scan just one folder of shoots (its subfolders are treated as projects) as a quick preview. Use it on a container like `NCHS Football` or on a whole drive — pointed at a single project folder, it would list that project's Footage/Exports subfolders as if they were separate projects. **Not saved**: it only sees part of the SSD, and saving it would mark everything else as missing. Your config lists and pins still apply, but Size is compared only within that folder, so scores can run higher — decide what to move from a full `npm run scan` |
| `npm run scan -- --root "/Volumes/BRIGSMEDIA LIBRARY"` | Peek at what's on the Library. **Not saved** (its buckets still describe Move 1). The dashboard's Scan now saves the Library properly, for the Done HDD page |
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

**Nothing scans on its own.** The database updates only when you press Scan now
or run `npm run scan`.

## 7. Reading the report

**Projects table** — Ready projects first (biggest first, because moving those
frees the most space), then Review, then Keep (highest score first):

| Column | Meaning |
|---|---|
| Size (GB) | Total size of the project folder, in the same units Finder uses |
| Last edited | Date of the newest file in the project (hidden system files like `.DS_Store` don't count — Finder rewrites those just from browsing) |
| Export | **final** — the project is finished: there's a video export named with **"Final" or "FD"** (e.g. `Soccer 8-24 FD.mp4`, `Promo FINALv2.mov`) or saved in a final-exports folder (`Final Exports/`, `Exports/FD/`). **draft** — there are exports, but none that say final, so it may still be in revisions. **no** — no exports found. See section 8 for the details |
| Score | 0–100: how good a candidate it is (see section 8). Orders Review and Keep |
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

## 8. When is a project Ready?

**Ready = finished + untouched for 14 days + nothing uncertain.**

- **Finished** means a **final export**, inside the project folder:
  - a video export whose name contains the word **"Final" or "FD"** (a short
    version number on the end is fine: `FINALv2`, `FD2`), or
  - a video export saved in a final-exports folder: one whose name says both
    final and export/render (`Final Exports`, `FINAL FINAL RENDERS`), or a
    `Final`/`FD` folder inside `Exports`.
  - "Final Draft" spelled out counts as final too (in case that's what FD
    stands for).
  - For a **photo-only** project (no video footage or video exports at all),
    a photo counts the same way — but it has to be an export, so save it in an
    `Exports` folder: `Girls Golf Banners/Exports/Emma Banner FINAL.png`.

  What does **not** count, so drafts aren't mistaken for finals:
  - words that just repeat the **project's own name** — in
    `NCHS Basketball Regional Final`, `Regional Final Highlights v1.mp4` is a
    draft, while `Highlights FINAL.mp4` or `Regional Final Highlights FD.mp4`
    is final. (In `Soccer Finals Temp`, `Soccer Final v1.mp4` is a draft too.)
  - a game round: "Semi-Final", "Quarter-Final", "Sectional/Regional/State/
    District/Conference/Championship Final" — and "Pre-Final", "Not Final";
  - names with **Draft**, **Drafts**, **Rough** or **WIP**
    (`fileTypes.notFinalWords`), including anything in a `Drafts` folder;
  - long numbers and random IDs that phones put in file names.

  A folder linked to a Notion page whose Status is **Done** is finished too,
  final export or not (section 5).
- **Untouched for 14 days** means no file in the project changed in that time.
- **No newer footage:** if there's a video (or, for photo shoots, a photo)
  more than a day *newer* than the final export — say, Game 2 in a folder where
  Game 1 is finished — the project waits in Review: there may be another shoot
  still to edit. If it's actually a cut-down or re-export (a vertical version
  for social), move it into `Exports` or name it Final/FD, and the project can
  become Ready.
- **Nothing uncertain:** a project isn't Ready if some of its folders couldn't
  be read, or if it has files with future dates (a camera with a wrong clock),
  because then the app can't be sure when you last worked on it.
- A pinned project (with `npm run pin`, or in `folders.keepPinned`) is always
  Keep.

**The score** ranks everything else:

```
Score = 0.45 × Done + 0.35 × Age + 0.20 × Size        (each part 0–100)
```

- **Done:** 100 if the linked Notion page says **Done** (`doneStatuses`), otherwise
  70 if there's a final export, otherwise 0. Folders not linked to Notion use
  the export rule.
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

## 9. Pinning projects (always Keep)

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
- Typo? It lists the projects whose names contain what you typed, so a part
  of the name works for finding it (`npm run pin -- week 1`).
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

## 10. The database: open it yourself

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
   - **Database Structure** tab: the **schema**, i.e. the four tables
     (`projects`, `scans`, `archive_log`, `settings`) and their columns.
     Since the dashboard, `projects` holds the Library's projects too: the
     `drive` column says which drive a row is on (`working` or `library`).
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
WHERE drive = 'working' AND kind = 'project' AND missing = 0
ORDER BY CASE bucket WHEN 'Ready' THEN 0 WHEN 'Review' THEN 1 ELSE 2 END, score DESC;
```

How many projects and GB are in each bucket:

```sql
SELECT bucket, COUNT(*) AS projects, round(SUM(size_bytes) / 1e9, 2) AS gb
FROM projects
WHERE drive = 'working' AND kind = 'project' AND missing = 0
GROUP BY bucket;
```

Projects no longer on the Working SSD (moved to the Library, renamed, or deleted):

```sql
SELECT name, round(size_bytes / 1e9, 2) AS size_gb,
       datetime(last_scanned, 'localtime') AS last_seen, bucket AS last_bucket
FROM projects
WHERE drive = 'working' AND missing = 1;
```

The Library HDD's projects, oldest first (the Done HDD page):

```sql
SELECT name, round(size_bytes / 1e9, 2) AS size_gb,
       datetime(last_modified, 'localtime') AS last_edited
FROM projects
WHERE drive = 'library' AND kind = 'project' AND missing = 0
ORDER BY last_modified;
```

Every scan, newest first, including failed ones:

```sql
SELECT id, drive, datetime(started_at, 'localtime') AS started, status,
       project_count, round(total_bytes / 1e9, 1) AS total_gb, errors
FROM scans
ORDER BY id DESC;
```

### What's in each table

**`projects`**: one row per project folder (and per shared folder) on the
Working SSD, and on the Library HDD, updated by every scan of that drive.

| Column | Meaning |
|---|---|
| `id` | Row number. Never changes |
| `drive` | Which drive the row is on: `working` (the Working SSD) or `library` (the Library HDD) |
| `path` | Where the folder is, from the top of the drive (`NCHS Football/Week 1`). Unique per drive: a rescan updates this row instead of adding another. A project moved to the Library has two rows: its old SSD row (missing) and its Library row |
| `name` | Name as the report shows it (`NCHS Football / Week 1`) |
| `kind` | `project` (ranked) or `shared` (measured, never ranked) |
| `client` | The container for container shoots (`NCHS Football`); empty for others |
| `size_bytes` | Total size |
| `raw_bytes` … `other_bytes` | Size by type: raw, proxy, export, cache, project, other |
| `file_count` | Number of files |
| `last_modified`, `last_modified_file` | Newest real file, and which file |
| `last_nle_save`, `last_nle_save_file` | Last save of a project file (.drp, .prproj, …). NLE = "non-linear editor" (Resolve, Premiere) |
| `has_export`, `export_file` | Whether any export exists (drafts too), and an example file |
| `has_final_export`, `final_export_file` | Whether a video export named "Final"/"FD" exists (the project is finished), and which file |
| `future_dated_files`, `incomplete` | Signs the last-edit date is uncertain (camera clock, unreadable folders), which block Ready |
| `newer_footage_file` | A video or photo more than a day newer than the final export (maybe another shoot still to edit), which blocks Ready |
| `subfolders` | The project's biggest folders (up to 300, three levels deep), as JSON text, for the folder tree on its dashboard page |
| `score`, `bucket`, `score_notes` | The result, and why a finished project isn't Ready yet or that it's pinned. Empty for Library rows (Move 2 just goes oldest first) |
| `pinned_keep` | 1 = you pinned it with `npm run pin`. Scans never change this |
| `first_seen` | The first scan that found it |
| `last_scanned` | The latest scan that found it |
| `missing` | 1 = the latest scan of its drive didn't find it there. The row is kept for history |
| `link_source` | Your Notion decision: `confirmed` (linked), `none` ("No Notion page"), or empty (not decided yet). Scans never change it |
| `notion_page_id` | The linked Notion page (a row in `notion_pages`) |
| `notion_title`, `notion_status`, `notion_end_date`, `notion_synced_at` | That page's title, Status (the score reads this) and End date, as of the last sync |
| `link_decided_at` | When you pressed Confirm or No Notion page |

**`scans`**: one row per scan: `started_at`, `finished_at`, `status`
(`finished` or `failed`), `drive` (`working` or `library`), `root` (the folder
scanned), `project_count`, `file_count`, `total_bytes`, `errors` (the warnings,
or why it failed, as a JSON list), and `drive_total_bytes` / `drive_free_bytes`
(how full the drive was, so the dashboard can show it while it's unplugged).

**`settings`**: one row. `overrides` holds what you saved on the Settings page,
as JSON (e.g. `{"ageDays": {"recent": 21, "max": 120}}`), and `updated_at` when.
`{}` means nothing is changed there: everything comes from `config.json`.

**`notion_pages`**: one row per page on your Notion Projects board, as of the
last sync: `page_id`, `title`, `status`, `end_date`, `url`, `last_edited`,
`first_seen`, `last_synced`, and `in_last_sync` (0 = deleted in Notion, or no
longer shared). Rows are never deleted, so links keep their page.

**`notion_syncs`**: one row per Refresh Notion (or Scan now's sync):
`started_at`, `finished_at`, `status` (`finished` or `failed`), `triggered_by`
(`button` or `scan`), `data_source_id`, `page_count`, and `error` (why it
failed, in plain words).

**`archive_log`**: empty for now. When moving projects arrives (Phase 5) it
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
- **Start over:** stop the dashboard (Ctrl+C), then delete `data/dashboard.db`;
  the next `npm start` or `npm run scan` makes a new one. You lose your pins,
  the scan history, and the "no longer on the Working SSD" list.

## 11. Settings (the Settings page, or `config.json`)

**The easy way:** open the dashboard (`npm start`) and click **Settings** in the
top bar. Each setting has a short explanation and says when it takes effect:
scores and drive limits change as soon as you press **Save**; folder and
file-type changes show at the next **Scan now**. If something doesn't fit (say,
the weights don't add up to 1), nothing is saved and the page tells you what to fix.

How it works, in case you wonder where things go:
- The app never edits `config.json` (it only ever writes inside `data/`). What
  you save on the Settings page is kept in the database, `data/dashboard.db`
  (the `settings` table), and wins over `config.json`.
- Only the values you change there are saved. Everything else keeps following
  `config.json`, so the two can be mixed. A changed setting shows **Changed
  here** and its `config.json` value, with a **Use config.json value** link.
- **Use config.json for everything** (bottom of the page) forgets all the
  page's changes. `config.json` itself is untouched.
- `npm run scan`, `npm run report` and `npm run pin` use the same settings as
  the dashboard (the scan prints e.g. `Settings: config.json + 2 changes from
  the Settings page`).
- `server.port` and `server.host` are only shown there: change them in
  `config.json` and restart `npm start`. If you open the dashboard to your phone
  (`"host": "0.0.0.0"`), the phone can look at the settings but only this Mac
  can change them.
- Deleting `data/dashboard.db` (section 10) also forgets the Settings page's changes.

**In `config.json`:** every setting can also be written there (the app's
defaults are in `config.example.json`):

| Setting | What it does |
|---|---|
| `drives.working` | Your Working SSD (`/Volumes/BRIGSMEDIA`). Run `ls /Volumes` to see drive names |
| `drives.library` | Your Library HDD (`/Volumes/BRIGSMEDIA LIBRARY`) |
| `drives.archive` | Your Archive folder (`/Volumes/Expansion/BRIGSMEDIA ARCHIVE`). Use `""` for a drive you don't have |
| `libraryFull.startAtPercent` | When the Library is this full (90%), it's time to move its oldest projects to the Archive |
| `libraryFull.targetPercent` | How far down to bring the Library when that happens (70% — change it if you prefer) |
| `server.port` | The dashboard's address: `http://localhost:7744`. Any number from 1024 to 65535 except 7743 (Vericopy's) |
| `server.host` | `"127.0.0.1"`: only this Mac can open the dashboard (recommended). `"0.0.0.0"`: your phone on the same Wi-Fi too (section 4) |
| `ageDays.recent` / `ageDays.max` | The 14-day "still being worked on" window and the 120-day "fully old" point |
| `weights` | The 0.45 / 0.35 / 0.20 mix. Must add up to 1 |
| `buckets.review` | Unfinished projects scoring this or more (40) are Review instead of Keep |
| `doneStatuses` | Notion statuses that mean finished (`["Done"]` for your board). List several if you ever add one, e.g. `["Done", "Delivered"]` |
| `notion.token` | Your Notion integration's secret (`ntn_…`). `""` = no Notion. Only ever in `config.json` (section 5) |
| `notion.dataSourceId` | Your Projects board's **data source** ID (a copied Notion link works too) |
| `notion.titleProperty` / `statusProperty` / `endDateProperty` | The names of the board's columns: `Project name`, `Status`, `End date`. Change them if you rename those columns in Notion (`endDateProperty` can be `""`) |
| `folders.ignore` | Top-level folders to skip completely |
| `folders.shared` | Folders used across projects: measured, never ranked |
| `folders.containers` | Folders that hold many shoots (like `NCHS Football`). Each subfolder becomes its own project |
| `folders.keepPinned` | Projects that must always stay (bucket = Keep). Pinning a container (e.g. `"NCHS Football"`) keeps every shoot inside it. For single projects, `npm run pin` is easier (section 9) |
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

The dashboard re-reads `config.json` every time a page loads, so most changes
show up when you refresh (scores after the next Scan now). `server.port` and
`server.host` need a restart of `npm start`. Remember that a value saved on the
Settings page wins over `config.json`: if an edit there seems to do nothing, the
Settings page shows that setting as **Changed here**.

## 12. Checking the numbers against Finder

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

## 13. Naming exports and where to save things

You **don't need to rename project folders** — folder names don't change scores.
What matters:

1. **Name the finished export with "FD" or "Final"** — e.g.
   `Soccer 8-24 FD.mp4` — or save it in a `Final Exports` folder. That's how the
   app knows a project is done. Leave drafts and revision cuts without it
   (`Soccer 8-24 v3.mp4`), or call them "Draft". For a playoff project like
   `Regional Final`, the export still needs its own FD/Final
   (`Highlights FINAL.mp4`): the "Final" in the game's name doesn't count.
   Save cut-downs and social versions in `Exports` too, so they aren't mistaken
   for new footage.
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

## 14. Run the tests

```
npm test
```

Tests are small programs that run the app's code with known inputs and check
the answers — including the scoring rules, the file sorting rules, the move
plan, a scan of a fake drive, the database (scanning twice creates no
duplicates, missing projects are kept, a pinned project is never Ready, Library
scans are kept apart, older databases upgrade without losing anything), the
the Settings page, the dashboard server (each route, Scan now's progress, unplugged
drives, the localhost guards), Notion (your four real folder/page examples
come out as top suggestions, a confirmed link survives rescans, a "No Notion
page" folder isn't suggested, Notion being offline keeps the last statuses),
and the safety checks: nothing in the app can change files, the only Notion
calls are the two read calls, and no Notion token is in any file git would
commit. All should say `pass`.

Notion tests use a **fake** Notion (`tests/fakeNotion.js`) that answers like
the real one, so they never touch your real board or need internet.

The database tests use their own throwaway database inside `data/`; they never
touch your real `data/dashboard.db`.

## 15. Troubleshooting

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
- **"The database library couldn't load"** — delete the `node_modules` folder
  in the app folder and run `npm install`.
- **"Your Node.js … is too old for the database library"** (or "Segmentation
  fault") — install the current LTS from <https://nodejs.org> (22.14 or
  newer; on Node 23, 23.6 or newer), then run `npm install` again.
- **"The database is busy"** — another program is changing
  `data/dashboard.db`, usually DB Browser with unsaved edits. Click **Write
  Changes** or **Revert Changes** (or close it) and try again. Open it with
  **Open Database Read Only** to avoid this.
- **"No saved results yet"** — run `npm run scan` once; `npm run report` and
  `npm run pin` read what it saves.
- **"No project called … in the database"** (pin) — use the name the report
  shows, in quotes. Names come from the last scan, so rescan after renaming.
- **Odd syntax errors, or npm warnings about "engine"** — check `node -v` is
  22.14 or newer (on Node 23, 23.6 or newer).
- **"The dashboard's packages aren't installed yet"** — run `npm install`
  (needed once after pulling the dashboard update), then `npm start`.
- **"Port 7744 is already in use"** — the dashboard is already running in another
  Terminal window (use that one, or Ctrl+C it), or set a different
  `server.port` in `config.json`.
- **The page says "Can't reach the dashboard"** — the `npm start` window was
  closed or stopped. Run `npm start` again and refresh.
- **A blank page** — refresh once. If it stays blank, check the `npm start`
  window for a message, and that you opened `http://localhost:7744` (not the
  `index.html` file directly: the page needs the server).
- **"The database file was moved or deleted while the dashboard was running"** —
  Ctrl+C the dashboard and `npm start` again.
- **A drive shows "Not connected" but it's plugged in** — check its name with
  `ls /Volumes` against `drives` in `config.json`, then refresh the page.

- **"Notion: not connected — No Notion token in config.json yet"** — follow
  section 5 to make one and paste it as `notion.token`.
- **"Notion didn't accept the token"** — copy the secret again from the
  integration's page (Show → Copy), paste it between the quotes, and press
  Refresh Notion. If you regenerated it in Notion, the old one stops working.
- **"Notion can't find the Projects data source"** — the database isn't shared
  with the integration (Projects → ••• → Connections → add it), or
  `notion.dataSourceId` is the database ID. In Notion: open Projects → ••• →
  **Manage data sources** → ••• next to the data source → **Copy data source ID**.
- **"Your integration isn't allowed to read the Projects database"** — in the
  integration's settings, tick **Read content**.
- **"Your Notion database doesn't look as expected: there's no "Status"
  column"** — a column was renamed in Notion. The message lists the columns it
  found; put the right names under `notion` in `config.json`.
- **"Can't reach Notion"** — no internet (or Notion is down). Everything else
  works with the last synced statuses; press Refresh Notion later.
- **A folder isn't suggested the page you expect** — pick it from the
  **Another Notion page…** dropdown. Suggestions only help; the dropdown has
  every page.

## Known limitations

- **DaVinci Resolve project library.** Your Resolve projects live in the shared
  `Resolve Project Library`, not in each project folder. If you edit a project
  in Resolve without rendering or adding files, that project folder's dates
  don't change, so it can look untouched when it isn't. Check before moving
  anything Resolve-based. (A later phase can read the library's per-project
  save dates.)
- **Exports and project files saved outside the project folder** aren't linked
  to their project. See section 13.
- **A final-looking name isn't proof.** The app ignores "Final" that comes from
  the project's own name, but a draft named, say, `State Final Recap v1.mp4` in
  a project called `NCHS Basketball` would still look final. That's why the
  report lists the file behind every Ready project — check it before moving.
- **Copied footage keeps its original dates.** Finder keeps a file's modified
  date when copying, so footage copied from an old card looks old until you
  start editing (your project file and renders will then be newer).
- **The Archive's folders aren't scanned.** The dashboard knows how full it is,
  not what's on it.
- **Renaming a project folder** makes it look like a new project: the old name
  is marked missing and the new name starts fresh (pin it again if it was
  pinned, and link it to Notion again).
- **Notion links are per folder on the Working SSD.** A project moved to the
  Library has its own Library row, which isn't linked (Library projects aren't
  scored, so it doesn't matter yet).
- **Notion statuses are as of the last sync.** Changing a status in Notion shows
  up after Refresh Notion or Scan now, not by itself.
- **One Working SSD per database.** Projects are tracked by their path from the
  top of the drive. If you point `drives.working` at a different drive, the
  first drive's projects show as no longer on the SSD.
- **Settings changes apply at the next scan.** `npm run report` and the
  dashboard show the scores saved by the last scan (a project's page says when
  your settings would change its score), so after editing `config.json` (weights,
  pins, shared folders…) run `npm run scan` to see the effect. (Running
  `npm run pin` also re-scores every project with your current weights, day
  counts and pins; folder and file-type settings need a scan.)

## Project layout

```
config.example.json      default settings (copy to config.json)
src/config.js            loads settings, runs safety checks
src/settings.js          the Settings page: what it can change, checking values, config.json + saved changes
src/cli/scan.js          the `npm run scan` command
src/cli/report.js        the `npm run report` command
src/cli/pin.js           the `npm run pin` command
src/cli/format.js        formats the printed reports
src/server.js            the dashboard server (`npm start`): web addresses ("routes") and safety guards
src/web/views.js         builds each answer the dashboard asks for (reads the database only)
src/web/scanRunner.js    the Scan now button: one scan at a time, with progress
src/db.js                the database: tables, saving scans, pins, saved settings (writes only in data/)
src/jobs/scanAndSave.js  one full scan + save (used by `npm run scan` and Scan now)
src/scanner/scan.js      walks a drive (read-only) and collects facts
src/scanner/classify.js  decides raw / proxy / export / cache / project / other, and final exports
src/scanner/parseName.js pulls dates out of folder names ("Soccer 8-24")
src/scanner/space.js     how full each drive is (read-only)
src/scoring/score.js     the scoring formula and the Ready/Review/Keep rule
src/scoring/plan.js      the move plan: will it fit, is the Library full, what to move to the Archive
src/notion/sync.js       reads your Notion Projects board (read-only) and saves what it says
src/notion/match.js      suggests which Notion page belongs to which folder
src/offload/             Phase 5 (a stub)
public/                  the dashboard pages: index.html (Overview), project.html, library.html (Done HDD),
                         notion.html (Link to Notion),
                         settings.html (Settings),
                         styles.css, and js/ (the code that runs in your browser)
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
- **Server** — a program that waits for requests and answers them. `npm start`
  runs the dashboard's server on your Mac.
- **Route** — a web address the server answers, like `GET /api/projects`,
  paired with the function that builds the answer. `GET` asks for something,
  `POST` asks the server to do something.
- **API** — the set of routes a program offers to other programs. The dashboard
  page uses the server's API (everything under `/api/`).
- **JSON** — a text format for data (`{"name": "Soccer 8-24", "sizeBytes": 251000000000}`).
  The server answers in JSON; the page turns it back into data.
- **localhost / port** — `localhost` means "this Mac". The port (7744) picks
  which program on the Mac answers, like a door number.
- **Express** — the library the server uses to answer web requests.
- **Alpine.js** — a small library that fills the page with data and makes its
  buttons work, written right in the HTML (`x-text="..."`, `@click="..."`).
- **Polling** — asking again and again ("is the scan done yet?"), here twice a
  second while a scan runs.
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
- **API token** — a secret string that proves a program is allowed to use an
  API, like a password for programs. Your Notion token belongs to the
  integration you made, and can only read what you shared with it.
- **Integration** — a "robot user" in your Notion workspace that programs act
  as. It sees only the pages you share with it (••• → Connections).
- **Data source** — the table of rows inside a Notion database (since Notion's
  API version 2025-09-03). The app reads rows from your Projects data source.
- **Pagination** — getting a long list in pieces: Notion sends 100 rows at a
  time, plus a "cursor" saying where the next 100 start.
- **Fuzzy matching** — comparing names that are similar but not identical. The
  Link to Notion page uses it to suggest pages (section 5).

## Roadmap

1. ✅ Scanner, file classifier, scoring, `npm run scan`, three-drive config, drive space and move plan
2. ✅ Database (SQLite), `npm run report`, `npm run pin`
3. ✅ Dashboard (`npm start`): Overview, project pages, the Done HDD page with the
   Library → Archive list (Move 2); Library scans saved
4. ✅ Notion: read your Projects board, link folders to pages (suggested, you confirm),
   Done in Notion counts as finished, Status column, Refresh Notion
5. Moving projects through Vericopy + a log of where each project went (only when you ask for it)
