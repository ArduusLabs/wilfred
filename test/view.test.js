const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/renderer/view');
const { demoRows } = require('../src/demo');

const row = (state, extra = {}) => ({ id: `local_${state}-${Math.random().toString(16).slice(2, 8)}`, title: state, state, ...extra });
const NOW = Date.parse('2026-10-27T12:00:00Z');

test('ago: now, minutes, hours with minutes, whole hours, days', () => {
  assert.equal(V.ago(NOW, NOW), 'now');
  assert.equal(V.ago(NOW - 49_000, NOW), 'now');
  assert.equal(V.ago(NOW + 60_000, NOW), 'now'); // clock skew never goes negative
  assert.equal(V.ago(NOW - 4 * 60_000, NOW), '4m');
  assert.equal(V.ago(NOW - 59 * 60_000, NOW), '59m');
  assert.equal(V.ago(NOW - 125 * 60_000, NOW), '2h 5m');
  assert.equal(V.ago(NOW - 180 * 60_000, NOW), '3h');
  assert.equal(V.ago(NOW - 50 * 3600_000, NOW), '2d');
});

test('visibleRows keeps every busy row and only a few idle ones', () => {
  const rows = [row('needs-you'), row('working'), ...Array.from({ length: 6 }, () => row('idle')), row('new')];
  const { shown, hiddenIdle } = V.visibleRows(rows);
  assert.equal(shown.length, 3 + V.MAX_IDLE);
  assert.equal(hiddenIdle, 2);
  assert.deepEqual(shown.slice(0, 3).map((r) => r.state), ['needs-you', 'working', 'new']);
  const lone = row('idle');
  assert.deepEqual(V.visibleRows([lone]), { shown: [lone], hiddenIdle: 0 });
  assert.deepEqual(V.visibleRows([row('idle'), row('idle')], 0).hiddenIdle, 2);
  assert.deepEqual(V.visibleRows([]), { shown: [], hiddenIdle: 0 });
});

test('moreLabel pluralises and is empty for zero', () => {
  assert.equal(V.moreLabel(0), '');
  assert.equal(V.moreLabel(1), '+1 quiet session');
  assert.equal(V.moreLabel(3), '+3 quiet sessions');
});

test('chips list only states with sessions, most urgent first', () => {
  assert.deepEqual(V.chips([]), []);
  const c = V.chips([row('working'), row('new'), row('working'), row('needs-you'), row('idle'), row('failed')]);
  assert.deepEqual(c.map((x) => x.label), ['1 for you', '1 failed', '2 busy', '1 done']);
  assert.deepEqual(c.map((x) => x.state), ['needs-you', 'failed', 'working', 'new']);
});

test('stateLabel is the word the row shows for its state', () => {
  assert.equal(V.stateLabel(row('needs-you')), 'Needs you');
  assert.equal(V.stateLabel(row('needs-you', { quiet: true })), 'Needs you');
  assert.equal(V.stateLabel(row('failed')), 'Failed');
  assert.equal(V.stateLabel(row('working')), 'Working');
  assert.equal(V.stateLabel(row('working', { background: true })), 'In background');
  assert.equal(V.stateLabel(row('new')), 'Done');
  assert.equal(V.stateLabel(row('idle')), 'Idle');
  assert.equal(V.stateLabel({ state: 'odd' }), '');
});

test('transitional: a working row between things, not one running a tool', () => {
  assert.equal(V.transitional(row('working', { headline: 'Starting…' })), true);
  assert.equal(V.transitional(row('working', { headline: 'Wrapping up…' })), true);
  assert.equal(V.transitional(row('working', { headline: 'Reading what came back…' })), true);
  assert.equal(V.transitional(row('working', { headline: 'Thinking…' })), true);
  assert.equal(V.transitional(row('working', { headline: 'Running: npm test' })), false);
  assert.equal(V.transitional(row('working', { headline: '' })), false);
  assert.equal(V.transitional(row('working')), false);
  assert.equal(V.transitional(row('needs-you', { headline: 'Waiting…' })), false);
});

test('mood: alert beats happy beats working beats asleep', () => {
  assert.equal(V.mood([]), 'sleep');
  assert.equal(V.mood([row('idle')]), 'sleep');
  assert.equal(V.mood([row('idle'), row('working')]), 'working');
  assert.equal(V.mood([row('working'), row('new')]), 'happy');
  assert.equal(V.mood([row('new'), row('failed')]), 'alert');
  assert.equal(V.mood([row('needs-you')]), 'alert');
});

test('badge counts what needs you, else new updates', () => {
  assert.deepEqual(V.badge([row('idle'), row('working')]), { hidden: true, text: '0', cls: 'new' });
  assert.deepEqual(V.badge([row('new'), row('new')]), { hidden: false, text: '2', cls: 'new' });
  assert.deepEqual(V.badge([row('failed'), row('new')]), { hidden: false, text: '1', cls: 'failed' });
  assert.deepEqual(V.badge([row('failed'), row('needs-you'), row('new')]), { hidden: false, text: '2', cls: '' });
});

test('speech covers every situation and targets a single session when there is one', () => {
  const one = row('needs-you', { title: 'Billing API' });
  assert.deepEqual(V.speech([one, row('failed')]), { parts: ['Pardon me, sir. ', { b: 'Billing API' }, ' awaits your word.'], target: one.id });
  // Several waiting: the first is named, or the starred one when there is one.
  const a = row('needs-you', { title: 'First' });
  const b = row('needs-you', { title: 'Second' });
  assert.deepEqual(V.speech([a, b]), { parts: ['Pardon me, sir. ', { b: 'First' }, ' and 1 other await your word.'], target: a.id });
  const starred = row('needs-you', { title: 'Starred', starred: true });
  assert.deepEqual(V.speech([a, b, starred]), { parts: ['Pardon me, sir. ', { b: 'Starred' }, ' and 2 others await your word.'], target: starred.id });
  const f = row('failed', { title: 'Nightly' });
  assert.deepEqual(V.speech([f, row('new')]), { parts: ["I'm afraid ", { b: 'Nightly' }, ' has run into trouble.'], target: f.id });
  const n = row('new', { title: 'Brief' });
  assert.deepEqual(V.speech([n, row('working')]), { parts: ['Sir, ', { b: 'Brief' }, ' has news for you.'], target: n.id });
  assert.deepEqual(V.speech([row('new'), row('new')]).parts[1], { b: '2 sessions' });
  assert.equal(V.speech([row('new'), row('new')]).target, null);
  assert.deepEqual(V.speech([row('working'), row('working'), row('idle')]), { parts: ['All in hand, sir. ', { b: '2 at work' }, '.'], target: null });
  assert.deepEqual(V.speech([row('idle')]), { parts: ['All quiet, sir.'], target: null });
});

test('stepLabel', () => {
  assert.equal(V.stepLabel(null), '');
  assert.equal(V.stepLabel({ index: 3, total: 6, text: 'x' }), '3/6');
});

test('stepFraction', () => {
  assert.equal(V.stepFraction(null), 0);
  assert.equal(V.stepFraction({ index: 3, total: 6, text: 'x' }), 0.5);
  assert.equal(V.stepFraction({ index: 1, total: 0, text: 'x' }), 0);
  assert.equal(V.stepFraction({ index: 9, total: 6, text: 'x' }), 1);
  assert.equal(V.stepFraction({ index: -1, total: 6, text: 'x' }), 0);
});

test('the demo rows cover every state the board can show', () => {
  const rows = demoRows(NOW, undefined);
  assert.deepEqual([...new Set(rows.map((r) => r.state))].sort(), ['failed', 'idle', 'needs-you', 'new', 'working']);
  assert.ok(rows.some((r) => r.background) && rows.some((r) => r.quiet) && rows.some((r) => r.step));
  assert.ok(rows.some((r) => V.transitional(r)), 'a moment between things, like "Reading what came back…"');
  for (const r of rows) assert.match(r.id, /^local_/);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
});

test('demo variants: an empty board, and enough idle sessions to fold some away', () => {
  assert.deepEqual(demoRows(NOW, 'empty'), []);
  const many = demoRows(NOW, 'many');
  assert.ok(V.visibleRows(many).hiddenIdle > 0);
  assert.equal(new Set(many.map((r) => r.id)).size, many.length);
  // The short board still shows every state, in fewer rows.
  const short = demoRows(NOW, 'short');
  assert.ok(short.length < demoRows(NOW, undefined).length);
  assert.deepEqual([...new Set(short.map((r) => r.state))].sort(), ['failed', 'idle', 'needs-you', 'new', 'working']);
});

test('trayTooltip summarises the board for the tray icon', () => {
  assert.equal(V.trayTooltip([]), 'Wilfred: all quiet');
  assert.equal(V.trayTooltip([row('idle')]), 'Wilfred: all quiet');
  assert.equal(V.trayTooltip([row('working'), row('needs-you'), row('working')]), 'Wilfred: 1 for you, 2 busy');
});

test('fitChips draws full labels, or just the counts in compact mode (label kept for the tooltip)', () => {
  const list = V.chips([row('needs-you'), row('working'), row('working')]);
  assert.deepEqual(V.fitChips(list, false).map((c) => c.text), ['1 for you', '2 busy']);
  const compact = V.fitChips(list, true);
  assert.deepEqual(compact.map((c) => c.text), ['1', '2']);
  assert.equal(compact[0].label, '1 for you');
  assert.deepEqual(V.fitChips([], true), []);
});

test('uniqueRows keeps the first row for each session id', () => {
  const a = { id: 'local_a', title: 'first' };
  const b = { id: 'local_b' };
  assert.deepEqual(V.uniqueRows([a, b, { id: 'local_a', title: 'dup' }]), [a, b]);
});
