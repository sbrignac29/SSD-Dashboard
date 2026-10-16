'use strict';

// Shared by the pages: talking to the server, formatting numbers and
// dates, the Notion status line, the theme button, the size chart and the
// folder tree.
//
// This file runs in the BROWSER, not in Node. It can't see the drives or the
// database: everything it shows comes from the server's /api/ routes, fetched
// with api() below.

const Dashboard = (() => {
  // --- Talking to the server ------------------------------------------------

  // Asks the server for something and returns the answer (JSON, turned back
  // into objects). GET reads; POST asks the server to do something, and always
  // sends JSON (the server refuses POSTs that don't, see server.js).
  //   body  – what to send with a POST, e.g. { projectIds: [12], action: 'none' }
  //   allow – HTTP statuses that aren't errors for this call, e.g. [409]
  //   body  – what a POST sends (turned into JSON text); {} if left out
  async function api(path, { method = 'GET', allow = [], body: sent = {} } = {}) {
    const options = { method, headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(sent);
    }
    let response;
    try {
      response = await fetch(path, options);
    } catch {
      throw new Error("Can't reach the dashboard. Is `npm start` still running in Terminal?");
    }
    let answer = null;
    try {
      answer = await response.json();
    } catch {
      // Not JSON; handled below.
    }
    if (response.ok || allow.includes(response.status)) return answer;
    throw new Error(answer?.error ?? answer?.message ?? `The server answered ${response.status}.`);
  }

  // --- Formatting -------------------------------------------------------------

  // Decimal units, like Finder: 1 GB = 1,000,000,000 bytes.
  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return '—';
    if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
    if (bytes >= 1e11) return `${Math.round(bytes / 1e9)} GB`;
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
    return '0 GB';
  }

  // Rounded down, so "90%" never shows while it's really 89.7% (and the 90%
  // warning, rightly, hasn't appeared).
  function formatPercent(percent) {
    return percent === null || percent === undefined ? '—' : `${Math.floor(percent)}%`;
  }

  function formatCount(n) {
    return Number(n ?? 0).toLocaleString('en-US');
  }

  function plural(n, word, pluralWord = `${word}s`) {
    return `${formatCount(n)} ${n === 1 ? word : pluralWord}`;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  // "today", "yesterday", "3 days ago", "2 months ago".
  function formatAgo(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    const now = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(then)) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 45) return `${days} days ago`;
    const months = Math.round(days / 30.4);
    if (months < 18) return `${months} month${months === 1 ? '' : 's'} ago`;
    return `${Math.round(days / 365)} years ago`;
  }

  const TAG_ICONS = { ready: '✓', check: '!', keep: '•', pinned: '📌' };

  // How full a drive meter looks: blue, then amber near the limit, red past it.
  function meterLevel(percent, limit = 90) {
    if (percent >= limit) return 'is-critical';
    if (percent >= limit - 10) return 'is-warning';
    return '';
  }

  // The second half of the "Notion: ..." line, from GET /api/notion: when it
  // last synced, or why it's not connected (and that saved statuses are in use).
  function notionDetail(notion) {
    if (!notion) return '';
    if (notion.syncing) return 'Reading Notion…';
    const synced = notion.lastSync ? `last synced ${formatDateTime(notion.lastSync.at)} (${formatAgo(notion.lastSync.at)})` : '';
    if (notion.connected) return `${synced} · ${plural(notion.pageCount, 'page')}`;
    const saved = notion.usingSavedStatuses ? ` Using the statuses from the ${synced}.` : '';
    return `${notion.detail ?? ''}${saved}`;
  }

  // --- Moves (Phase 5) --------------------------------------------------------

  // "about 7 min left", from VeriCopy's estimate (null while it warms up).
  function formatTimeLeft(seconds) {
    if (seconds === null || seconds === undefined) return 'working out the time left…';
    if (seconds < 60) return 'less than a minute left';
    if (seconds < 3600) return `about ${Math.round(seconds / 60)} min left`;
    const hours = Math.floor(seconds / 3600);
    return `about ${hours} h ${Math.round((seconds % 3600) / 60)} min left`;
  }

  function formatProgress(percent) {
    return percent === null || percent === undefined ? '—' : `${Math.floor(percent)}%`;
  }

  // The marks in front of each pre-check.
  const CHECK_MARKS = { pass: '✓', fail: '✗', warn: '!', info: 'i', na: '–' };
  const CHECK_WORDS = { pass: 'OK', fail: 'Problem', warn: 'Warning', info: 'Note', na: "Doesn't apply" };

  // Asks `load` again and again: every 2 seconds while `isActive()` says a
  // move is running, every 10 seconds otherwise (to notice a move started on
  // another page). This is "polling": the page asks the dashboard's server,
  // which asks VeriCopy (the page never talks to VeriCopy itself).
  // Returns a function that stops it.
  function poll(load, isActive) {
    let timer = null;
    let stopped = false;
    async function round() {
      try {
        await load();
      } catch {
        // The page shows its own error; keep trying.
      }
      if (!stopped) timer = setTimeout(round, isActive() ? 2000 : 10000);
    }
    timer = setTimeout(round, isActive() ? 2000 : 10000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  // The helpers every page's Alpine component gets, so the HTML can call them
  // (e.g. x-text="formatBytes(p.sizeBytes)").
  const helpers = {
    formatTimeLeft,
    formatProgress,
    CHECK_MARKS,
    CHECK_WORDS,
    formatBytes,
    formatPercent,
    formatCount,
    plural,
    formatDate,
    formatDateTime,
    formatAgo,
    meterLevel,
    notionDetail,
    TAG_ICONS,
  };

  // --- Theme: Auto (follow the Mac), Light, Dark ------------------------------

  const THEMES = ['auto', 'light', 'dark'];
  const THEME_LABELS = { auto: 'Theme: Auto', light: 'Theme: Light', dark: 'Theme: Dark' };

  function savedTheme() {
    try {
      const theme = localStorage.getItem('theme');
      return THEMES.includes(theme) ? theme : 'auto';
    } catch {
      return 'auto'; // private window, or storage blocked
    }
  }

  function applyTheme(theme) {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    const button = document.querySelector('[data-theme-button]');
    if (button) button.textContent = THEME_LABELS[theme];
    window.dispatchEvent(new Event('themechange'));
  }

  function cycleTheme() {
    const next = THEMES[(THEMES.indexOf(savedTheme()) + 1) % THEMES.length];
    try {
      localStorage.setItem('theme', next);
    } catch {
      // Not saved; it still applies to this page.
    }
    applyTheme(next);
  }

  // Calls `redraw` whenever the colors change (the button, or the Mac
  // switching between light and dark), so charts can repaint.
  function onThemeChange(redraw) {
    window.addEventListener('themechange', redraw);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
  }

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('[data-theme-button]');
    if (button) {
      button.textContent = THEME_LABELS[savedTheme()];
      button.addEventListener('click', cycleTheme);
    }
  });

  // --- The size breakdown chart (Chart.js) ------------------------------------

  const TYPES = [
    ['raw', 'Raw footage'],
    ['proxy', 'Proxies'],
    ['cache', 'Cache'],
    ['export', 'Exports'],
    ['project', 'Project files'],
    ['other', 'Other'],
  ];

  // The rows behind the chart (also shown as the "Show the numbers" table).
  function sizeRows(byType) {
    const total = TYPES.reduce((sum, [type]) => sum + (byType?.[type] ?? 0), 0);
    return TYPES.map(([type, label]) => ({
      type,
      label,
      bytes: byType?.[type] ?? 0,
      percent: total > 0 ? ((byType?.[type] ?? 0) / total) * 100 : 0,
    }));
  }

  // Draws each bar's size just past its end ("412 GB"), so nobody has to
  // hover to read it.
  const valueLabels = {
    id: 'valueLabels',
    afterDatasetsDraw(chart, args, options) {
      const { ctx } = chart;
      ctx.save();
      ctx.fillStyle = options.color;
      ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      chart.getDatasetMeta(0).data.forEach((bar, i) => {
        ctx.fillText(options.labels[i], bar.x + 8, bar.y);
      });
      ctx.restore();
    },
  };

  // Chart objects live outside Alpine's data, because Alpine would wrap them
  // (to watch for changes) and Chart.js doesn't like that.
  const charts = new WeakMap();

  // One horizontal bar per file type, in a single color (the bars show
  // sizes; the labels say which type each is).
  function renderSizeChart(canvas, byType) {
    if (!canvas || typeof Chart === 'undefined') return;
    charts.get(canvas)?.destroy();
    const rows = sizeRows(byType);
    const largest = Math.max(...rows.map((r) => r.bytes));
    const [unit, divisor] = largest >= 1e12 ? ['TB', 1e12] : largest >= 1e9 ? ['GB', 1e9] : ['MB', 1e6];
    const box = canvas.parentElement;
    box.style.height = `${rows.length * 38 + 34}px`;
    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map((r) => r.label),
        datasets: [
          {
            data: rows.map((r) => r.bytes / divisor),
            backgroundColor: token('--series-1'),
            borderRadius: 4,
            borderSkipped: 'start', // rounded at the end, square at the baseline
            maxBarThickness: 22,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: { padding: { right: 72 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            callbacks: {
              label: (context) => `${formatBytes(rows[context.dataIndex].bytes)} · ${rows[context.dataIndex].percent.toFixed(0)}%`,
            },
          },
          valueLabels: { labels: rows.map((r) => formatBytes(r.bytes)), color: token('--text-2') },
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: token('--grid') },
            border: { color: token('--axis') },
            ticks: { color: token('--muted'), callback: (value) => `${value} ${unit}`, maxTicksLimit: 6 },
          },
          y: {
            grid: { display: false },
            border: { color: token('--axis') },
            ticks: { color: token('--text-2') },
          },
        },
      },
      plugins: [valueLabels],
    });
    charts.set(canvas, chart);
  }

  // --- The folder tree (project page) ------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    // textContent (not innerHTML): folder names are shown exactly as written,
    // never treated as code.
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function treeRow({ name, sizeBytes, fileCount, totalBytes, hasChildren, isOther }) {
    const row = el('div', `tree-row${isOther ? ' tree-other' : ''}`);
    row.append(el('span', 'tree-toggle', hasChildren ? '▶' : ''));
    const label = el('span', 'tree-name', name);
    if (fileCount !== undefined) label.append(el('span', 'tree-files', plural(fileCount, 'file')));
    row.append(label);
    const bar = el('span', 'tree-bar');
    const fill = el('span');
    fill.style.width = `${totalBytes > 0 ? (sizeBytes / totalBytes) * 100 : 0}%`;
    bar.append(fill);
    row.append(bar, el('span', 'tree-size', formatBytes(sizeBytes)));
    return row;
  }

  // Fills `container` with the tree from /api/projects/:id: biggest folders
  // first; click a folder to open it. The first level is shown open.
  function renderFolderTree(container, tree, totalBytes) {
    if (!container) return;
    container.replaceChildren();
    const build = (folders, otherBytes, otherLabel) => {
      const list = el('ul', 'tree');
      for (const folder of folders) {
        const item = el('li');
        const row = treeRow({ ...folder, totalBytes, hasChildren: folder.children.length > 0 });
        if (folder.children.length > 0) {
          const details = el('details');
          const summary = el('summary');
          summary.append(row);
          details.append(summary, build(folder.children, folder.otherBytes, 'Other files in this folder'));
          item.append(details);
        } else {
          item.append(row);
        }
        list.append(item);
      }
      if (otherBytes > 0) {
        const item = el('li');
        item.append(treeRow({ name: otherLabel, sizeBytes: otherBytes, totalBytes, isOther: true }));
        list.append(item);
      }
      return list;
    };
    if (tree.folders.length === 0) {
      container.append(el('p', 'muted', 'No subfolders: everything is directly in the project folder.'));
      return;
    }
    container.append(build(tree.folders, tree.otherBytes, 'Files directly in the project folder'));
  }

  return { api, helpers, ...helpers, poll, renderSizeChart, sizeRows, renderFolderTree, onThemeChange, cycleTheme };
})();
