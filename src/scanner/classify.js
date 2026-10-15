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

// Removes words that also appear in the project's own name (once each), so a
// word that's just part of the event's name doesn't count as a signal:
//   project "NCHS Basketball Regional Final", file "Regional Final Highlights v1"
//   → " highlights v1 "   (a draft — "Final" was only the game's name)
function withoutProjectWords(words, projectWords) {
  const remaining = words.trim().split(' ').filter(Boolean);
  for (const word of projectWords) {
    const index = remaining.indexOf(word);
    if (index !== -1) remaining.splice(index, 1);
  }
  return ` ${remaining.join(' ')} `;
}

// "Semi-Final", "Quarter-Final", "Pre-Final" and "Not Final" are not finals.
function withoutQualifiedFinals(words) {
  return words.replace(/ (?:semi|quarter|pre|not) final(?:v?\d{1,4})?(?= )/g, '');
}

// Names some apps give files: a random unique ID like
// 0B9C5E3A-FD12-4C8E-9A51-3D2F6E7B8C90. Any "word" in it is a coincidence.
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // The words of a file's name that can carry a signal: minus the project's
  // own name, minus "Semi-Final" and friends, and none at all for random IDs.
  function signalWords(fileName, context) {
    const base = path.basename(fileName, path.extname(fileName));
    if (UUID_NAME.test(base)) return ' ';
    return withoutQualifiedFinals(withoutProjectWords(toWords(base), context.projectWords));
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
      hidden: false,
      projectWords: projectPath.flatMap(wordList),
    };
  }

  // The context for a subfolder: everything the parent knew, plus whatever
  // this folder's own name says. A folder of FINAL exports is one whose name
  // says both export and final ("Final Exports", "FINAL FINAL RENDERS"), or
  // one named final inside an export folder ("Exports/FD", "Exports/Final").
  // A plain "Final" folder elsewhere could be footage of a final game.
  function childContext(parent, folderName) {
    const words = toWords(folderName);
    const isExportFolder = hasPhrase(words, rules.exportFolders);
    const signal = withoutQualifiedFinals(withoutProjectWords(words, parent.projectWords));
    const namesFinal = hasPhrase(signal, rules.finalExportWords) && !hasPhrase(signal, rules.notFinalWords);
    return {
      cache: parent.cache || hasPhrase(words, rules.cacheFolders),
      proxy: parent.proxy || hasPhrase(words, rules.proxyFolders),
      export: parent.export || isExportFolder,
      final: parent.final || ((parent.export || isExportFolder) && namesFinal),
      hidden: parent.hidden || folderName.startsWith('.'),
      projectWords: parent.projectWords,
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
    if (hasPhrase(signal, rules.notFinalWords)) return null;
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
