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

// True if any phrase (already in toWords form) appears in `words`.
function hasPhrase(words, phrases) {
  return phrases.some((phrase) => words.includes(phrase));
}

function normalizeExtension(ext) {
  const lower = String(ext).trim().toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

// Builds a classifier from the config's "fileTypes" section. Doing the setup
// once (instead of once per file) keeps scans of huge drives fast.
function createClassifier(fileTypes) {
  const extensions = (list) => new Set((list || []).map(normalizeExtension));
  const phrases = (list) => (list || []).map(toWords).filter((phrase) => phrase.trim() !== '');

  const rules = {
    projectExtensions: extensions(fileTypes.projectExtensions),
    cacheExtensions: extensions(fileTypes.cacheExtensions),
    proxyExtensions: extensions(fileTypes.proxyExtensions),
    videoExtensions: extensions(fileTypes.videoExtensions),
    mediaExtensions: extensions([
      ...(fileTypes.videoExtensions || []),
      ...(fileTypes.photoExtensions || []),
      ...(fileTypes.audioExtensions || []),
    ]),
    cacheFolders: phrases(fileTypes.cacheFolderWords),
    proxyFolders: phrases(fileTypes.proxyFolderWords),
    proxyFileWords: phrases(fileTypes.proxyFileWords),
    exportFolders: phrases(fileTypes.exportFolderWords),
    exportFileWords: phrases(fileTypes.exportFileWords),
  };

  // A "context" remembers what we've learned from the folders above a file,
  // so each folder name is only looked at once, not once per file inside it.
  //
  // The starting context comes from the project's own path, e.g.
  // ["NCHS Football Working Proxies"] or ["NCHS Football", "Week 3"].
  // A project NAME can mark everything inside as cache or proxy (a folder
  // called "...Working Proxies" really is all proxies), but it can never mark
  // things as exports: "Soccer Finals Temp" is about a finals game, not a
  // folder of finished renders.
  function rootContext(projectPath = []) {
    const words = projectPath.map(toWords);
    return {
      cache: words.some((w) => hasPhrase(w, rules.cacheFolders)),
      proxy: words.some((w) => hasPhrase(w, rules.proxyFolders)),
      export: false,
      hidden: false,
    };
  }

  // The context for a subfolder: everything the parent knew, plus whatever
  // this folder's own name says.
  function childContext(parent, folderName) {
    const words = toWords(folderName);
    return {
      cache: parent.cache || hasPhrase(words, rules.cacheFolders),
      proxy: parent.proxy || hasPhrase(words, rules.proxyFolders),
      export: parent.export || hasPhrase(words, rules.exportFolders),
      hidden: parent.hidden || folderName.startsWith('.'),
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
    const nameWords = toWords(path.basename(fileName, path.extname(fileName)));

    if (context.proxy || rules.proxyExtensions.has(ext)) return 'proxy';
    if (isVideo && hasPhrase(nameWords, rules.proxyFileWords)) return 'proxy';

    if (context.export) return 'export';
    if (isVideo && hasPhrase(nameWords, rules.exportFileWords)) return 'export';

    if (rules.mediaExtensions.has(ext)) return 'raw';
    return 'other';
  }

  // Convenience for tests and one-off use: classify a file given the folders
  // inside the project that lead to it, e.g.
  //   classify('A001.mov', ['Footage', 'Day 1'], ['Soccer 8-24'])
  function classify(fileName, foldersInsideProject = [], projectPath = []) {
    let context = rootContext(projectPath);
    for (const folder of foldersInsideProject) context = childContext(context, folder);
    return classifyFile(fileName, context);
  }

  return { rootContext, childContext, classifyFile, classify };
}

module.exports = { CATEGORIES, createClassifier, isHousekeepingName, toWords };
