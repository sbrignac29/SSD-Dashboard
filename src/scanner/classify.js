'use strict';

// Sorts files into one of six types, using only names (the file's name and the
// names of the folders it sits in):
//
//   project – edit project files (.drp, .prproj, ...)
//   cache   – files an app can regenerate (render cache, peak files, ...)
//   proxy   – low-res copies made for smoother editing
//   export  – finished renders / deliverables
//   raw     – original media: video, photos, audio
//   other   – everything else (documents, graphics, LUTs, system files)
//
// Nothing in this file touches the disk. That makes it a set of "pure
// functions" — same input, same answer, every time — which are easy to test
// (see tests/classify.test.js).
//
// All the word lists and extensions come from "fileTypes" in the config.

const path = require('node:path');

const CATEGORIES = Object.freeze(['raw', 'proxy', 'export', 'cache', 'project', 'other']);

const HOUSEKEEPING_NAMES = new Set(['thumbs.db', 'desktop.ini', 'icon\r']);

// Housekeeping files are ones macOS or Windows create on their own:
// .DS_Store (Finder view settings), ._name (extra file info on non-Mac
// drives), Thumbs.db, desktop.ini, and anything else hidden (starting with a
// dot). Finder rewrites some of these just because you OPENED a folder, so
// they must never count as "you edited this project".
function isHousekeepingName(name) {
  return name.startsWith('.') || HOUSEKEEPING_NAMES.has(name.toLowerCase());
}

// Turns a name into lowercase words with a space on each side, so we can
// match whole words with a simple "includes" check:
//   "ProRes Proxies" -> " pro res proxies "
//   "05_Exports"     -> " 05 exports "
//   "CacheClip"      -> " cache clip "   (camelCase gets split)
function toWords(name) {
  const words = String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return ` ${words} `;
}

// Turns a config word like "final" or "peak files" into a pattern that finds
// it as whole words in a toWords() string. A version or small number stuck on
// the end still counts — "FINALv2", "FD2", "Exports2025" — but other letters
// don't ("Finally" is not "final"), and neither do long numbers:
// "RPReplay_Final1726851234" is a phone's timestamp, not a version.
function phrasePattern(phrase) {
  const words = toWords(phrase).trim();
  if (words === '') return null;
  return new RegExp(` ${words}(?:v?\\d{1,4})? `);
}

// True if any phrase pattern matches `words` (a toWords() string).
function hasPhrase(words, patterns) {
  return patterns.some((pattern) => pattern.test(words));
}

// Splits a name into its list of lowercase words.
function wordList(name) {
  return toWords(name).trim().split(' ').filter(Boolean);
}

// "finals" and "final" (and other simple plurals) count as the same word
// when comparing with the project's name.
function singular(word) {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

// Removes the parts of a name that just repeat the project's own name, so a
// word that's only part of the event's name doesn't count as a signal. Only
// runs of 2+ words are removed, so a lone "Final" the editor typed still counts:
//   project "NCHS Basketball Regional Final":
//     "Regional Final Highlights v1" → " highlights v1 "   (a draft)
//     "Highlights FINAL"             → " highlights final " (final)
//   project "Soccer Finals Temp":
//     "Soccer Final v1"              → " v1 "                (a draft)
function withoutProjectWords(words, projectSegments) {
  const remaining = words.trim().split(' ').filter(Boolean);
  const same = (a, b) => singular(a) === singular(b);
  for (const segment of projectSegments) {
    // Longest runs first, so "naperville fd recruitment" goes before "naperville fd".
    for (let length = segment.length; length >= 2; length -= 1) {
      for (let start = 0; start + length <= segment.length; start += 1) {
        const run = segment.slice(start, start + length);
        for (let i = 0; i + length <= remaining.length; i += 1) {
          if (run.every((word, k) => same(word, remaining[i + k]))) {
            remaining.splice(i, length);
            i -= 1;
          }
        }
      }
    }
  }
  return ` ${remaining.join(' ')} `;
}

// Game rounds and qualifiers that make "Final" part of an event's name, not a
// verdict on the export: "Semi-Final", "Sectional Final", "State Final",
// "Not Final". (A FINAL tag after the event name still counts:
// "State Final Highlights FINAL".)
const QUALIFIED_FINAL =
  / (?:semi|quarter|pre|not|sectional|regional|state|district|conference|championship|section|super) final(?:v?\d{1,4})?(?= )/g;

function withoutQualifiedFinals(words) {
  return words.replace(QUALIFIED_FINAL, '');
}

// "FD" may well stand for "Final Draft", so the spelled-out phrase means
// final too — while "Draft" on its own still means a draft.
function finalDraftAsFinal(words) {
  return words.replace(/ final drafts?(?= )/g, ' fd');
}

// Random unique IDs some apps put in file names, e.g. iPhone's
// "trim.0B9C5E3A-FD12-4C8E-9A51-3D2F6E7B8C90.MOV". Any "word" in one is a coincidence.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// The words of a name that can carry a signal: minus random IDs, minus the
// project's own name, minus qualified finals ("Semi-Final", "State Final").
function signalOf(name, projectSegments) {
  const words = toWords(String(name).replace(UUID, ' '));
  return finalDraftAsFinal(withoutQualifiedFinals(withoutProjectWords(words, projectSegments)));
}

function normalizeExtension(ext) {
  const lower = String(ext).trim().toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

// Builds a classifier from the config's "fileTypes" section. Doing the setup
// once (instead of once per file) keeps scans of huge drives fast.
function createClassifier(fileTypes) {
  const extensions = (list) => new Set((list || []).map(normalizeExtension));
  const phrases = (list) => (list || []).map(phrasePattern).filter(Boolean);

  const rules = {
    projectExtensions: extensions(fileTypes.projectExtensions),
    cacheExtensions: extensions(fileTypes.cacheExtensions),
    proxyExtensions: extensions(fileTypes.proxyExtensions),
    videoExtensions: extensions(fileTypes.videoExtensions),
    photoExtensions: extensions(fileTypes.photoExtensions),
    mediaExtensions: extensions([
      ...(fileTypes.videoExtensions || []),
      ...(fileTypes.photoExtensions || []),
      ...(fileTypes.audioExtensions || []),
    ]),
    cacheFolders: phrases(fileTypes.cacheFolderWords),
    proxyFolders: phrases(fileTypes.proxyFolderWords),
    proxyFileWords: phrases(fileTypes.proxyFileWords),
    exportFolders: phrases(fileTypes.exportFolderWords),
    // A video named "... FD" is an export even if "fd" was left out of
    // exportFileWords: final words always count as export words too.
    exportFileWords: phrases([...(fileTypes.exportFileWords || []), ...(fileTypes.finalExportWords || [])]),
    finalExportWords: phrases(fileTypes.finalExportWords),
    notFinalWords: phrases(fileTypes.notFinalWords),
  };

  // 'video', 'photo', 'audio', or null, from the file extension.
  function mediaKind(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    if (rules.videoExtensions.has(ext)) return 'video';
    if (rules.photoExtensions.has(ext)) return 'photo';
    if (rules.mediaExtensions.has(ext)) return 'audio';
    return null;
  }

  // The words of a file's name that can carry a signal (see signalOf).
  function signalWords(fileName, context) {
    return signalOf(path.basename(fileName, path.extname(fileName)), context.projectSegments);
  }

  // A "context" remembers what we've learned from the folders above a file,
  // so each folder name is only looked at once, not once per file inside it.
  //
  // The starting context comes from the project's own path, e.g.
  // ["NCHS Football Working Proxies"] or ["NCHS Football", "Week 3"].
  // A project NAME can mark everything inside as cache or proxy (a folder
  // called "...Working Proxies" really is all proxies), but it can never mark
  // things as exports or finals: "Soccer Finals Temp" is about a finals game,
  // not a folder of finished renders.
  function rootContext(projectPath = []) {
    const words = projectPath.map(toWords);
    return {
      cache: words.some((w) => hasPhrase(w, rules.cacheFolders)),
      proxy: words.some((w) => hasPhrase(w, rules.proxyFolders)),
      export: false,
      final: false,
      draft: false,
      hidden: false,
      projectSegments: projectPath.map(wordList),
    };
  }

  // The context for a subfolder: everything the parent knew, plus whatever
  // this folder's own name says. A folder of FINAL exports is one whose name
  // says both export and final ("Final Exports", "FINAL FINAL RENDERS"), or
  // one named final inside an export folder ("Exports/FD", "Exports/Final").
  // A plain "Final" folder elsewhere could be footage of a final game, and a
  // "Drafts" folder anywhere below cancels it ("Final Exports/Drafts/").
  function childContext(parent, folderName) {
    const words = toWords(folderName);
    const isExportFolder = hasPhrase(words, rules.exportFolders);
    const signal = signalOf(folderName, parent.projectSegments);
    const namesDraft = hasPhrase(signal, rules.notFinalWords);
    const namesFinal = hasPhrase(signal, rules.finalExportWords) && !namesDraft;
    return {
      cache: parent.cache || hasPhrase(words, rules.cacheFolders),
      proxy: parent.proxy || hasPhrase(words, rules.proxyFolders),
      export: parent.export || isExportFolder,
      final: !namesDraft && (parent.final || ((parent.export || isExportFolder) && namesFinal)),
      draft: parent.draft || namesDraft,
      hidden: parent.hidden || folderName.startsWith('.'),
      projectSegments: parent.projectSegments,
    };
  }

  // Decides a file's type. The first rule that matches wins, so the order
  // matters: a .prproj saved inside an "Exports" folder is still a project
  // file, and a "Render Cache" folder is cache even though it says "render".
  function classifyFile(fileName, context) {
    if (isHousekeepingName(fileName)) return 'other';

    const ext = path.extname(fileName).toLowerCase();
    if (rules.projectExtensions.has(ext)) return 'project';

    if (context.cache || rules.cacheExtensions.has(ext)) return 'cache';

    const isVideo = rules.videoExtensions.has(ext);
    const nameWords = toWords(path.basename(fileName, ext));

    if (context.proxy || rules.proxyExtensions.has(ext)) return 'proxy';
    if (isVideo && hasPhrase(nameWords, rules.proxyFileWords)) return 'proxy';

    if (context.export) return 'export';
    if (isVideo && hasPhrase(signalWords(fileName, context), rules.exportFileWords)) return 'export';

    if (rules.mediaExtensions.has(ext)) return 'raw';
    return 'other';
  }

  // A FINAL export is how we know a project is finished. Plain exports can be
  // drafts still in revision, so it takes an export that says it's final —
  // by its name ("Final"/"FD", from fileTypes.finalExportWords) or by its
  // folder ("Final Exports/", "Exports/FD/") — and isn't marked as a draft
  // (fileTypes.notFinalWords: "Draft", "Rough", "WIP"):
  //   "Soccer 8-24 FD.mp4", "Promo FINALv2.mov"  → final
  //   "Soccer 8-24 v3.mp4" in Exports/            → export, but not final
  //   "Regional Final Highlights v1.mp4" in a project named "...Regional Final"
  //                                               → not final (that's the game's name)
  // Returns 'video' or 'photo' for a final export, else null. (The scanner
  // only counts a photo final when the project has no video exports at all.)
  function finalExportKind(fileName, context) {
    const kind = mediaKind(fileName);
    if (kind !== 'video' && kind !== 'photo') return null;
    if (classifyFile(fileName, context) !== 'export') return null;
    const signal = signalWords(fileName, context);
    if (context.draft || hasPhrase(signal, rules.notFinalWords)) return null;
    return context.final || hasPhrase(signal, rules.finalExportWords) ? kind : null;
  }

  // Walks from the project folder down to a file's folder, building up the
  // context (used by the convenience helpers below).
  function contextFor(foldersInsideProject, projectPath) {
    let context = rootContext(projectPath);
    for (const folder of foldersInsideProject) context = childContext(context, folder);
    return context;
  }

  // Conveniences for tests and one-off use: classify a file given the folders
  // inside the project that lead to it, e.g.
  //   classify('A001.mov', ['Footage', 'Day 1'], ['Soccer 8-24'])
  function classify(fileName, foldersInsideProject = [], projectPath = []) {
    return classifyFile(fileName, contextFor(foldersInsideProject, projectPath));
  }
  function finalKind(fileName, foldersInsideProject = [], projectPath = []) {
    return finalExportKind(fileName, contextFor(foldersInsideProject, projectPath));
  }
  function isFinal(fileName, foldersInsideProject = [], projectPath = []) {
    return finalKind(fileName, foldersInsideProject, projectPath) !== null;
  }

  return { rootContext, childContext, classifyFile, finalExportKind, mediaKind, classify, finalKind, isFinal };
}

module.exports = { CATEGORIES, createClassifier, isHousekeepingName, toWords };
