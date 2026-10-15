'use strict';

// Suggests which Notion page belongs to which project folder.
//
// Folder names and Notion titles are written differently:
//   Notion "Veterans Video"                  folder "Veteran's Day Video"
//   Notion "Sparrow POS Photos"              folder "Sparrow"
//   Notion "Covenant Classical Video Update" folder "Covenant Classical Update Content"
//   Notion "NCHS Media Day Processing"       folder "NCHS Football / MEDIA DAY"
// so an exact comparison finds nothing. This file only SUGGESTS: you confirm
// every link on the Link to Notion page; nothing is linked automatically.
//
// The method: compare the WORDS in the two names.
//
//   1. Clean both names the same way: take out dates ("10-3", "2026-08-24"),
//      split "SparrowPOS" into two words, lowercase, drop apostrophes
//      ("Veteran's" -> "veterans") and other punctuation, drop filler words
//      ("the", "and", "vs"), and drop a plural "s" ("veterans" -> "veteran").
//   2. Pair up words that are the same, or nearly: one starts with the other
//      ("classic" / "classical") or one letter is different (a typo).
//   3. Rare words count for more than common ones. "Sparrow" appears in one
//      name, "video" in dozens, so sharing "Sparrow" says much more. Each
//      word's weight is ln(1 + names / names containing the word), a classic
//      search-engine measure called IDF ("inverse document frequency").
//   4. The score (0-1) mixes two views of the shared weight:
//        - how much of BOTH names it covers  (60%: "Dice similarity")
//        - how much of the SHORTER name      (40%: so the one-word folder
//          "Sparrow" still scores well against "Sparrow POS Photos")
//
// It's all plain text work: no disk, no network, no database.

const { removeDates } = require('../scanner/parseName');

// Words that say nothing about which project it is.
const FILLER_WORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'with', 'vs', 'v', 'x', 'by']);

// How much a near-miss pair of words counts, compared with an exact match.
const NEAR_MATCH = 0.8;
// A Notion page that's already linked to another folder is less likely to be
// this one too (but still can be: one Notion project can span two folders).
const ALREADY_LINKED = 0.8;
// Suggestions below this are noise and aren't shown.
const MIN_SCORE = 0.2;
// From here on, a suggestion is called "likely" and picked in advance (you
// still press Confirm).
const LIKELY_SCORE = 0.5;

// "NCHS Football/MEDIA DAY 10-3" -> ['nch', 'football', 'media', 'day']
// (Every name goes through the same steps, so "nchs" -> "nch" on both sides
// still matches.)
function words(name) {
  const text = String(name ?? '')
    // A folder path: each part on its own, so "/" isn't read as part of a date.
    .split('/')
    .map(removeDates)
    .join(' ')
    // "SparrowPOS" -> "Sparrow POS", "MediaDay" -> "Media Day"
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // é -> e
    .toLowerCase()
    .replace(/['’‘`]/g, '') // veteran's -> veterans
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  const seen = new Set();
  for (let word of text.split(' ')) {
    if (word === '' || FILLER_WORDS.has(word)) continue;
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
    seen.add(word);
  }
  return [...seen];
}

// Levenshtein distance capped at 2 (enough to spot a one-letter typo).
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return Math.min(2, previous[b.length]);
}

// 1 for the same word, NEAR_MATCH for nearly the same, else 0.
function wordSimilarity(a, b) {
  if (a === b) return 1;
  // Numbers must match exactly: "Week 1" isn't "Week 7".
  if (/\d/.test(a) || /\d/.test(b)) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 4 && long.startsWith(short)) return NEAR_MATCH;
  if (short.length >= 5 && editDistance(a, b) === 1) return NEAR_MATCH;
  return 0;
}

// The word weights (step 3), from every folder name and page title together.
// Returns a function: word -> weight.
function wordWeights(allNames) {
  const namesWith = new Map();
  for (const name of allNames) {
    for (const word of words(name)) namesWith.set(word, (namesWith.get(word) ?? 0) + 1);
  }
  const total = Math.max(1, allNames.length);
  return (word) => Math.log(1 + total / (namesWith.get(word) ?? 1));
}

// How alike two word lists are, from 0 to 1 (step 4).
function similarity(folderWords, pageWords, weightOf) {
  if (folderWords.length === 0 || pageWords.length === 0) return 0;
  // Every possible pair of words that match, best first; then each word is
  // used in at most one pair.
  const pairs = [];
  for (const f of folderWords) {
    for (const p of pageWords) {
      const sim = wordSimilarity(f, p);
      if (sim > 0) pairs.push({ f, p, value: (sim * (weightOf(f) + weightOf(p))) / 2 });
    }
  }
  pairs.sort((a, b) => b.value - a.value);
  const usedF = new Set();
  const usedP = new Set();
  let shared = 0;
  for (const { f, p, value } of pairs) {
    if (usedF.has(f) || usedP.has(p)) continue;
    usedF.add(f);
    usedP.add(p);
    shared += value;
  }
  const folderTotal = folderWords.reduce((sum, w) => sum + weightOf(w), 0);
  const pageTotal = pageWords.reduce((sum, w) => sum + weightOf(w), 0);
  const dice = (2 * shared) / (folderTotal + pageTotal);
  const ofShorter = shared / Math.min(folderTotal, pageTotal);
  return Math.min(1, 0.6 * dice + 0.4 * ofShorter);
}

// Builds a matcher for a set of folders and pages.
//   folders – [{ id, relPath }]           (relPath like "NCHS Football/MEDIA DAY")
//   pages   – [{ pageId, title, status?, linkedTo? }] (linkedTo: [{ id, name }] of folders it's already linked to)
// Returns suggest(folder, { limit }) -> the best pages for that folder,
// [{ pageId, title, score (0-100), likely, linkedTo }], best first.
function createMatcher(folders, pages) {
  const weightOf = wordWeights([...folders.map((f) => f.relPath), ...pages.map((p) => p.title)]);
  const pageWords = pages.map((page) => ({ page, words: words(page.title) }));

  function suggest(folder, { limit = 3 } = {}) {
    const folderWords = words(folder.relPath);
    return pageWords
      .map(({ page, words: titleWords }) => {
        const elsewhere = (page.linkedTo ?? []).filter((linked) => linked.id !== folder.id).map((linked) => linked.name);
        const raw = similarity(folderWords, titleWords, weightOf) * (elsewhere.length > 0 ? ALREADY_LINKED : 1);
        return { page, elsewhere, score: Math.round(raw * 100) };
      })
      .filter((s) => s.score >= MIN_SCORE * 100)
      .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title))
      .slice(0, limit)
      .map(({ page, elsewhere, score }) => ({
        pageId: page.pageId,
        title: page.title,
        status: page.status ?? null,
        score,
        likely: score >= LIKELY_SCORE * 100,
        linkedTo: elsewhere,
      }));
  }

  return { suggest };
}

module.exports = { createMatcher, words, wordSimilarity, similarity, MIN_SCORE, LIKELY_SCORE };
