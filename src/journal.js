// The day book: what Claude did today, per session and per project, kept in one small file per
// day so a restart keeps the day. Pure apart from the injected file system and clock.

const fs = require('node:fs');
const path = require('node:path');

const MIN = 60 * 1000;
const DAY_MS = 24 * 60 * MIN;
// Time between two looks at the board counts at most this much, so a sleep or a stall never does.
const STEP_CAP_MS = 10 * 1000;
// The day's file is written at most this often (unless forced).
const FLUSH_MS = 60 * 1000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
// What the day book adds up from each row: Claude Code's counts, all cumulative.
const COUNTS = ['turns', 'usd', 'tokens', 'linesAdded', 'linesRemoved'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
// A reading of a cumulative count: a real number, never below 0; null when there is none.
const reading = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null);

/** The local calendar day of a time, YYYY-MM-DD (the day book's day ends at your midnight). */
function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** '4 h 12 min', '12 min', or '< 1 min'. */
function formatDuration(ms) {
  const min = Math.floor(count(ms) / MIN);
  if (min < 1) return '< 1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${pad(min % 60)} min`;
}

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A whole number with thousands separated: 1,204. */
function formatCount(n) {
  return group(String(Math.round(count(n))));
}

/** '$26.40'. */
function formatUsd(n) {
  const [whole, cents] = count(n).toFixed(2).split('.');
  return `$${group(whole)}.${cents}`;
}

/** '30.1M', '249k' or '126'. */
function formatTokens(n) {
  const v = count(n);
  // Cut over where rounding would otherwise give 1000k.
  if (v >= 999500) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 999.5) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
}

/** 'claude-opus-5-5' as people say it: 'Opus 5.5' ('claude-opus-5[1m]': 'Opus 5 1M'). Others as they are. */
function modelLabel(model) {
  const m = /^claude-([a-z]+)-(\d+(?:-\d{1,2})*)(?:-\d{8})?(\[1m\])?$/i.exec(str(model));
  if (!m) return str(model);
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-/g, '.')}${m[3] ? ' 1M' : ''}`;
}

/** 'Wed 5 Nov 2026' for a day key. */
function dayTitle(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

function newEntry(id, now) {
  return {
    id, title: '', project: '', model: '', effort: '', lastState: '',
    workingMs: 0, waitingMs: 0, firstSeen: now, lastSeen: now, touched: false,
    // acc: what each count grew by today; last: its latest reading (null until one is seen).
    acc: Object.fromEntries(COUNTS.map((k) => [k, 0])),
    last: Object.fromEntries(COUNTS.map((k) => [k, null])),
  };
}

/** An entry from the day's file, type-checked, or null when it isn't one. */
function cleanEntry(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const e = newEntry(raw.id, count(raw.firstSeen));
  for (const k of ['title', 'project', 'model', 'effort', 'lastState']) e[k] = str(raw[k]);
  for (const k of ['workingMs', 'waitingMs', 'lastSeen']) e[k] = count(raw[k]);
  e.touched = raw.touched === true;
  const acc = isObject(raw.acc) ? raw.acc : {};
  const last = isObject(raw.last) ? raw.last : {};
  for (const k of COUNTS) {
    e.acc[k] = count(acc[k]);
    e.last[k] = reading(last[k]);
  }
  return e;
}

/**
 * Adds what a cumulative count grew by since its last reading. The first reading of the day is
 * the starting point; a count that went down started again from nothing, so all of it is new.
 */
function accrue(e, key, value) {
  if (value === null) return;
  const was = e.last[key];
  if (was !== null) e.acc[key] += value >= was ? value - was : value;
  e.last[key] = value;
}

/** Whether a session did anything today worth a line in the day book. */
function counts(e) {
  return e.touched || e.workingMs > 0 || e.waitingMs > 0 || COUNTS.some((k) => e.acc[k] > 0);
}

/** Lines of text columns, each but the last padded to line up. */
function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => `  ${r.map((c, i) => (i < r.length - 1 ? c.padEnd(widths[i] + 3) : c)).join('')}`);
}

class Journal {
  /**
   * @param {{dir: string, fsImpl?: typeof fs, now?: () => number, dayKey?: (ms: number) => string,
   *   keepDays?: number}} opts  dir: where the day files go; keepDays: how many days are kept
   */
  constructor({ dir, fsImpl = fs, now = Date.now, dayKey = localDayKey, keepDays = 30 }) {
    this.dir = dir;
    this.fs = fsImpl;
    this.now = now;
    this.dayKey = dayKey;
    this.keepDays = keepDays;
    this.day = '';
    this.sessions = new Map(); // id -> entry
    this.lastAt = null; // when observe last ran
    this.flushedAt = -Infinity;
    this.dirty = false;
    this.lastError = null; // the last write that failed, for main to report
  }

  file(day) {
    return path.join(this.dir, `${day}.json`);
  }

  /** Counts the time since the last look against each session's state. `rows`: as read, before quieting. */
  observe(rows, now = this.now()) {
    const day = this.dayKey(now);
    if (day !== this.day) {
      // Midnight: the old day is written out, and the new one starts (from its file, should the
      // clock have gone back into a day already kept).
      if (this.day) this.flush(now, { force: true });
      this.load(now);
    }
    const step = this.lastAt === null ? 0 : Math.min(STEP_CAP_MS, Math.max(0, now - this.lastAt));
    this.lastAt = now;
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id) continue;
      let e = this.sessions.get(row.id);
      if (!e) this.sessions.set(row.id, (e = newEntry(row.id, now)));
      this.update(e, row, step, now, day);
    }
    this.dirty = true;
  }

  update(e, row, step, now, day) {
    e.title = str(row.title);
    e.project = str(row.project);
    e.model = str(row.model);
    e.effort = str(row.effort);
    e.lastState = str(row.state);
    e.lastSeen = now;
    if (row.state === 'working') e.workingMs += step;
    if (row.state === 'needs-you') e.waitingMs += step;
    // Active today even if Wilfred only saw it after it finished.
    if (this.dayKey(row.lastActivityAt) === day) e.touched = true;
    accrue(e, 'turns', reading(row.completedTurns));
    const cost = isObject(row.cost) ? row.cost : null;
    for (const k of COUNTS.slice(1)) accrue(e, k, cost ? reading(cost[k]) : null);
  }

  /** Today's day book: per session, per project, and in all. */
  today(now = this.now()) {
    const day = this.dayKey(now);
    const entries = day === this.day ? [...this.sessions.values()].filter(counts) : [];
    const sessions = entries
      .map((e) => ({
        id: e.id, title: e.title, project: e.project, model: e.model, effort: e.effort,
        workingMs: e.workingMs, waitingMs: e.waitingMs, ...e.acc,
        lastState: e.lastState, firstSeen: e.firstSeen, lastSeen: e.lastSeen,
      }))
      .sort((a, b) => b.workingMs - a.workingMs || b.lastSeen - a.lastSeen);
    return { day, sessions, projects: byProject(sessions), totals: totalsOf(sessions) };
  }

  /** The day book as plain text, for the clipboard. */
  text(now = this.now()) {
    const t = this.today(now);
    const lines = [`Wilfred's day book, ${dayTitle(t.day)}`];
    if (!t.sessions.length) return [...lines, 'Nothing yet today.'].join('\n');
    lines.push(workedLine(t.totals));
    const more = moreLine(t.totals);
    if (more) lines.push(more);
    lines.push('', 'By project', ...table(t.projects.map((p) => [p.project, formatDuration(p.workingMs), plural(p.sessions, 'session'), plural(p.turns, 'turn')])));
    lines.push('', 'Sessions', ...table(t.sessions.map((s) => [s.project ? `${s.title} (${s.project})` : s.title, sessionParts(s)])));
    return lines.join('\n');
  }

  /**
   * Writes the day's file (through a temp file and a rename, so a crash can't leave half of it),
   * at most once a minute unless forced. Never throws: a failed write is kept in lastError and
   * tried again a minute later. Returns whether it wrote.
   */
  flush(now = this.now(), { force = false } = {}) {
    if (!this.day || !this.dirty) return false;
    if (!force && now >= this.flushedAt && now - this.flushedAt < FLUSH_MS) return false;
    this.flushedAt = now;
    const file = this.file(this.day);
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      this.fs.writeFileSync(`${file}.tmp`, JSON.stringify({ day: this.day, sessions: [...this.sessions.values()] }));
      this.fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      this.lastError = e;
      return false;
    }
    this.dirty = false;
    return true;
  }

  /** Starts the day from its file, when there is a good one (a restart keeps the day). Returns whether it did. */
  load(now = this.now()) {
    const day = this.dayKey(now);
    this.day = day;
    this.sessions = new Map();
    this.dirty = false;
    let data;
    try {
      data = JSON.parse(this.fs.readFileSync(this.file(day), 'utf8'));
    } catch {
      return false; // no file yet, or unreadable: a fresh day
    }
    if (!isObject(data) || data.day !== day || !Array.isArray(data.sessions)) return false;
    for (const raw of data.sessions) {
      const e = cleanEntry(raw);
      if (e) this.sessions.set(e.id, e);
    }
    return true;
  }

  /** Deletes day files older than keepDays. Returns how many it deleted. */
  prune(now = this.now()) {
    const cutoff = this.dayKey(now - this.keepDays * DAY_MS);
    let names;
    try {
      names = this.fs.readdirSync(this.dir);
    } catch {
      return 0; // no folder yet
    }
    let deleted = 0;
    for (const name of names) {
      const m = DAY_FILE.exec(name);
      if (!m || m[1] >= cutoff) continue;
      try {
        this.fs.unlinkSync(path.join(this.dir, name));
        deleted++;
      } catch {
        // in use or already gone: tried again next time
      }
    }
    return deleted;
  }
}

function byProject(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const name = s.project || '(no project)';
    if (!map.has(name)) map.set(name, { project: name, workingMs: 0, waitingMs: 0, sessions: 0, turns: 0 });
    const p = map.get(name);
    p.workingMs += s.workingMs;
    p.waitingMs += s.waitingMs;
    p.sessions++;
    p.turns += s.turns;
  }
  return [...map.values()].sort((a, b) => b.workingMs - a.workingMs || a.project.localeCompare(b.project));
}

function totalsOf(sessions) {
  const sum = (k) => sessions.reduce((n, s) => n + s[k], 0);
  const inState = (...states) => sessions.filter((s) => states.includes(s.lastState)).length;
  return {
    sessions: sessions.length,
    workingMs: sum('workingMs'),
    waitingMs: sum('waitingMs'),
    turns: sum('turns'),
    usd: sum('usd'),
    tokens: sum('tokens'),
    linesAdded: sum('linesAdded'),
    linesRemoved: sum('linesRemoved'),
    // A finished session counts as done whether or not you have looked at it yet.
    done: inState('idle', 'new'),
    needsYou: inState('needs-you'),
    failed: inState('failed'),
  };
}

function workedLine(t) {
  const states = [];
  if (t.done) states.push(`${t.done} done`);
  if (t.needsYou) states.push(`${t.needsYou} ${t.needsYou === 1 ? 'needs' : 'need'} you`);
  if (t.failed) states.push(`${t.failed} failed`);
  const tail = states.length ? `; ${states.join(', ')}` : '';
  return `Claude worked ${formatDuration(t.workingMs)} across ${plural(t.sessions, 'session')}${tail}.`;
}

function moreLine(t) {
  const parts = [];
  if (t.waitingMs > 0) parts.push(`Sessions waited for you ${formatDuration(t.waitingMs)} in all.`);
  if (t.linesAdded || t.linesRemoved) parts.push(`${plural(t.linesAdded, 'line')} added, ${formatCount(t.linesRemoved)} removed.`);
  if (t.usd > 0) parts.push(`≈ ${formatUsd(t.usd)} at API prices.`);
  return parts.join(' ');
}

function sessionParts(s) {
  const parts = [`working ${formatDuration(s.workingMs)}`];
  if (s.waitingMs > 0) parts.push(`waited ${formatDuration(s.waitingMs)}`);
  if (s.turns > 0) parts.push(plural(s.turns, 'turn'));
  if (s.linesAdded || s.linesRemoved) parts.push(`+${formatCount(s.linesAdded)} −${formatCount(s.linesRemoved)}`);
  if (s.usd > 0) parts.push(`≈ ${formatUsd(s.usd)}`);
  const runsOn = [modelLabel(s.model), s.effort].filter(Boolean).join(' ');
  if (runsOn) parts.push(runsOn);
  return parts.join(' · ');
}

module.exports = { Journal, localDayKey, formatDuration, formatUsd, formatTokens, formatCount, modelLabel, dayTitle };
