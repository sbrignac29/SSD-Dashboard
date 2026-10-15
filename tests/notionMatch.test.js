'use strict';

// Tests for the folder <-> Notion page suggestions (src/notion/match.js),
// using the owner's real examples. Plain text work: no disk, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatcher, words, wordSimilarity, LIKELY_SCORE } = require('../src/notion/match');

// The Working SSD, roughly: the four folders with real Notion pages, plus
// the kind of folders that have none (football games, soccer sessions).
const FOLDERS = [
  "Veteran's Day Video",
  'Sparrow',
  'Covenant Classical Update Content',
  'NCHS Football/MEDIA DAY',
  'NCHS Football/Week 1 vs Naperville North',
  'NCHS Football/Week 2 vs Neuqua Valley',
  'NCHS Football/Week 3 vs Waubonsie 9-12',
  'NCHS Football/Homecoming 10-3',
  'NCHS Football/Senior Night 10-17',
  'Next Elite Soccer Training/8-24 Drills',
  'Next Elite Soccer Training/Session 2026-09-12',
  'Next Elite Soccer Training/Session 2026-09-19',
  'Parker Soccer 10-3',
  'Camping 2026',
  'Covenant Classical Graduation',
  'Soccer Finals Temp',
].map((relPath, i) => ({ id: i + 1, relPath, name: relPath.replace('/', ' / ') }));

const PAGES = [
  'Veterans Video',
  'Sparrow POS Photos',
  'Covenant Classical Video Update',
  'NCHS Media Day Processing',
  // Look-alikes: they share words with the folders above.
  'Covenant Classical Graduation Video',
  'NCHS Football Season Recap',
  'Day in the Life Video',
  'Brand Photos Update',
  'Next Elite Promo Video',
  'Parker Soccer Highlights',
  'Homecoming Hype Video',
  'Website Refresh',
].map((title, i) => ({ pageId: `p${i + 1}`, title }));

// The owner's four real examples: Notion title -> folder.
const REAL_EXAMPLES = [
  ['Veterans Video', "Veteran's Day Video"],
  ['Sparrow POS Photos', 'Sparrow'],
  ['Covenant Classical Video Update', 'Covenant Classical Update Content'],
  ['NCHS Media Day Processing', 'NCHS Football/MEDIA DAY'],
];

const folder = (relPath) => FOLDERS.find((f) => f.relPath === relPath);

test('each real example: the right Notion page is the top suggestion for its folder', () => {
  const matcher = createMatcher(FOLDERS, PAGES);
  for (const [title, relPath] of REAL_EXAMPLES) {
    const suggestions = matcher.suggest(folder(relPath));
    assert.equal(suggestions[0]?.title, title, `${relPath}: ${JSON.stringify(suggestions)}`);
    assert.ok(suggestions[0].likely, `${relPath} -> ${title} should be a likely match (${suggestions[0].score}%)`);
    assert.ok(suggestions.length <= 3, 'at most 3 suggestions');
  }
});

test('each real example: its folder is the best match for that page, too', () => {
  const matcher = createMatcher(FOLDERS, PAGES);
  for (const [title, relPath] of REAL_EXAMPLES) {
    const scoreFor = (f) => matcher.suggest(f, { limit: PAGES.length }).find((s) => s.title === title)?.score ?? 0;
    const best = FOLDERS.reduce((a, b) => (scoreFor(b) > scoreFor(a) ? b : a));
    assert.equal(best.relPath, relPath, title);
  }
});

test('folders with no Notion page get no likely suggestion (nothing is picked in advance)', () => {
  const matcher = createMatcher(FOLDERS, PAGES);
  for (const relPath of [
    'NCHS Football/Week 1 vs Naperville North',
    'NCHS Football/Week 2 vs Neuqua Valley',
    'Next Elite Soccer Training/Session 2026-09-12',
    'Soccer Finals Temp',
  ]) {
    const top = matcher.suggest(folder(relPath))[0];
    assert.ok(!top || top.score < LIKELY_SCORE * 100, `${relPath}: ${JSON.stringify(top)}`);
  }
});

test('names are compared ignoring punctuation, case, dates and plural "s"', () => {
  assert.deepEqual(words("Veteran's Day Video"), ['veteran', 'day', 'video']);
  assert.deepEqual(words('VETERANS-day_video'), ['veteran', 'day', 'video']);
  assert.deepEqual(words('NCHS Football/MEDIA DAY'), ['nch', 'football', 'media', 'day']);
  assert.deepEqual(words('Parker Soccer 10-3'), ['parker', 'soccer']);
  assert.deepEqual(words('2026-08-24 Next Elite - Drills'), ['next', 'elite', 'drill']);
  assert.deepEqual(words('Camping 2026'), ['camping']);
  assert.deepEqual(words('SparrowPOS Photos'), ['sparrow', 'pos', 'photo']);
  assert.deepEqual(words('Café Opening'), ['cafe', 'opening']);
  assert.deepEqual(words('Week 1 vs Naperville North'), ['week', '1', 'naperville', 'north'], '"vs" is a filler word');
  assert.deepEqual(words('Glass Class'), ['glass', 'class'], 'a double "ss" is not a plural');
});

test('near-misses count, but less than the same word; numbers must match exactly', () => {
  assert.equal(wordSimilarity('classical', 'classical'), 1);
  assert.ok(wordSimilarity('classic', 'classical') > 0 && wordSimilarity('classic', 'classical') < 1);
  assert.ok(wordSimilarity('covenant', 'covenent') > 0, 'a one-letter typo');
  assert.equal(wordSimilarity('day', 'dax'), 0, 'short words must match exactly');
  assert.equal(wordSimilarity('1', '7'), 0);
});

test('a page already linked to another folder is ranked lower, and says so', () => {
  const pages = [
    { pageId: 'a', title: 'Covenant Classical Video Update', linkedTo: [{ id: 99, name: 'Other Folder' }] },
    { pageId: 'b', title: 'Covenant Classical Update Video' },
  ];
  const [first, second] = createMatcher(FOLDERS, pages).suggest(folder('Covenant Classical Update Content'));
  assert.equal(first.pageId, 'b');
  assert.deepEqual(second.linkedTo, ['Other Folder']);
});

test('a folder already linked to a page is not "also linked" to itself', () => {
  const me = folder('Sparrow');
  const pages = [{ pageId: 'a', title: 'Sparrow POS Photos', linkedTo: [{ id: me.id, name: me.name }] }];
  const [top] = createMatcher(FOLDERS, pages).suggest(me);
  assert.deepEqual(top.linkedTo, []);
});
