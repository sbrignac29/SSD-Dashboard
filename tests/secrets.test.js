'use strict';

// SECRET GUARD: fails if a Notion token (or something that looks like one) is
// in any file that git would commit.
//
// Your token belongs in config.json, which .gitignore keeps out of git. If it
// ever ended up in a tracked file (config.example.json, the README, a test,
// the code) and you pushed it to GitHub, anyone who saw it could read your
// Notion workspace. Then: revoke it in Notion (the integration's page → Refresh
// / regenerate the secret) and paste the new one into config.json.
//
// "Files git would commit" = tracked files, plus new files git isn't told to
// ignore (what `git add .` would pick up). config.json is ignored, so it's skipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Notion tokens start with "ntn_" (newer) or "secret_" (older), then a long
// run of letters and digits. Written in pieces, so this file doesn't trip itself.
const TOKEN_PREFIXES = ['ntn', 'secret'];
const TOKEN_PATTERN = new RegExp(`\\b(${TOKEN_PREFIXES.join('|')})_[A-Za-z0-9]{30,}`, 'g');

// Folders that are never committed (and are big): skipped when git isn't available.
const NEVER_COMMITTED = new Set(['.git', 'node_modules', 'data']);
const NEVER_COMMITTED_FILES = new Set(['config.json', '.env']);

function filesGitWouldCommit() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter(Boolean);
  } catch {
    // No git (e.g. the app was downloaded as a zip): look at everything that
    // .gitignore would keep out anyway.
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!NEVER_COMMITTED.has(entry.name)) walk(rel);
        } else if (!NEVER_COMMITTED_FILES.has(rel)) {
          found.push(rel);
        }
      }
    };
    walk('');
    return found;
  }
}

function findTokens(text) {
  return [...text.matchAll(TOKEN_PATTERN)].map((m) => `${m[0].slice(0, 8)}…`);
}

test('no Notion token in any file git would commit', () => {
  const problems = [];
  for (const rel of filesGitWouldCommit()) {
    const abs = path.join(ROOT, rel);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // deleted since git listed it
    }
    for (const token of findTokens(text)) problems.push(`${rel}: ${token}`);
  }
  assert.deepEqual(
    problems,
    [],
    `A Notion token is in a file that would be committed. Move it to config.json (ignored by git), and if it was ` +
      `ever pushed, regenerate it in Notion:\n${problems.join('\n')}`,
  );
});

test('config.json (where your token lives) is ignored by git, and the example has an empty placeholder', () => {
  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((line) => line.trim());
  assert.ok(ignored.includes('config.json'), '.gitignore must list config.json');
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.equal(example.notion.token, '', 'config.example.json keeps "token": "" — the real one goes in config.json');
});

test('the guard recognizes token-looking strings', () => {
  const fake = (prefix) => `${prefix}_${'a1B2c3D4e5'.repeat(4)}`;
  assert.equal(findTokens(`"token": "${fake('ntn')}"`).length, 1);
  assert.equal(findTokens(`auth: '${fake('secret')}'`).length, 1);
  assert.deepEqual(findTokens('"token": ""'), []);
  assert.deepEqual(findTokens('the secret_sauce of a good edit'), []);
});
