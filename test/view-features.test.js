// The board's newer decisions: what a session runs on, families, watching, snoozing, the day book.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/renderer/view');
const { demoRows } = require('../src/demo');

const row = (state, extra = {}) => ({ id: `local_${state}-${Math.random().toString(16).slice(2, 8)}`, title: state, state, ...extra });
const NOW = Date.parse('2026-10-27T12:00:00Z');

// ---- what a session runs on ----

test('modelLabel turns a model id into a name and version', () => {
  assert.equal(V.modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(V.modelLabel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(V.modelLabel('claude-opus-5'), 'Opus 5');
  assert.equal(V.modelLabel('claude-opus-5[1m]'), 'Opus 5 (1M)');
  assert.equal(V.modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(V.modelLabel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(V.modelLabel('claude-3-haiku-20240307'), 'Haiku 3');
  assert.equal(V.modelLabel('claude-3-newfam-20240101'), 'Newfam 3');
  assert.equal(V.modelLabel('claude-newname-7-2'), 'Newname 7.2');
  assert.equal(V.modelLabel('claude-something-odd'), 'something-odd');
  assert.equal(V.modelLabel('gpt-x'), 'gpt-x');
  assert.equal(V.modelLabel(''), '');
  assert.equal(V.modelLabel(undefined), '');
});

test('effort and permission mode in words; bypassing every check is a warning', () => {
  assert.equal(V.effortLabel('max'), 'max');
  assert.equal(V.effortLabel('XHIGH'), 'extra high');
  assert.equal(V.effortLabel(''), '');
  assert.equal(V.effortLabel('odd'), '');
  assert.equal(V.modeLabel('default'), '');
  assert.equal(V.modeLabel('auto'), 'auto mode');
  assert.equal(V.modeLabel('acceptEdits'), 'accepts edits');
  assert.equal(V.modeLabel('plan'), 'plan mode');
  assert.equal(V.modeLabel('bypassPermissions'), 'no permission checks');
  assert.equal(V.modeLabel(undefined), '');
  assert.deepEqual(V.metaOf({ model: 'claude-opus-5-5', effort: 'high', permissionMode: 'auto' }), { model: 'Opus 5.5', effort: 'high', mode: 'auto mode', context: '', unguarded: false, filling: false, full: false, text: 'Opus 5.5 · high · auto mode' });
  assert.deepEqual(V.metaOf({ permissionMode: 'bypassPermissions' }), { model: '', effort: '', mode: 'no permission checks', context: '', unguarded: true, filling: false, full: false, text: 'no permission checks' });
  assert.deepEqual(V.metaOf({}), { model: '', effort: '', mode: '', context: '', unguarded: false, filling: false, full: false, text: '' });
});

test('numbers: durations, dollars, tokens', () => {
  assert.equal(V.fmtDuration(0), '< 1 min');
  assert.equal(V.fmtDuration(20_000), '< 1 min');
  assert.equal(V.fmtDuration(12 * 60_000), '12 min');
  assert.equal(V.fmtDuration(60 * 60_000), '1 h');
  assert.equal(V.fmtDuration(252 * 60_000), '4 h 12 min');
  assert.equal(V.fmtDuration(-5), '< 1 min');
  assert.equal(V.fmtDuration(undefined), '< 1 min');
  assert.equal(V.fmtUsd(26.4), '$26.40');
  assert.equal(V.fmtUsd(0.004), '< $0.01');
  assert.equal(V.fmtUsd(0), '$0');
  assert.equal(V.fmtUsd('x'), '$0');
  assert.equal(V.fmtTokens(30_065_123), '30.1M');
  assert.equal(V.fmtTokens(249_999), '250k');
  assert.equal(V.fmtTokens(126), '126');
  assert.equal(V.fmtTokens(-3), '0');
  assert.equal(V.fmtTokens(null), '0');
});

test('usage and facts lines', () => {
  assert.equal(V.usageLabel(null), '');
  assert.equal(V.usageLabel({ usd: 4.11, tokens: 9.7e6, linesAdded: 78, linesRemoved: 12 }), '≈ $4.11 at API prices · 9.7M tokens · +78 −12 lines');
  assert.equal(V.usageLabel({ usd: 0.5, tokens: 1200, linesAdded: 0, linesRemoved: 0 }), '≈ $0.50 at API prices · 1k tokens');
  assert.equal(V.usageLabel({ usd: 0.5, tokens: 1200, linesRemoved: 3 }), '≈ $0.50 at API prices · 1k tokens · +0 −3 lines');
  assert.equal(V.usageLabel({ usd: 0.5, tokens: 1200, linesAdded: 5 }), '≈ $0.50 at API prices · 1k tokens · +5 −0 lines');
  assert.equal(V.factsLabel({ branch: 'claude/x', cost: { usd: 1, tokens: 5, linesAdded: 0, linesRemoved: 0 } }), 'on claude/x · ≈ $1.00 at API prices · 5 tokens');
  assert.equal(V.factsLabel({ branch: 'claude/x', cost: null }), 'on claude/x');
  assert.equal(V.factsLabel({}), '');
});

// ---- families ----

test('families: side sessions nest one level under their parent, which keeps the family\'s place', () => {
  const parent = row('idle', { id: 'local_p', title: 'Parent' });
  const kid = row('needs-you', { id: 'local_k', title: 'Kid', parentId: 'local_p' });
  const other = row('working', { id: 'local_o' });
  // Sorted order puts the kid first (needs-you); its family takes that place, parent first.
  const out = V.families([kid, other, parent]);
  assert.deepEqual(out.map((f) => f.map((r) => [r.id, r.depth, r.kids])), [[['local_p', 0, 1], ['local_k', 1, 0]], [['local_o', 0, 0]]]);
  // A kid whose parent isn't in view stays a top-level row.
  assert.deepEqual(V.families([row('idle', { id: 'local_x', parentId: 'local_gone' })]).map((f) => f.map((r) => r.depth)), [[0]]);
  // Nesting off: every row on its own.
  assert.deepEqual(V.families([kid, parent], false).map((f) => f.map((r) => r.id)), [['local_k'], ['local_p']]);
  // One level only: a grandchild stays top-level, and a loop makes two top-level rows rather than losing both.
  const grand = row('idle', { id: 'local_g', parentId: 'local_k' });
  assert.deepEqual(V.families([parent, kid, grand]).map((f) => f.map((r) => r.id)), [['local_p', 'local_k'], ['local_g']]);
  const a = row('idle', { id: 'local_a', parentId: 'local_b' });
  const b = row('idle', { id: 'local_b', parentId: 'local_a' });
  assert.deepEqual(V.families([a, b]).map((f) => f.map((r) => r.id)), [['local_a'], ['local_b']]);
  // A parent whose own parent is out of view is still a parent.
  const mid = row('idle', { id: 'local_m', parentId: 'local_gone' });
  const leaf = row('idle', { id: 'local_l', parentId: 'local_m' });
  assert.deepEqual(V.families([mid, leaf]).map((f) => f.map((r) => r.id)), [['local_m', 'local_l']]);
  assert.deepEqual(V.families([row('idle', { id: 'local_s', parentId: 'local_s' })]).map((f) => f.length), [1]);
});

test('layout: busy families first, then a few idle ones; the rest are counted', () => {
  const parent = row('idle', { id: 'local_p' });
  const kid = row('working', { id: 'local_k', parentId: 'local_p' });
  const idle = Array.from({ length: 6 }, (_, i) => row('idle', { id: `local_i${i}` }));
  const { shown, hiddenIdle } = V.layout([kid, ...idle, parent], { maxIdle: 2 });
  assert.deepEqual(shown.map((r) => r.id), ['local_p', 'local_k', 'local_i0', 'local_i1']);
  assert.equal(hiddenIdle, 4);
  // An idle family hidden past the fold counts every member.
  const p2 = row('idle', { id: 'local_p2' });
  const k2 = row('idle', { id: 'local_k2', parentId: 'local_p2' });
  assert.equal(V.layout([...idle, p2, k2], { maxIdle: 1 }).hiddenIdle, 7);
  assert.deepEqual(V.layout([], {}), { shown: [], hiddenIdle: 0 });
  assert.equal(V.layout([kid, parent]).shown.length, 2);
});

test('kinLabel: a parent counts its side sessions; an orphan names where it came from', () => {
  assert.equal(V.kinLabel({ kids: 2 }), '2 side sessions');
  assert.equal(V.kinLabel({ kids: 1 }), '1 side session');
  assert.equal(V.kinLabel({ kids: 0, depth: 0, parentTitle: 'Prep the cutover' }), 'from Prep the cutover');
  assert.equal(V.kinLabel({ kids: 0, depth: 1, parentTitle: 'Prep the cutover' }), '');
  assert.equal(V.kinLabel({}), '');
});

// ---- watching, snoozing, do not disturb ----

test('speech follows a watched session while it works, and gives its progress', () => {
  const w = row('working', { id: 'local_w', title: 'Big refactor', step: { index: 4, total: 11, text: 'Build the five small features' } });
  assert.deepEqual(V.speech([row('new'), w], 'local_w'), { parts: ['Watching ', { b: 'Big refactor' }, ': step 4 of 11, Build the five small features'], target: 'local_w', progress: 4 / 11 });
  const plain = row('working', { id: 'local_w2', title: 'Plain', headline: 'Running: tests' });
  assert.deepEqual(V.speech([plain], 'local_w2').parts[2], ': Running: tests');
  assert.equal(V.speech([plain], 'local_w2').progress, 0);
  assert.equal(V.speech([row('working', { id: 'local_w3', title: 'Mute' })], 'local_w3').parts[2], ': ');
  // Once it needs you, the usual words say so; a watched id not in view changes nothing.
  const n = row('needs-you', { id: 'local_n', title: 'Needy' });
  assert.deepEqual(V.speech([n], 'local_n'), { parts: ['Pardon me, sir. ', { b: 'Needy' }, ' awaits your word.'], target: 'local_n' });
  assert.deepEqual(V.speech([row('idle')], 'local_missing'), { parts: ['All quiet, sir.'], target: null });
});

test('a snoozed row says so, with until when', () => {
  assert.equal(V.stateLabel({ state: 'idle', snoozed: true }), 'Snoozed');
  assert.equal(V.snoozeLabel({ snoozed: false }), '');
  assert.equal(V.snoozeLabel({ snoozed: true, snoozedUntil: 0 }), 'Snoozed until it changes');
  const at = new Date(2026, 10, 5, 14, 5).getTime();
  assert.equal(V.snoozeLabel({ snoozed: true, snoozedUntil: at }), 'Snoozed until 14:05');
  assert.equal(V.clock(new Date(2026, 0, 1, 9, 7).getTime()), '09:07');
});

test('fitChips honours a chip\'s own short form', () => {
  assert.equal(V.fitChips([{ state: 'dnd', label: 'Do not disturb', short: 'Quiet' }], true)[0].text, 'Quiet');
  assert.equal(V.fitChips([{ state: 'dnd', label: 'Do not disturb', short: 'Quiet' }], false)[0].text, 'Do not disturb');
});

// ---- plain text and the day book ----

test('statusText lists the board as plain text, most urgent first', () => {
  const now = new Date(2026, 10, 5, 14, 32).getTime();
  const rows = [
    row('needs-you', { title: 'Billing API', project: 'billing-api', since: now - 3 * 60_000, headline: 'Push the branch?' }),
    row('working', { title: 'Docs', project: '', since: now - 12 * 60_000, headline: 'Running: tests', step: { index: 3, total: 6, text: 'Update the reference' } }),
    row('idle', { title: 'Old', project: 'x', since: now - 3 * 3600_000, headline: '' }),
  ];
  assert.equal(V.statusText(rows, now), [
    'Wilfred at 14:32: 1 for you, 1 busy',
    'Needs you · Billing API (billing-api) · 3m · Push the branch?',
    'Working · Docs · 12m · Running: tests · step 3/6: Update the reference',
    'Idle · Old (x) · 3h',
  ].join('\n'));
  assert.equal(V.statusText([], now), 'Wilfred at 14:32: all quiet');
});

test('journalLine sums the day up in Wilfred\'s voice', () => {
  assert.equal(V.journalLine(null), 'Nothing in the book yet today, sir.');
  assert.equal(V.journalLine({ sessions: 0 }), 'Nothing in the book yet today, sir.');
  assert.equal(V.journalLine({ sessions: 1, workingMs: 5 * 60_000, waitingMs: 0, done: 0, needsYou: 0, failed: 0 }), 'Claude worked 5 min across 1 session today, sir.');
  assert.equal(
    V.journalLine({ sessions: 6, workingMs: 252 * 60_000, waitingMs: 48 * 60_000, done: 3, needsYou: 1, failed: 1 }),
    'Claude worked 4 h 12 min across 6 sessions today, sir; 3 done, 1 awaits your word, 1 in trouble. They waited on you 48 min in all.',
  );
  assert.equal(V.journalLine({ sessions: 2, workingMs: 0, waitingMs: 30_000, done: 0, needsYou: 2, failed: 0 }), 'Claude worked < 1 min across 2 sessions today, sir; 2 await your word.');
});

test('dayLabel names the day in words', () => {
  assert.equal(V.dayLabel('2026-11-05'), 'Thursday 5 November');
  assert.equal(V.dayLabel('2026-01-01'), 'Thursday 1 January');
  assert.equal(V.dayLabel('2026-02-30'), '');
  assert.equal(V.dayLabel('nonsense'), '');
  assert.equal(V.dayLabel(undefined), '');
});

test('the demo rows carry the new fields: a star, a family, a snooze, a warning, usage', () => {
  const rows = demoRows(NOW, undefined);
  assert.ok(rows.some((r) => r.starred));
  assert.ok(rows.some((r) => r.snoozed && r.state === 'idle'));
  assert.ok(rows.some((r) => r.permissionMode === 'bypassPermissions'));
  assert.ok(rows.some((r) => r.cost && r.cost.usd > 0));
  const parent = rows.find((r) => rows.some((k) => k.parentId === r.id));
  assert.ok(parent, 'a session with side sessions');
  assert.ok(rows.some((r) => r.parentTitle && !rows.some((p) => p.id === r.parentId)), 'a side session whose parent is gone');
  for (const r of rows) assert.ok(typeof r.model === 'string' && typeof r.effort === 'string');
});

test('the context on the row: a percentage on the meta line, red past 80%, the numbers in the facts', () => {
  const ctx = { tokens: 337238, window: 1e6, pct: 34 };
  assert.equal(V.contextLabel(ctx), '34% context');
  assert.equal(V.contextLabel({ tokens: 400, window: 2e5, pct: 0 }), '<1% context');
  assert.equal(V.contextLabel({ tokens: 0, window: 2e5, pct: 0 }), '0% context');
  assert.equal(V.contextLabel(null), '');
  assert.equal(V.contextLabel({ tokens: 1, window: 2e5, pct: NaN }), '');
  assert.equal(V.contextFacts(ctx), '337k of 1.0M tokens in context');
  assert.equal(V.contextFacts(null), '');
  const m = V.metaOf({ model: 'claude-fable-5-1', effort: 'max', permissionMode: 'auto', context: ctx });
  assert.equal(m.context, '34% context');
  assert.equal(m.full, false);
  assert.equal(m.filling, false);
  assert.equal(m.text, 'Fable 5.1 · max · auto mode · 34% context');
  const full = V.metaOf({ model: 'claude-opus-5-5', context: { tokens: 174000, window: 2e5, pct: 87 } });
  assert.equal(full.full, true);
  assert.equal(full.filling, false);
  assert.equal(full.text, 'Opus 5.5 · 87% context');
  // Three stages, like the app's meter: plain below half, amber from 50%, red from 80%.
  const stage = (pct) => { const x = V.metaOf({ context: { tokens: pct * 2e3, window: 2e5, pct } }); return x.full ? 'full' : x.filling ? 'filling' : 'plain'; };
  assert.deepEqual([0, 49, 50, 79, 80, 100].map(stage), ['plain', 'plain', 'filling', 'filling', 'full', 'full']);
  const none = V.metaOf({ model: 'claude-opus-5-5' });
  assert.equal(none.full, false);
  assert.equal(none.filling, false);
  assert.equal(V.factsLabel({ branch: 'claude/x', context: ctx, cost: null }), 'on claude/x · 337k of 1.0M tokens in context');
  // The demo shows one filling and one near full, so both colours can be seen.
  assert.ok(demoRows().some((r) => r.context && r.context.pct >= 50 && r.context.pct < 80));
  assert.ok(demoRows().some((r) => r.context && r.context.pct >= 80));
});
