const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const J = require('../src/journal');

const MIN = 60 * 1000;
// Fixed local times, so the day book's days are the machine's own whatever its time zone.
const T0 = new Date(2026, 10, 5, 9, 0, 0).getTime();
const YESTERDAY = new Date(2026, 10, 4, 18, 0, 0).getTime();

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wilfred-journal-'));
const row = (id, state, extra = {}) => ({ id, title: id, project: '', state, lastActivityAt: T0, completedTurns: 0, cost: null, ...extra });

// A journal on a temp folder with a clock the test moves.
function journal(opts = {}) {
  const dir = opts.dir || tmpdir();
  const clock = { now: T0 };
  const j = new J.Journal({ dir, now: () => clock.now, ...opts });
  // Looks at the board every 10 s for `minutes`, as main does (more often, but capped the same).
  const phase = (minutes, rows) => {
    for (let i = 0; i < minutes * 6; i++) {
      clock.now += 10e3;
      j.observe(typeof rows === 'function' ? rows() : rows);
    }
  };
  return { j, dir, clock, phase, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('localDayKey is the local calendar day, morning and last minute alike', () => {
  assert.equal(J.localDayKey(new Date(2026, 10, 5, 8, 0).getTime()), '2026-11-05');
  assert.equal(J.localDayKey(new Date(2026, 10, 5, 23, 59).getTime()), '2026-11-05');
  assert.equal(J.localDayKey(new Date(2026, 10, 6, 0, 0).getTime()), '2026-11-06');
  assert.equal(J.localDayKey(new Date(2026, 0, 2, 12, 0).getTime()), '2026-01-02');
});

test('formatDuration, formatUsd, formatCount and formatTokens', () => {
  const d = [[0, '< 1 min'], [59e3, '< 1 min'], [12 * MIN, '12 min'], [59 * MIN + 59e3, '59 min'], [60 * MIN, '1 h 00 min'],
    [125 * MIN, '2 h 05 min'], [252 * MIN, '4 h 12 min'], [NaN, '< 1 min'], [-5 * MIN, '< 1 min']];
  for (const [ms, want] of d) assert.equal(J.formatDuration(ms), want, String(ms));
  assert.equal(J.formatUsd(26.4), '$26.40');
  assert.equal(J.formatUsd(1234.5), '$1,234.50');
  for (const bad of [NaN, -1, undefined, '5']) assert.equal(J.formatUsd(bad), '$0.00', String(bad));
  assert.equal(J.formatCount(1204), '1,204');
  assert.equal(J.formatCount(1234567.4), '1,234,567');
  const t = [[126, '126'], [999, '999'], [999.6, '1k'], [249000, '249k'], [999499, '999k'], [999500, '1.0M'], [30065123, '30.1M'], [NaN, '0']];
  for (const [n, want] of t) assert.equal(J.formatTokens(n), want, String(n));
});

test('modelLabel and dayTitle say the model and the day as people do', () => {
  assert.equal(J.modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(J.modelLabel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(J.modelLabel('claude-opus-5[1m]'), 'Opus 5 1M');
  assert.equal(J.modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(J.modelLabel('some-other-model'), 'some-other-model');
  assert.equal(J.modelLabel(''), '');
  assert.equal(J.modelLabel(5), '');
  assert.equal(J.dayTitle('2026-11-05'), 'Thu 5 Nov 2026');
  assert.equal(J.dayTitle('2026-01-31'), 'Sat 31 Jan 2026');
  assert.equal(J.dayTitle('someday'), 'someday');
});

test('time counts against the state the session is in, at most 10 s per look', () => {
  const { j, clock, phase, cleanup } = journal();
  j.observe([row('a', 'working'), row('b', 'needs-you'), row('c', 'idle')]);
  phase(3, [row('a', 'working'), row('b', 'needs-you'), row('c', 'idle')]);
  // A sleep of an hour between two looks counts 10 s; a clock set back counts nothing.
  clock.now += 60 * MIN;
  j.observe([row('a', 'working'), row('b', 'needs-you'), row('c', 'idle')]);
  clock.now -= 5 * MIN;
  j.observe([row('a', 'working'), row('b', 'needs-you'), row('c', 'idle')]);
  const s = Object.fromEntries(j.today().sessions.map((x) => [x.id, x]));
  assert.equal(s.a.workingMs, 3 * MIN + 10e3);
  assert.equal(s.a.waitingMs, 0);
  assert.equal(s.b.waitingMs, 3 * MIN + 10e3);
  assert.equal(s.b.workingMs, 0);
  assert.equal(s.c.workingMs + s.c.waitingMs, 0);
  cleanup();
});

test('turns, cost, tokens and lines are what each grew by since first seen today', () => {
  const { j, clock, cleanup } = journal();
  const cost = (usd, tokens, linesAdded, linesRemoved) => ({ usd, tokens, linesAdded, linesRemoved, models: [] });
  const look = (extra) => { clock.now += 1000; j.observe([row('a', 'working', extra)]); };
  look({ completedTurns: 100, cost: cost(1, 1000, 10, 2) });
  look({ completedTurns: 104, cost: cost(3, 5000, 40, 2) });
  // No usage read this time (or junk): nothing changes, the next reading carries on.
  look({ completedTurns: 'many', cost: null });
  look({ completedTurns: 104, cost: 'lots' });
  look({ completedTurns: 104, cost: { usd: NaN } });
  look({ completedTurns: 106, cost: cost(4, 6000, 50, 5) });
  let a = j.today().sessions[0];
  assert.deepEqual([a.turns, a.usd, a.tokens, a.linesAdded, a.linesRemoved], [6, 3, 5000, 40, 3]);
  // A count that went down started again from nothing (a new CLI session): all of it is new.
  look({ completedTurns: 106, cost: cost(0.5, 100, 1, 0) });
  a = j.today().sessions[0];
  assert.deepEqual([a.usd, a.tokens, a.linesAdded, a.linesRemoved], [3.5, 5100, 41, 3]);
  cleanup();
});

test('today lists only sessions that did something today, by project and in all', () => {
  const { j, phase, cleanup } = journal();
  const rows = (states) => [
    row('a', states[0], { title: 'Billing API', project: 'billing-api', model: 'claude-opus-5-5', effort: 'high' }),
    row('b', states[1], { title: 'Docs', project: 'docs-site' }),
    row('c', 'idle', { title: 'Old', lastActivityAt: YESTERDAY }),
    row('d', 'idle', { title: 'Notes' }),
    row('e', states[2], { title: 'Nightly', project: 'billing-api' }),
  ];
  j.observe(rows(['working', 'working', 'working']));
  phase(30, rows(['working', 'working', 'working']));
  phase(10, rows(['working', 'idle', 'failed']));
  phase(5, rows(['new', 'needs-you', 'failed']));
  const t = j.today();
  assert.equal(t.day, '2026-11-05');
  assert.deepEqual(t.sessions.map((s) => s.id), ['a', 'b', 'e', 'd'], 'by time worked; the one idle since yesterday is left out');
  assert.deepEqual(t.sessions[0], {
    id: 'a', title: 'Billing API', project: 'billing-api', model: 'claude-opus-5-5', effort: 'high', workingMs: 40 * MIN, waitingMs: 0,
    turns: 0, usd: 0, tokens: 0, linesAdded: 0, linesRemoved: 0, lastState: 'new', firstSeen: T0, lastSeen: T0 + 45 * MIN,
  });
  assert.deepEqual(t.projects, [
    { project: 'billing-api', workingMs: 70 * MIN, waitingMs: 0, sessions: 2, turns: 0 },
    { project: 'docs-site', workingMs: 30 * MIN, waitingMs: 5 * MIN, sessions: 1, turns: 0 },
    { project: '(no project)', workingMs: 0, waitingMs: 0, sessions: 1, turns: 0 },
  ]);
  assert.deepEqual(t.totals, { sessions: 4, workingMs: 100 * MIN, waitingMs: 5 * MIN, turns: 0, usd: 0, tokens: 0, linesAdded: 0, linesRemoved: 0, done: 2, needsYou: 1, failed: 1 });
  // Projects with the same time are in name order; another day has nothing yet.
  assert.equal(j.today(T0 + 24 * 60 * MIN).sessions.length, 0);
  assert.equal(j.today(T0 + 24 * 60 * MIN).day, '2026-11-06');
  cleanup();
});

test('projects with equal time are listed by name; sessions with equal time by the latest seen', () => {
  const { j, clock, cleanup } = journal();
  j.observe([row('x', 'idle', { project: 'zeta' }), row('y', 'idle', { project: 'alpha' })]);
  clock.now += 1000;
  j.observe([row('y', 'idle', { project: 'alpha' })]);
  const t = j.today();
  assert.deepEqual(t.projects.map((p) => p.project), ['alpha', 'zeta']);
  assert.deepEqual(t.sessions.map((s) => s.id), ['y', 'x']);
  cleanup();
});

test('text: the day book as plain text for the clipboard', () => {
  const { j, clock, phase, cleanup } = journal();
  const a = (state, extra = {}) => row('a', state, { title: 'Billing API', project: 'billing-api', model: 'claude-opus-5-5', effort: 'high', completedTurns: 100, cost: { usd: 1, tokens: 1000, linesAdded: 10, linesRemoved: 2 }, ...extra });
  const b = (state, extra = {}) => row('b', state, { title: 'Docs', project: 'docs-site', model: 'claude-fable-5-1', completedTurns: 5, ...extra });
  const d = row('d', 'idle', { title: 'Notes' });
  j.observe([a('working'), b('working'), d]);
  phase(30, [a('working'), b('working'), d]);
  phase(38, [a('working'), b('idle'), d]);
  phase(12, [a('working'), b('needs-you'), d]);
  clock.now += 1000;
  j.observe([a('new', { completedTurns: 118, cost: { usd: 10.1, tokens: 250000, linesAdded: 320, linesRemoved: 14 } }), b('needs-you', { completedTurns: 6 }), d]);
  assert.equal(j.text(), [
    "Wilfred's day book, Thu 5 Nov 2026",
    'Claude worked 1 h 50 min across 3 sessions; 2 done, 1 needs you.',
    'Sessions waited for you 12 min in all. 310 lines added, 12 removed. ≈ $9.10 at API prices.',
    '',
    'By project',
    '  billing-api    1 h 20 min   1 session   18 turns',
    '  docs-site      30 min       1 session   1 turn',
    '  (no project)   < 1 min      1 session   0 turns',
    '',
    'Sessions',
    '  Billing API (billing-api)   working 1 h 20 min · 18 turns · +310 −12 · ≈ $9.10 · Opus 5.5 high',
    '  Docs (docs-site)            working 30 min · waited 12 min · 1 turn · Fable 5.1',
    '  Notes                       working < 1 min',
  ].join('\n'));
  cleanup();
});

test('text: the short forms, and an empty day', () => {
  const { j, phase, cleanup } = journal();
  assert.equal(j.text(), "Wilfred's day book, Thu 5 Nov 2026\nNothing yet today.");
  j.observe([row('a', 'working'), row('b', 'working'), row('c', 'working')]);
  phase(1, [row('a', 'working', { cost: { linesRemoved: 0 } }), row('b', 'working'), row('c', 'working')]);
  phase(1, [row('a', 'needs-you'), row('b', 'needs-you'), row('c', 'failed')]);
  const lines = j.text().split('\n');
  assert.equal(lines[1], 'Claude worked 3 min across 3 sessions; 2 need you, 1 failed.');
  assert.equal(lines[2], 'Sessions waited for you 2 min in all.');
  const still = journal();
  still.j.observe([row('a', 'working')]);
  still.phase(2, [row('a', 'working', { cost: { linesAdded: 1, linesRemoved: 0 } })]);
  still.phase(1, [row('a', 'working', { cost: { linesAdded: 2, linesRemoved: 0 } })]);
  const text = still.j.text().split('\n');
  assert.equal(text[1], 'Claude worked 3 min across 1 session.', 'nothing done, waiting or failed yet');
  assert.equal(text[2], '1 line added, 0 removed.');
  assert.match(text[text.length - 1], /working 3 min · \+1 −0$/);
  // With nothing but time worked, no second line at all.
  const plain = journal();
  plain.j.observe([row('a', 'working')]);
  plain.phase(1, [row('a', 'working')]);
  assert.equal(plain.j.text().split('\n')[2], '');
  for (const x of [still, plain]) x.cleanup();
  cleanup();
});

test('flush writes the day through a temp file, at most once a minute unless forced', () => {
  const { j, dir, clock, cleanup } = journal();
  assert.equal(j.flush(), false, 'nothing to write before the first look');
  j.observe([row('a', 'working', { title: 'Billing API' })]);
  assert.equal(j.flush(), true);
  assert.deepEqual(fs.readdirSync(dir), ['2026-11-05.json']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '2026-11-05.json'), 'utf8'));
  assert.equal(saved.day, '2026-11-05');
  assert.equal(saved.sessions[0].title, 'Billing API');
  assert.equal(j.flush(), false, 'nothing new since');
  clock.now += 10e3;
  j.observe([row('a', 'working')]);
  assert.equal(j.flush(), false, 'within the minute');
  assert.equal(j.flush(clock.now, { force: true }), true);
  j.observe([row('a', 'working')]);
  clock.now += 60e3;
  assert.equal(j.flush(), true, 'a minute on');
  // A clock set back doesn't hold the next write up.
  j.observe([row('a', 'working')]);
  assert.equal(j.flush(clock.now - 3600e3), true);
  cleanup();
});

test('a failed write never throws: it is kept in lastError and tried again a minute later', () => {
  const dir = path.join(os.tmpdir(), 'wilfred-journal-never-made');
  let failing = true;
  const writes = [];
  const fsImpl = {
    mkdirSync: () => {},
    writeFileSync: (f, text) => {
      if (failing) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      writes.push([f, text]);
    },
    renameSync: (from, to) => writes.push([from, to]),
  };
  const { j, clock } = journal({ dir, fsImpl });
  j.observe([row('a', 'working')]);
  assert.equal(j.flush(), false);
  assert.equal(j.lastError.code, 'EACCES');
  failing = false;
  clock.now += 30e3;
  assert.equal(j.flush(), false, 'not retried at once');
  clock.now += 30e3;
  assert.equal(j.flush(), true);
  const file = path.join(dir, '2026-11-05.json');
  assert.deepEqual(writes.map(([f]) => f), [`${file}.tmp`, `${file}.tmp`]);
  assert.equal(writes[1][1], file);
});

test('a restart keeps the day: load reads today\'s file and the counts carry on from it', () => {
  const first = journal();
  first.j.observe([row('a', 'working', { completedTurns: 10, cost: { usd: 1 } })]);
  first.phase(2, [row('a', 'working', { completedTurns: 12, cost: { usd: 2 } })]);
  first.j.flush(first.clock.now, { force: true });
  const again = journal({ dir: first.dir });
  again.clock.now = first.clock.now + 5 * MIN;
  assert.equal(again.j.load(), true);
  // While Wilfred was closed the session did two more turns; they count, the time away doesn't.
  again.j.observe([row('a', 'working', { completedTurns: 14, cost: { usd: 3 } })]);
  const a = again.j.today().sessions[0];
  assert.deepEqual([a.workingMs, a.turns, a.usd, a.firstSeen], [2 * MIN, 4, 2, T0]);
  first.cleanup();
});

test('load starts afresh from a missing, malformed or foreign file, and cleans what it keeps', () => {
  const { j, dir, cleanup } = journal();
  assert.equal(j.load(), false, 'no file yet');
  const file = path.join(dir, '2026-11-05.json');
  for (const text of ['{ broken', 'null', '[]', JSON.stringify({ day: '2026-11-04', sessions: [] }), JSON.stringify({ day: '2026-11-05', sessions: {} })]) {
    fs.writeFileSync(file, text);
    assert.equal(j.load(), false, text);
    assert.equal(j.today().sessions.length, 0);
  }
  fs.writeFileSync(file, JSON.stringify({
    day: '2026-11-05',
    sessions: [
      null, { id: '' }, { id: 5 }, 'x',
      { id: 'a', title: 5, project: 'p', workingMs: 'long', waitingMs: -3, lastSeen: Infinity, firstSeen: 7, touched: 'yes', acc: [], last: null },
      { id: 'b', touched: true, acc: { turns: 3, usd: 'x' }, last: { turns: 9, usd: 'x', tokens: NaN } },
    ],
  }));
  assert.equal(j.load(), true);
  assert.deepEqual([...j.sessions.keys()], ['a', 'b']);
  const a = j.sessions.get('a');
  assert.deepEqual([a.title, a.project, a.workingMs, a.waitingMs, a.lastSeen, a.firstSeen, a.touched], ['', 'p', 0, 0, 0, 7, false]);
  assert.deepEqual(a.acc, { turns: 0, usd: 0, tokens: 0, linesAdded: 0, linesRemoved: 0 });
  assert.deepEqual(a.last, { turns: null, usd: null, tokens: null, linesAdded: null, linesRemoved: null });
  const b = j.sessions.get('b');
  assert.deepEqual([b.touched, b.acc.turns, b.acc.usd, b.last.turns, b.last.usd], [true, 3, 0, 9, null]);
  // An unreadable file through the injected file system is a fresh day too.
  const locked = new J.Journal({ dir, now: () => T0, fsImpl: { readFileSync: () => { throw new Error('EBUSY'); } } });
  assert.equal(locked.load(), false);
  const garbled = new J.Journal({ dir, now: () => T0, fsImpl: { readFileSync: () => '{"day": "2026-11-05", "sess' } });
  assert.equal(garbled.load(), false);
  cleanup();
});

test('at local midnight the old day is written out and a fresh one starts', () => {
  const { j, dir, clock, cleanup } = journal();
  clock.now = new Date(2026, 10, 5, 23, 59, 50).getTime();
  j.observe([row('a', 'working', { completedTurns: 4 })]);
  clock.now += 5e3;
  j.observe([row('a', 'working', { completedTurns: 5 })]);
  clock.now += 15e3; // 00:00:10 on the 6th
  j.observe([row('a', 'working', { completedTurns: 6 })]);
  const old = JSON.parse(fs.readFileSync(path.join(dir, '2026-11-05.json'), 'utf8'));
  assert.equal(old.sessions[0].workingMs, 5e3);
  assert.equal(old.sessions[0].acc.turns, 1);
  const t = j.today();
  assert.equal(t.day, '2026-11-06');
  // The minute across midnight counts for the new day; its turns start from what it sees now.
  assert.deepEqual([t.sessions[0].workingMs, t.sessions[0].turns], [10e3, 0]);
  // A clock set back into a day already kept picks that day up again rather than overwrite it.
  clock.now = new Date(2026, 10, 5, 23, 59, 58).getTime();
  j.observe([row('a', 'working')]);
  assert.equal(j.today().sessions[0].workingMs, 5e3);
  cleanup();
});

test('prune deletes day files older than keepDays and nothing else', () => {
  const { j, dir, cleanup } = journal();
  for (const name of ['2026-10-05.json', '2026-10-06.json', '2026-11-05.json', '2025-01-01.json.tmp', 'notes.txt']) fs.writeFileSync(path.join(dir, name), '{}');
  assert.equal(j.prune(), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2025-01-01.json.tmp', '2026-10-06.json', '2026-11-05.json', 'notes.txt']);
  const short = new J.Journal({ dir, now: () => T0, keepDays: 1 });
  assert.equal(short.prune(), 1);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.json')), ['2026-11-05.json']);
  // No folder yet, or a file that won't go: nothing to do, no throw.
  assert.equal(new J.Journal({ dir: path.join(dir, 'missing'), now: () => T0 }).prune(), 0);
  const stuck = new J.Journal({ dir, now: () => T0, fsImpl: { readdirSync: () => ['2020-01-01.json'], unlinkSync: () => { throw new Error('EBUSY'); } } });
  assert.equal(stuck.prune(), 0);
  cleanup();
});

test('rows without an id are ignored; by default the real clock and local days are used', () => {
  const dir = tmpdir();
  const j = new J.Journal({ dir });
  j.observe([null, { state: 'working' }, { id: '', state: 'working' }, row('a', 'working', { lastActivityAt: Date.now() })]);
  const t = j.today();
  assert.equal(t.day, J.localDayKey(Date.now()));
  assert.deepEqual(t.sessions.map((s) => s.id), ['a']);
  assert.equal(j.flush(), true);
  assert.equal(j.load(), true);
  assert.equal(j.prune(), 0);
  assert.match(j.text(), /^Wilfred's day book, /);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('looks every 5 s credit the whole time: 12 looks over a minute are a minute', () => {
  const { j, clock, cleanup } = journal();
  j.observe([row('a', 'working')]);
  for (let i = 0; i < 12; i++) {
    clock.now += 5e3;
    j.observe([row('a', 'working')]);
  }
  assert.equal(j.today().sessions[0].workingMs, 60e3);
  cleanup();
});

test('a negative reading counts as 0, never as a loss', () => {
  const { j, clock, cleanup } = journal();
  j.observe([row('a', 'working', { completedTurns: -5, cost: { usd: -3, tokens: 10, linesAdded: 0, linesRemoved: -2 } })]);
  clock.now += 1000;
  j.observe([row('a', 'working', { completedTurns: 2, cost: { usd: 1, tokens: 10, linesAdded: 0, linesRemoved: 1 } })]);
  const a = j.today().sessions[0];
  // From 0, not from -5: a count can't have been below nothing.
  assert.deepEqual([a.turns, a.usd, a.linesRemoved], [2, 1, 1]);
  cleanup();
});
