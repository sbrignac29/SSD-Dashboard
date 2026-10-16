'use strict';

// Pulls an optional date and a "subject" out of a project folder name.
// Folder names on the drive vary a lot, so every part is optional:
//
//   "Parker Soccer 10-3"            -> subject "Parker Soccer", month 10, day 3
//   "Camping 2026"                  -> subject "Camping", year 2026
//   "2026-08-24 Next Elite - Drills"-> subject "Next Elite - Drills", 2026-08-24
//   "Veteran's Day Video"           -> subject "Veteran's Day Video", no date
//
// Short dates like "8-24" are read US-style (month-day). When the name has no
// year, `year` is null — we don't guess. Nothing here is used for scoring yet;
// it's for display now and for matching folders to Notion pages later.

// "Not touching another letter or digit", so "U12-14" or "1080p" don't count.
const EDGE_BEFORE = '(?<![A-Za-z0-9])';
const EDGE_AFTER = '(?![A-Za-z0-9])';
// Separators between date parts. ":" is included because when you type "/"
// in a Finder name, macOS actually stores it as ":".
const SEP = '[-_.:/]';

// Tried in this order; the first valid date found wins.
const DATE_PATTERNS = [
  {
    // 2026-08-24, 2026_08_24, 2026.8.24
    regex: new RegExp(`${EDGE_BEFORE}(20\\d{2})${SEP}(\\d{1,2})${SEP}(\\d{1,2})${EDGE_AFTER}`, 'g'),
    read: (m) => ({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }),
  },
  {
    // 20260824
    regex: new RegExp(`${EDGE_BEFORE}(20\\d{2})(\\d{2})(\\d{2})${EDGE_AFTER}`, 'g'),
    read: (m) => ({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }),
  },
  {
    // 8-24, 10-3, 6-12-25, 6.12.2025
    regex: new RegExp(`${EDGE_BEFORE}(\\d{1,2})${SEP}(\\d{1,2})(?:${SEP}(\\d{4}|\\d{2}))?${EDGE_AFTER}`, 'g'),
    read: (m) => ({
      year: m[3] === undefined ? null : m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]),
      month: Number(m[1]),
      day: Number(m[2]),
    }),
  },
  {
    // A year on its own: "Camping 2026"
    regex: new RegExp(`${EDGE_BEFORE}(20\\d{2})${EDGE_AFTER}`, 'g'),
    read: (m) => ({ year: Number(m[1]), month: null, day: null }),
  },
];

function isValidDate({ year, month, day }) {
  if (month === null) return year >= 2000 && year <= 2099;
  if (month < 1 || month > 12 || day < 1) return false;
  // Day 0 of the NEXT month is the last day of this month. 2024 is a leap
  // year, so Feb 29 is allowed when the name has no year.
  const daysInMonth = new Date(Date.UTC(year ?? 2024, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateLabel({ year, month, day }) {
  if (month === null) return String(year);
  if (year === null) return `${month}/${day}`;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function cleanSubject(text) {
  return text
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—.,:]+|[\s\-–—.,:]+$/g, '');
}

function parseProjectName(name) {
  const original = String(name);
  for (const pattern of DATE_PATTERNS) {
    for (const match of original.matchAll(pattern.regex)) {
      const date = pattern.read(match);
      if (!isValidDate(date)) continue;
      const before = original.slice(0, match.index);
      const after = original.slice(match.index + match[0].length);
      const subject = cleanSubject(`${before} ${after}`);
      return { subject: subject || null, dateLabel: dateLabel(date), ...date };
    }
  }
  return { subject: cleanSubject(original) || null, dateLabel: null, year: null, month: null, day: null };
}

// The name with EVERY date taken out ("Parker Soccer 10-3 to 10-5" -> "Parker
// Soccer to"). Used to match folders to Notion pages, where the date is
// usually written differently on each side (or only on one of them).
function removeDates(name) {
  let text = String(name);
  for (const pattern of DATE_PATTERNS) {
    text = text.replace(pattern.regex, (...match) => (isValidDate(pattern.read(match)) ? ' ' : match[0]));
  }
  return text;
}

module.exports = { parseProjectName, removeDates };
