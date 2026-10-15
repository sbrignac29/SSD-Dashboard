'use strict';

// Tests for Phase 4: reading Notion (src/notion/sync.js), saving links and
// statuses (src/db.js), and what the dashboard shows (src/web/views.js).
//
// Notion is always the fake from tests/fakeNotion.js — never the real API.
// Like the other tests, the fake SSD and the test databases live in data/.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, withDefaults, isInside } = require('../src/config');
const { openDatabase, setNotionLinks, listProjects, latestNotionSync, MIGRATIONS } = require('../src/db');
const { scanAndSave } = require('../src/jobs/scanAndSave');
const { syncNotion, createNotionSyncer, readPage, describeNotionError } = require('../src/notion/sync');
const views = require('../src/web/views');
const { fakeNotion, notionPage, offlineError, unauthorizedError, ownersBoard } = require('./fakeNotion');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let base;
let ssd;
let db;
let dbCount = 0;

function file(rel, size, ageDays) {
  const abs = path.join(ssd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(size));
  const time = new Date(NOW - ageDays * DAY);
  fs.utimesSync(abs, time, time);
}

function snapshot(dir) {
  const result = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const stats = fs.lstatSync(abs);
      result[path.relative(dir, abs)] = { size: stats.size, mtimeMs: stats.mtimeMs };
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(dir);
  return result;
}

function testConfig({ token = 'test-token', notion = {} } = {}) {
  return withDefaults({
    drives: { working: ssd, library: '', archive: '' },
    folders: { ignore: [], shared: ['Resolve Project Library'], containers: ['NCHS Football'], keepPinned: [] },
    notion: { token, ...notion },
  });
}

// Each scan a second after the last: a scan marks missing what it didn't see
// at ITS start time, so two scans must never share one.
let scanCount = 0;
const scan = (config = testConfig()) => {
  scanCount += 1;
  return scanAndSave({ config, db, now: NOW + scanCount * 1000 });
};
const project = (relPath) => listProjects(db).find((p) => p.relPath === relPath);
const linksView = (query = {}, config = testConfig()) => views.notionLinksView({ db, config, query });
const detail = (relPath, config = testConfig()) => views.projectDetailView({ db, config, id: project(relPath).id });
const quiet = { error() {} };

before(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  base = fs.mkdtempSync(path.join(DATA_DIR, '.test-notion-'));
  ssd = path.join(base, 'ssd');
  // No exports at all, untouched for 60 days: only Notion can make it finished.
  file("Veteran's Day Video/Footage/a.mov", 4000, 60);
  // A final export (Done = 70), untouched for 40 days.
  file('Sparrow/Photos/IMG_0001.jpg', 1000, 40);
  file('Sparrow/Exports/Sparrow FINAL.mp4', 500, 40);
  file('Covenant Classical Update Content/b.mov', 2000, 30);
  file('NCHS Football/MEDIA DAY/c.mov', 3000, 50);
  file('NCHS Football/Week 1 vs Naperville North/d.mov', 3000, 45);
  file('NCHS Football/Week 2 vs Neuqua Valley/e.mov', 3000, 38);
  file('Resolve Project Library/Projects/x.db', 10, 1);
});

after(() => {
  if (base && isInside(base, DATA_DIR) && base !== DATA_DIR) fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  dbCount += 1;
  db = openDatabase({ file: path.join(base, `notion-${dbCount}.db`) });
});
afterEach(() => db.close());

describe('reading Notion', () => {
  it('reads every page (100 at a time), using only the two read calls', async () => {
    await scan();
    const { client, board } = fakeNotion({ pages: ownersBoard() });
    const result = await syncNotion({ db, config: testConfig(), client });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.pageCount, 10);
    assert.deepEqual([...new Set(board.calls.map((c) => c.name))].sort(), ['dataSources.query', 'dataSources.retrieve']);
    // The fake answers 2 rows at a time, so it took 5 queries, each starting where the last ended.
    const queries = board.calls.filter((c) => c.name === 'dataSources.query');
    assert.equal(queries.length, 5);
    assert.deepEqual(
      queries.map((q) => q.args.start_cursor),
      [undefined, '2', '4', '6', '8'],
    );
    assert.ok(queries.every((q) => q.args.data_source_id === '233517a5-0199-8028-a552-000b7d81cc6b'));

    const status = views.notionView({ db, config: testConfig() });
    assert.equal(status.headline, 'Notion: connected');
    assert.equal(status.pageCount, 10);
    assert.equal(status.counts.todo, 6, 'nothing is linked automatically');
  });

  it('the fake refuses any call that would change Notion (so the test above means something)', async () => {
    const { client, board } = fakeNotion();
    assert.throws(() => client.pages.update({ page_id: 'x' }), /may only read Notion/);
    assert.throws(() => client.dataSources.update({}), /may only read Notion/);
    assert.deepEqual(
      board.calls.map((c) => c.name),
      ['pages.update', 'dataSources.update'],
    );
  });

  it('reads title, Status (status or select columns), End date and the page address', () => {
    const settings = { titleProperty: 'Project name', statusProperty: 'Status', endDateProperty: 'End date' };
    assert.deepEqual(readPage(notionPage('p1', ' Veterans Video ', 'Done', '2026-10-03'), settings), {
      pageId: 'p1',
      title: 'Veterans Video',
      status: 'Done',
      endDate: '2026-10-03',
      url: 'https://www.notion.so/p1',
      lastEdited: '2026-10-01T15:00:00.000Z',
    });
    const asSelect = notionPage('p2', 'X');
    asSelect.properties.Status = { type: 'select', select: { name: 'In progress' } };
    assert.equal(readPage(asSelect, settings).status, 'In progress');
    const range = notionPage('p3', 'Y');
    range.properties['End date'].date = { start: '2026-10-01', end: '2026-10-05' };
    assert.equal(readPage(range, settings).endDate, '2026-10-05');
    assert.equal(readPage(notionPage('p4', 'Z'), settings).status, null);
  });

  it('a renamed Notion column gives a clear message naming the columns there are', async () => {
    const { client } = fakeNotion({ pages: ownersBoard() });
    const config = testConfig({ notion: { statusProperty: 'Stage' } });
    const result = await syncNotion({ db, config, client });
    assert.equal(result.ok, false);
    assert.match(result.message, /no "Stage" column.*Project name, Status, End date, Priority, Assignee/);
  });

  it('without a token nothing is read or recorded, and the dashboard says "Notion: not connected"', async () => {
    await scan(testConfig({ token: '' }));
    const { client, board } = fakeNotion({ pages: ownersBoard() });
    const result = await syncNotion({ db, config: testConfig({ token: '' }), client });
    assert.deepEqual([result.ok, result.reason], [false, 'not-configured']);
    assert.equal(board.calls.length, 0);
    assert.equal(latestNotionSync(db), undefined);
    const status = views.notionView({ db, config: testConfig({ token: '' }) });
    assert.deepEqual([status.state, status.headline], ['no-token', 'Notion: not connected']);
    assert.match(status.detail, /No Notion token in config\.json/);
  });

  it('turns Notion errors into plain words (and never shows the token)', () => {
    assert.match(describeNotionError(unauthorizedError()), /didn't accept the token/);
    assert.match(describeNotionError(Object.assign(new Error('x'), { code: 'object_not_found' })), /Connections/);
    assert.match(describeNotionError(offlineError()), /Can't reach Notion/);
    assert.equal(describeNotionError(new Error('a bug')), null);
  });

  it('a second press while a sync runs joins it instead of starting another', async () => {
    const { client, board } = fakeNotion({ pages: ownersBoard() });
    const syncer = createNotionSyncer({ db, getConfig: () => testConfig(), makeClient: () => client, log: quiet });
    const [a, b] = [syncer.sync(), syncer.sync()];
    assert.equal(a, b);
    assert.equal(syncer.isRunning(), true);
    await a;
    assert.equal(syncer.isRunning(), false);
    assert.equal(board.calls.filter((c) => c.name === 'dataSources.retrieve').length, 1);
  });
});

describe('links and scoring', () => {
  async function scanAndSync(pages = ownersBoard()) {
    await scan();
    const notion = fakeNotion({ pages });
    const result = await syncNotion({ db, config: testConfig(), client: notion.client });
    assert.equal(result.ok, true, result.message);
    return notion;
  }

  function confirm(relPath, pageId) {
    const outcome = setNotionLinks(db, testConfig(), { projectIds: [project(relPath).id], action: 'confirm', pageId });
    assert.equal(outcome.result, 'ok', outcome.problem);
    return outcome;
  }

  it('Done in Notion makes a folder with no exports finished (Done = 100) and Ready', async () => {
    await scanAndSync();
    const before = project("Veteran's Day Video");
    assert.notEqual(before.scoring.bucket, 'Ready', 'no final export, not linked: not finished');

    confirm("Veteran's Day Video", 'page-veterans');
    const after = project("Veteran's Day Video");
    assert.equal(after.notionStatus, 'Done');
    assert.equal(after.scoring.bucket, 'Ready');

    const page = detail("Veteran's Day Video");
    assert.equal(page.project.status, 'Done');
    assert.equal(page.scoring.parts.find((p) => p.id === 'done').value, 100);
    assert.match(page.scoring.parts.find((p) => p.id === 'done').why, /Done in Notion \("Veterans Video"\)/);
    const checks = Object.fromEntries(page.scoring.checks.map((c) => [c.id, c]));
    assert.equal(checks.finished.state, 'pass');
    assert.equal(checks.notion.state, 'pass');
    assert.match(checks.notion.detail, /"Veterans Video" is "Done" · Delivered Oct 3, 2026/);
    assert.equal(page.notion.endHint, 'Delivered Oct 3, 2026', 'the End date is read as a plain day (not UTC)');
    assert.equal(page.notion.url, 'https://www.notion.so/page-veterans');
    assert.equal(page.scoring.reason.startsWith('Done in Notion · untouched'), true);
  });

  it('a page that is not Done falls back to the export rule', async () => {
    await scanAndSync();
    confirm('Sparrow', 'page-sparrow'); // In progress, but Sparrow has a final export
    const page = detail('Sparrow');
    assert.equal(page.scoring.parts.find((p) => p.id === 'done').value, 70);
    assert.equal(page.scoring.checks.find((c) => c.id === 'notion').state, 'info');
    assert.equal(project('Sparrow').scoring.bucket, 'Ready', 'the final export still makes it finished');
  });

  it('a folder with no link keeps the current rule: final export = 70, else 0', async () => {
    await scanAndSync();
    assert.equal(detail('Sparrow').scoring.parts.find((p) => p.id === 'done').value, 70);
    assert.equal(detail("Veteran's Day Video").scoring.parts.find((p) => p.id === 'done').value, 0);
    setNotionLinks(db, testConfig(), { projectIds: [project('Sparrow').id], action: 'none' });
    assert.equal(detail('Sparrow').scoring.parts.find((p) => p.id === 'done').value, 70);
  });

  it('a confirmed link survives rescans (and a folder that leaves and comes back)', async () => {
    await scanAndSync();
    confirm("Veteran's Day Video", 'page-veterans');
    await scan();
    await scan();
    let p = project("Veteran's Day Video");
    assert.deepEqual([p.notionLink, p.notionPageId, p.notionStatus, p.scoring.bucket], ['confirmed', 'page-veterans', 'Done', 'Ready']);

    // Unplugged mid-shuffle: the folder is missing from one scan, then back.
    const moved = path.join(base, 'parked');
    fs.renameSync(path.join(ssd, "Veteran's Day Video"), moved);
    try {
      await scan();
      assert.equal(project("Veteran's Day Video").missing, true);
    } finally {
      fs.renameSync(moved, path.join(ssd, "Veteran's Day Video"));
    }
    await scan();
    p = project("Veteran's Day Video");
    assert.deepEqual([p.missing, p.notionLink, p.notionStatus, p.scoring.bucket], [false, 'confirmed', 'Done', 'Ready']);
  });

  it('a "No Notion page" folder is never suggested again, and stays that way after a rescan', async () => {
    await scanAndSync();
    const week1 = project('NCHS Football/Week 1 vs Naperville North');
    assert.ok(linksView().rows.some((r) => r.id === week1.id), 'on the to-do list at first');

    setNotionLinks(db, testConfig(), { projectIds: [week1.id], action: 'none' });
    await scan();
    const todo = linksView();
    assert.ok(!todo.rows.some((r) => r.id === week1.id), 'gone from the to-do list');
    assert.equal(todo.counts.none, 1);
    assert.deepEqual(
      linksView({ show: 'none' }).rows.map((r) => r.id),
      [week1.id],
    );
    assert.equal(project('NCHS Football/Week 1 vs Naperville North').notionLink, 'none');

    // Undo puts it back.
    setNotionLinks(db, testConfig(), { projectIds: [week1.id], action: 'clear' });
    assert.ok(linksView().rows.some((r) => r.id === week1.id));
  });

  it('the to-do list suggests the real matches first, and nothing is linked until Confirm', async () => {
    await scanAndSync();
    const view = linksView();
    const top = (relPath) => view.rows.find((r) => r.relPath === relPath).suggestions[0]?.title;
    assert.equal(top("Veteran's Day Video"), 'Veterans Video');
    assert.equal(top('Sparrow'), 'Sparrow POS Photos');
    assert.equal(top('Covenant Classical Update Content'), 'Covenant Classical Video Update');
    assert.equal(top('NCHS Football/MEDIA DAY'), 'NCHS Media Day Processing');
    assert.equal(view.pages.length, 10, 'every page is in the dropdown');
    assert.ok(listProjects(db).every((p) => p.notionLink === null), 'suggesting links nothing');
    // Best suggestion first: the four real matches lead the list.
    assert.deepEqual(
      new Set(view.rows.slice(0, 4).map((r) => r.relPath)),
      new Set(["Veteran's Day Video", 'Sparrow', 'Covenant Classical Update Content', 'NCHS Football/MEDIA DAY']),
    );
  });

  it('Mark all: one container\'s folders can be marked "No Notion page" in one go', async () => {
    await scanAndSync();
    confirm('NCHS Football/MEDIA DAY', 'page-media-day');
    const rows = linksView({ client: 'NCHS Football' }).rows;
    assert.deepEqual(
      rows.map((r) => r.relPath).sort(),
      ['NCHS Football/Week 1 vs Naperville North', 'NCHS Football/Week 2 vs Neuqua Valley'],
    );
    const outcome = setNotionLinks(db, testConfig(), { projectIds: rows.map((r) => r.id), action: 'none' });
    assert.equal(outcome.result, 'ok');
    assert.deepEqual(linksView({ client: 'NCHS Football' }).counts, { todo: 0, linked: 1, none: 2 });
  });

  it('refuses links it can\'t make, and changes nothing', async () => {
    await scanAndSync();
    const id = project('Sparrow').id;
    const shared = project('Resolve Project Library').id;
    const config = testConfig();
    assert.equal(setNotionLinks(db, config, { projectIds: [id], action: 'confirm', pageId: 'no-such-page' }).result, 'unknown-page');
    assert.equal(setNotionLinks(db, config, { projectIds: [shared], action: 'none' }).result, 'not-on-working');
    assert.equal(setNotionLinks(db, config, { projectIds: [99999], action: 'none' }).result, 'not-found');
    assert.equal(setNotionLinks(db, config, { projectIds: [id], action: 'delete' }).result, 'bad-request');
    assert.equal(setNotionLinks(db, config, { projectIds: ['1'], action: 'none' }).result, 'bad-request');
    assert.equal(project('Sparrow').notionLink, null);
  });

  it('the next sync updates linked statuses (Done -> In progress takes it out of Ready)', async () => {
    const notion = await scanAndSync();
    confirm("Veteran's Day Video", 'page-veterans');
    assert.equal(project("Veteran's Day Video").scoring.bucket, 'Ready');

    notion.board.pages = ownersBoard().map((page) =>
      page.id === 'page-veterans' ? notionPage('page-veterans', 'Veterans Video (re-edit)', 'In progress') : page,
    );
    const result = await syncNotion({ db, config: testConfig(), client: notion.client });
    assert.equal(result.ok, true);
    const p = project("Veteran's Day Video");
    assert.deepEqual([p.notionStatus, p.notionTitle], ['In progress', 'Veterans Video (re-edit)']);
    assert.notEqual(p.scoring.bucket, 'Ready');
  });

  it('Notion unreachable: the last synced statuses stay in use, and it says "not connected" plainly', async () => {
    const notion = await scanAndSync();
    confirm("Veteran's Day Video", 'page-veterans');

    notion.board.fail = offlineError();
    const result = await syncNotion({ db, config: testConfig(), client: notion.client });
    assert.equal(result.ok, false);
    assert.match(result.message, /^Notion: not connected\. Can't reach Notion/);
    assert.equal(latestNotionSync(db).status, 'failed');

    const p = project("Veteran's Day Video");
    assert.deepEqual([p.notionStatus, p.scoring.bucket], ['Done', 'Ready'], 'nothing changed');
    const status = views.notionView({ db, config: testConfig() });
    assert.deepEqual([status.state, status.headline, status.usingSavedStatuses], ['failed', 'Notion: not connected', true]);
    assert.match(status.detail, /Can't reach Notion/);

    // A wrong token is "not connected" too, with what to do about it.
    notion.board.fail = unauthorizedError();
    const rejected = await syncNotion({ db, config: testConfig(), client: notion.client });
    assert.match(rejected.message, /didn't accept the token/);
    assert.equal(project("Veteran's Day Video").notionStatus, 'Done');
  });

  it('a page deleted in Notion keeps its last status on the project, which says so', async () => {
    const notion = await scanAndSync();
    confirm("Veteran's Day Video", 'page-veterans');
    // Deleted in Notion, while a new page was added: still counted as 1 gone.
    notion.board.pages = [...ownersBoard().filter((page) => page.id !== 'page-veterans'), notionPage('page-new', 'Brand New', 'Not started')];
    const result = await syncNotion({ db, config: testConfig(), client: notion.client });
    assert.match(result.message, /1 page\(s\) from before weren't there/);
    assert.equal(project("Veteran's Day Video").notionStatus, 'Done');
    assert.equal(detail("Veteran's Day Video").notion.pageGone, true);
    assert.ok(!linksView().pages.some((p) => p.pageId === 'page-veterans'), 'not offered in the dropdown any more');
  });

  it('the Overview can show only the folders not linked yet, and fills the Status column', async () => {
    await scanAndSync();
    confirm("Veteran's Day Video", 'page-veterans');
    setNotionLinks(db, testConfig(), { projectIds: [project('Sparrow').id], action: 'none' });
    const all = views.projectsView({ db, config: testConfig() });
    const row = (relPath) => all.projects.find((p) => p.relPath === relPath);
    assert.equal(row("Veteran's Day Video").status, 'Done');
    assert.equal(row('Sparrow').status, null);
    assert.deepEqual(all.notionCounts, { unlinked: 4, 'no-page': 1, linked: 1 });
    assert.deepEqual(all.statuses, ['Done']);

    const unlinked = views.projectsView({ db, config: testConfig(), query: { notion: 'unlinked' } });
    assert.equal(unlinked.projects.length, 4);
    assert.ok(unlinked.projects.every((p) => p.notionLink === null));
    const done = views.projectsView({ db, config: testConfig(), query: { status: 'done' } });
    assert.deepEqual(
      done.projects.map((p) => p.relPath),
      ["Veteran's Day Video"],
    );
    assert.throws(() => views.projectsView({ db, config: testConfig(), query: { notion: 'maybe' } }), /"notion" must be one of/);
  });

  it('syncing and linking never change anything on the drive', async () => {
    const before = snapshot(ssd);
    await scanAndSync();
    confirm("Veteran's Day Video", 'page-veterans');
    setNotionLinks(db, testConfig(), { projectIds: [project('Sparrow').id], action: 'none' });
    assert.deepEqual(snapshot(ssd), before);
  });
});

describe('the End date hint', () => {
  it('says Delivered for done pages, Due for future dates, and flags passed ones', () => {
    const now = new Date(2026, 9, 15, 12).getTime(); // Oct 15, 2026, local time
    assert.equal(views.endDateHint('Done', '2026-10-03', ['Done'], now), 'Delivered Oct 3, 2026');
    assert.equal(views.endDateHint('In progress', '2026-10-20', ['Done'], now), 'Due Oct 20, 2026');
    assert.equal(views.endDateHint('In progress', '2026-10-15', ['Done'], now), 'Due Oct 15, 2026', 'today is still due');
    assert.equal(
      views.endDateHint('In progress', '2026-10-01', ['Done'], now),
      'End date Oct 1, 2026 has passed (still In progress in Notion)',
    );
    assert.equal(views.endDateHint('Done', null, ['Done'], now), null);
  });
});

describe('upgrading the database for Phase 4', () => {
  it('a version-3 database (Phase 3) gets the Notion tables and columns, keeping every row', () => {
    const fileName = path.join(base, 'from-version-3.db');
    const Database = require('better-sqlite3');
    const old = new Database(fileName);
    for (const step of MIGRATIONS.slice(0, 3)) old.exec(step);
    old.pragma('user_version = 3');
    old
      .prepare(
        `INSERT INTO projects (id, drive, path, name, kind, size_bytes, raw_bytes, proxy_bytes, export_bytes, cache_bytes,
           project_bytes, other_bytes, file_count, has_export, has_final_export, first_seen, last_scanned, pinned_keep)
         VALUES (5, 'working', 'Sparrow', 'Sparrow', 'project', 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, ?, ?, 1)`,
      )
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    old.close();

    db.close();
    db = openDatabase({ file: fileName });
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const row = db.prepare('SELECT * FROM projects WHERE id = 5').get();
    assert.deepEqual([row.pinned_keep, row.link_source, row.notion_page_id, row.notion_status], [1, null, null, null]);
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM notion_pages').get(), { n: 0 });
    // The rules hold: a "confirmed" link needs a real synced page.
    assert.throws(() => db.prepare("UPDATE projects SET link_source = 'confirmed' WHERE id = 5").run(), /CHECK constraint/);
    assert.throws(
      () => db.prepare("UPDATE projects SET link_source = 'confirmed', notion_page_id = 'nope' WHERE id = 5").run(),
      /FOREIGN KEY/,
    );
  });
});
