'use strict';

// Reads your Notion "Projects" database, so a project you've marked Done in
// Notion counts as finished (Done = 100 in the score).
//
// How the Notion API works, in short:
//   - An API is a set of addresses a program can call instead of a person
//     clicking. Notion's lives at https://api.notion.com. Each call is an HTTP
//     request, like a browser's, answered with JSON.
//   - Every call carries your TOKEN (from config.json → notion.token), a long
//     secret string that says "this is the BrigsMedia integration". Notion
//     only shows the integration pages you've shared with it, and only lets it
//     do what you ticked when you made it (here: Read content, nothing else).
//   - Since API version 2025-09-03 a database is a container that holds one
//     or more DATA SOURCES (the tables with the rows). Rows are read from a
//     data source, so the setting is notion.dataSourceId, not the database ID.
//     The @notionhq/client library sends that version by default; we also
//     name it below, so a library upgrade can't silently change the format.
//   - A query returns at most 100 rows at a time; `next_cursor` says where the
//     next 100 start ("pagination"). We keep asking until there are no more.
//
// SAFETY: this file only READS Notion. readOnly() below is the only door to
// the Notion library, and it has exactly two read calls in it.
// tests/safety.test.js fails if any other Notion call appears in src/.
// What Notion said is saved in data/ (src/db.js), like everything else.
//
// Nothing here runs by itself: only the Refresh Notion button and Scan now
// (not the nightly scan) call sync().

const { notionSettings, assertSafeLocations } = require('../config');
const { saveNotionSync, recordFailedNotionSync, describeDatabaseError } = require('../db');

// The Notion API version this code is written for (see above).
const NOTION_VERSION = '2025-09-03';
// Never more than this many rounds of 100 (a safety stop: 10,000 pages).
const MAX_ROUNDS = 100;

// For problems with a plain-English explanation (wrong token, not shared, ...).
class NotionError extends Error {}

// SAFETY: the only ways this app talks to Notion. Both only read.
function readOnly(client) {
  return {
    // The database's columns (property names and types).
    retrieveDataSource: (dataSourceId) => client.dataSources.retrieve({ data_source_id: dataSourceId }),
    // Up to 100 rows, starting at `cursor`.
    queryDataSource: (dataSourceId, cursor) =>
      client.dataSources.query({ data_source_id: dataSourceId, page_size: 100, start_cursor: cursor }),
  };
}

// The real Notion library, set up with your token. (Tests pass a fake instead.)
function openNotion(settings) {
  let notionLibrary;
  try {
    notionLibrary = require('@notionhq/client');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new NotionError("The Notion library isn't installed yet. Run `npm install` in the app folder, then restart the dashboard.");
    }
    throw error;
  }
  return new notionLibrary.Client({
    auth: settings.token,
    notionVersion: NOTION_VERSION,
    timeoutMs: 20000, // give up on one request after 20 seconds
    retry: { maxRetries: 2 }, // "slow down" or "busy" answers are retried twice
    logLevel: notionLibrary.LogLevel.ERROR, // we explain failures ourselves
  });
}

// Checks the columns named in config.json exist and have the right type, so a
// renamed column gives a clear message instead of every status quietly empty.
async function checkProperties(notion, settings) {
  const source = await notion.retrieveDataSource(settings.dataSourceId);
  const properties = source.properties ?? {};
  const names = Object.keys(properties);
  const problems = [];
  const expect = (setting, name, types, typeWords) => {
    if (!name) return;
    const property = properties[name];
    if (!property) problems.push(`there's no "${name}" column (notion.${setting} in config.json)`);
    else if (!types.includes(property.type)) problems.push(`"${name}" is a ${property.type} column, not ${typeWords}`);
  };
  expect('titleProperty', settings.titleProperty, ['title'], 'the title');
  expect('statusProperty', settings.statusProperty, ['status', 'select'], 'a status or select');
  expect('endDateProperty', settings.endDateProperty, ['date'], 'a date');
  if (problems.length > 0) {
    throw new NotionError(
      `Your Notion database doesn't look as expected: ${problems.join('; ')}. ` +
        `Its columns are: ${names.join(', ') || '(none)'}. Fix the names under "notion" in config.json.`,
    );
  }
}

// One Notion row (a "page") -> the few facts the dashboard uses.
function readPage(page, settings) {
  const properties = page.properties ?? {};
  const titleParts = properties[settings.titleProperty]?.title ?? [];
  const statusProperty = properties[settings.statusProperty];
  const dateProperty = settings.endDateProperty ? properties[settings.endDateProperty] : null;
  const status =
    statusProperty?.type === 'status'
      ? statusProperty.status?.name
      : statusProperty?.type === 'select'
        ? statusProperty.select?.name
        : null;
  return {
    pageId: page.id,
    title: titleParts.map((part) => part.plain_text ?? '').join('').trim(),
    status: status ?? null,
    // A date range ("Oct 1 → Oct 3") ends on its second date.
    endDate: dateProperty?.type === 'date' ? (dateProperty.date?.end ?? dateProperty.date?.start ?? null) : null,
    url: page.url ?? null,
    lastEdited: page.last_edited_time ?? null,
  };
}

// Every page in the data source, 100 at a time.
async function readAllPages(notion, settings) {
  const pages = [];
  let cursor;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const answer = await notion.queryDataSource(settings.dataSourceId, cursor);
    for (const result of answer.results ?? []) {
      // A data source can also hold sub-databases; only pages are projects.
      if (result.object === 'page' && result.properties) pages.push(readPage(result, settings));
    }
    if (!answer.has_more || !answer.next_cursor) return pages;
    cursor = answer.next_cursor;
  }
  throw new NotionError(`Your Notion database has more than ${MAX_ROUNDS * 100} pages, more than this app reads.`);
}

// A plain-English reason for a failed sync, or null for something unexpected.
// (Never includes the token.)
function describeNotionError(error) {
  if (error instanceof NotionError) return error.message;
  const reasons = {
    unauthorized:
      "Notion didn't accept the token in config.json (notion.token). Copy it again from your integration's " +
      'Configuration tab, paste it between the quotes, and restart the dashboard.',
    object_not_found:
      "Notion can't find the Projects data source. Either the database isn't shared with your integration yet " +
      '(in Notion: open Projects → ••• → Connections → add your integration), or notion.dataSourceId in ' +
      'config.json is the database ID instead of the data source ID (see the README).',
    restricted_resource:
      "Your integration isn't allowed to read the Projects database. In its settings, under Capabilities, tick Read content.",
    rate_limited: 'Notion asked the app to slow down. Wait a minute, then press Refresh Notion.',
    notionhq_client_request_timeout: "Notion didn't answer within 20 seconds. Check your internet, then press Refresh Notion.",
    internal_server_error: 'Notion is having trouble right now. Try Refresh Notion again later.',
    service_unavailable: 'Notion is having trouble right now. Try Refresh Notion again later.',
    service_overload: 'Notion is having trouble right now. Try Refresh Notion again later.',
    gateway_timeout: 'Notion is having trouble right now. Try Refresh Notion again later.',
    validation_error: `Notion refused the request: ${error?.message}`,
    invalid_request: `Notion refused the request: ${error?.message}`,
  };
  if (reasons[error?.code]) return reasons[error.code];
  // No internet (or Notion's address can't be found): fetch itself fails.
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    return "Can't reach Notion. Is this Mac online? The dashboard keeps using the statuses from the last sync.";
  }
  return null;
}

// One sync: read every page, save them, re-score. Returns
//   { ok: true, pageCount, gone, message }
//   { ok: false, reason: 'not-configured' | 'failed', message }
// It never throws for Notion problems: the dashboard keeps working with the
// last synced statuses, and the failure is recorded in notion_syncs.
//   client      – a Notion client (tests pass a fake); default: the real one
//   triggeredBy – 'button' (Refresh Notion) or 'scan' (Scan now)
async function syncNotion({ db, config, client, triggeredBy = 'button', now = Date.now(), log = console }) {
  const settings = notionSettings(config);
  if (!settings.configured) {
    return {
      ok: false,
      reason: 'not-configured',
      message: settings.token
        ? 'Notion: not connected. Add your data source ID as notion.dataSourceId in config.json.'
        : 'Notion: not connected. Add your token as notion.token in config.json (see the README).',
    };
  }
  const startedAt = now;
  try {
    const notion = readOnly(client ?? openNotion(settings));
    await checkProperties(notion, settings);
    const pages = await readAllPages(notion, settings);
    const saved = saveNotionSync(db, config, { pages, startedAt, triggeredBy, dataSourceId: settings.dataSourceId });
    const gone = saved.gone > 0 ? ` ${saved.gone} page(s) from before weren't there (deleted, or no longer shared).` : '';
    return {
      ok: true,
      pageCount: saved.pageCount,
      gone: saved.gone,
      message: `Read ${saved.pageCount} page${saved.pageCount === 1 ? '' : 's'} from Notion.${gone}`,
    };
  } catch (error) {
    const plain = describeNotionError(error);
    const databaseProblem = describeDatabaseError(error);
    if (!plain && !databaseProblem) log.error(error);
    const message = plain ?? databaseProblem ?? `Something went wrong reading Notion: ${error.message}. The Terminal window has the details.`;
    if (error?.code !== 'SQLITE_BUSY') {
      try {
        recordFailedNotionSync(db, { startedAt, error: message, triggeredBy, dataSourceId: settings.dataSourceId });
      } catch {
        // The database itself is the problem; the message above says so.
      }
    }
    return { ok: false, reason: 'failed', message: `Notion: not connected. ${message}` };
  }
}

// One sync at a time, for the server: pressing Refresh Notion while a sync
// (or Scan now's sync) is running joins that one instead of starting another.
//   makeClient – settings -> a Notion client (tests pass a fake)
function createNotionSyncer({ db, getConfig, makeClient = openNotion, log = console }) {
  let running = null;

  function sync({ triggeredBy = 'button' } = {}) {
    if (running) return running;
    running = (async () => {
      const config = getConfig();
      // SAFETY: a sync writes to the database, so the same checks as a scan.
      assertSafeLocations(config);
      const settings = notionSettings(config);
      let client;
      if (settings.configured) {
        try {
          client = makeClient(settings);
        } catch (error) {
          return { ok: false, reason: 'failed', message: `Notion: not connected. ${describeNotionError(error) ?? error.message}` };
        }
      }
      return syncNotion({ db, config, client, triggeredBy, log });
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return { sync, isRunning: () => running !== null };
}

module.exports = {
  NOTION_VERSION,
  NotionError,
  readOnly,
  readPage,
  syncNotion,
  createNotionSyncer,
  describeNotionError,
};
