'use strict';

// A fake Notion client for the tests: answers like the real @notionhq/client
// (API version 2025-09-03), without the internet. Tests never call the real
// Notion API.
//
// It records every call it gets, and any call other than the two read calls
// the app is allowed to make (dataSources.retrieve / dataSources.query) throws,
// so a test can prove the app never tries to change anything in Notion.

// One row of the Projects board, shaped like Notion's answer.
function notionPage(id, title, status = null, endDate = null) {
  return {
    object: 'page',
    id,
    url: `https://www.notion.so/${id}`,
    last_edited_time: '2026-10-01T15:00:00.000Z',
    in_trash: false,
    properties: {
      'Project name': { id: 'title', type: 'title', title: [{ type: 'text', plain_text: title }] },
      Status: { id: 'st', type: 'status', status: status ? { id: 's1', name: status, color: 'green' } : null },
      'End date': { id: 'ed', type: 'date', date: endDate ? { start: endDate, end: null, time_zone: null } : null },
      Priority: { id: 'pr', type: 'select', select: { id: 'p1', name: 'High', color: 'red' } },
      Assignee: { id: 'as', type: 'people', people: [] },
    },
  };
}

// The board's columns, as dataSources.retrieve returns them.
const BOARD_PROPERTIES = {
  'Project name': { id: 'title', name: 'Project name', type: 'title' },
  Status: { id: 'st', name: 'Status', type: 'status' },
  'End date': { id: 'ed', name: 'End date', type: 'date' },
  Priority: { id: 'pr', name: 'Priority', type: 'select' },
  Assignee: { id: 'as', name: 'Assignee', type: 'people' },
};

// board.pages can be changed between syncs (a status changes, a page is deleted).
//   pageSize – rows per answer (small, so the tests also cover "the next 100")
//   fail     – an error to throw from every call (Notion unreachable, wrong token, ...)
function fakeNotion({ pages = [], properties = BOARD_PROPERTIES, pageSize = 2 } = {}) {
  const board = { pages, properties, fail: null, calls: [] };

  function record(name, args) {
    board.calls.push({ name, args });
    if (board.fail) throw board.fail;
  }

  const allowed = {
    dataSources: {
      async retrieve(args) {
        record('dataSources.retrieve', args);
        return { object: 'data_source', id: args.data_source_id, properties: board.properties };
      },
      async query(args) {
        record('dataSources.query', args);
        const start = args.start_cursor ? Number(args.start_cursor) : 0;
        const results = board.pages.slice(start, start + pageSize);
        const next = start + pageSize < board.pages.length ? String(start + pageSize) : null;
        return { object: 'list', results, has_more: next !== null, next_cursor: next };
      },
    },
  };

  // Anything else (pages.update, blocks.children.append, comments.create, ...)
  // is recorded and refused.
  const refuse = (path) =>
    new Proxy(function refused() {}, {
      get: (target, key) => (typeof key === 'string' ? refuse(`${path}.${key}`) : undefined),
      apply: () => {
        board.calls.push({ name: path, args: null });
        throw new Error(`The app called ${path} — it may only read Notion.`);
      },
    });
  const client = new Proxy(allowed, {
    get: (target, key) => {
      if (key === 'dataSources') {
        return new Proxy(target.dataSources, {
          get: (sources, name) => (name in sources ? sources[name] : refuse(`dataSources.${String(name)}`)),
        });
      }
      return typeof key === 'string' ? refuse(key) : undefined;
    },
  });

  return { client, board };
}

// What fetch throws when there's no internet.
function offlineError() {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.notion.com'), { code: 'ENOTFOUND' }) });
}

// What the Notion library throws for a rejected token.
function unauthorizedError() {
  return Object.assign(new Error('API token is invalid.'), { name: 'APIResponseError', code: 'unauthorized', status: 401 });
}

// The owner's board, roughly: the four real examples, plus pages that look a
// bit alike (so the right one has to win), plus pages with no folder.
function ownersBoard() {
  return [
    notionPage('page-veterans', 'Veterans Video', 'Done', '2026-10-03'),
    notionPage('page-sparrow', 'Sparrow POS Photos', 'In progress'),
    notionPage('page-covenant-update', 'Covenant Classical Video Update', 'Not started'),
    notionPage('page-media-day', 'NCHS Media Day Processing', 'In progress', '2026-08-20'),
    notionPage('page-covenant-grad', 'Covenant Classical Graduation Video', 'Done'),
    notionPage('page-season-recap', 'NCHS Football Season Recap', 'Not started'),
    notionPage('page-day-in-life', 'Day in the Life Video', 'Done'),
    notionPage('page-brand-photos', 'Brand Photos Update', 'In progress'),
    notionPage('page-next-elite-promo', 'Next Elite Promo Video', 'In progress'),
    notionPage('page-website', 'Website Refresh', 'Not started'),
  ];
}

module.exports = { fakeNotion, notionPage, offlineError, unauthorizedError, ownersBoard, BOARD_PROPERTIES };
