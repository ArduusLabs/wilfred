const test = require('node:test');
const assert = require('node:assert/strict');
const { Notifier, DEFAULT_NOTIFY, GRACE_MS } = require('../src/notify');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-05T12:00:00Z');
const row = (id, state, headline = '', extra = {}) => ({ id, title: `Session ${id}`, state, headline, since: T0, ...extra });
const snoozed = (id, headline, stateWas = 'needs-you') => row(id, 'idle', headline, { snoozed: true, stateWas });

// A notifier with notifications on that has seen the board once (the baseline), as after Wilfred starts.
function started(rows, opts = {}, deps) {
  const n = new Notifier({ on: true, ...opts }, deps);
  assert.deepEqual(n.observe(rows, T0), [], 'the first look is a baseline');
  return n;
}

// A change seen at `t`, then the same board once the grace period is over: what is told, and when.
function change(n, rows, t, extra) {
  const atOnce = n.observe(rows, t, extra);
  const later = n.observe(rows, t + GRACE_MS, extra);
  return { atOnce, later };
}
const quiet = { atOnce: [], later: [] };

test('the defaults: off; once on, needs you and failed, not done or long, with text and sound', () => {
  assert.deepEqual(DEFAULT_NOTIFY, { on: false, needs: true, failed: true, done: false, long: false, longMinutes: 20, text: true, sound: true });
  assert.equal(GRACE_MS, 30 * 1000);
});

test('off, nothing is told, not even a failure or the watched session; switched on later, only what is new', () => {
  const n = new Notifier();
  n.observe([row('a', 'working'), row('b', 'working')], T0);
  assert.deepEqual(change(n, [row('a', 'needs-you', 'Q'), row('b', 'failed', 'x')], T0 + 1, { watch: 'a' }), quiet);
  n.setOptions({ on: true });
  // The question that appeared while off was seen then, not now.
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Q'), row('b', 'failed', 'x')], T0 + MIN), []);
  n.observe([row('a', 'working'), row('b', 'failed', 'x')], T0 + 2 * MIN);
  assert.equal(change(n, [row('a', 'needs-you', 'Q2'), row('b', 'failed', 'x')], T0 + 3 * MIN).later[0].body, 'Q2');
});

test('a question is told once, half a minute after it appears, with the question as the body', () => {
  const n = started([row('a', 'working', 'Build')]);
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Post it?')], T0 + 1), []);
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Post it?')], T0 + GRACE_MS), [], 'not yet');
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Post it?')], T0 + 1 + GRACE_MS), [{ id: 'a', kind: 'needs', title: 'Session a', body: 'Post it?' }]);
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Post it?')], T0 + 2 * MIN), [], 'still the same: nothing new');
  // A moment of work and the same question again (the board flickered): not told twice.
  n.observe([row('a', 'working', 'Thinking…')], T0 + 3 * MIN);
  assert.deepEqual(change(n, [row('a', 'needs-you', 'Post it?')], T0 + 4 * MIN), quiet);
  n.observe([row('a', 'working', 'Thinking…')], T0 + 5 * MIN);
  assert.equal(change(n, [row('a', 'needs-you', 'Merge it?')], T0 + 6 * MIN).later[0].body, 'Merge it?');
  // Answered within the grace period: you were there, and nothing is said.
  n.observe([row('a', 'working', 'Thinking…')], T0 + 7 * MIN);
  n.observe([row('a', 'needs-you', 'Rebase?')], T0 + 8 * MIN);
  n.observe([row('a', 'working', 'Rebasing')], T0 + 8 * MIN + 10e3);
  assert.deepEqual(n.observe([row('a', 'working', 'Rebasing')], T0 + 9 * MIN), []);
  assert.equal(n.waiting.size, 0);
});

test('a question that changes while it waits is told once, with the new text, after a wait of its own', () => {
  const n = started([row('a', 'working')]);
  n.observe([row('a', 'needs-you', 'Which?')], T0 + 1);
  n.observe([row('a', 'needs-you', 'Which one?')], T0 + 20e3);
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Which one?')], T0 + 1 + GRACE_MS), [], 'the new question waits anew');
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Which one?')], T0 + 20e3 + GRACE_MS).map((x) => x.body), ['Which one?']);
});

test('failed is told at once; done only when asked for, and only if the result stays unseen', () => {
  const n = started([row('a', 'working'), row('b', 'working')]);
  const out = change(n, [row('a', 'failed', 'Stopped: API error'), row('b', 'new', 'Shipped')], T0 + 1);
  assert.deepEqual(out.atOnce.map((x) => [x.id, x.kind, x.body]), [['a', 'failed', 'Stopped: API error']]);
  assert.deepEqual(out.later, [], 'done is off');
  const d = started([row('b', 'working')], { done: true });
  assert.deepEqual(change(d, [row('b', 'new', 'Shipped')], T0 + 1), { atOnce: [], later: [{ id: 'b', kind: 'done', title: 'Session b', body: 'Shipped' }] });
  // Seen before the wait is over (the app marks it read): nothing.
  d.observe([row('b', 'working')], T0 + MIN);
  d.observe([row('b', 'new', 'Shipped again')], T0 + 2 * MIN);
  d.observe([row('b', 'idle', 'Shipped again')], T0 + 2 * MIN + 5e3);
  assert.deepEqual(d.observe([row('b', 'idle', 'Shipped again')], T0 + 3 * MIN), []);
  // The result's text may still change while it waits: told once, with the text of the moment.
  d.observe([row('b', 'new', 'Shipped')], T0 + 4 * MIN);
  d.observe([row('b', 'new', 'Shipped, really')], T0 + 4 * MIN + 5e3);
  assert.deepEqual(d.observe([row('b', 'new', 'Shipped, really')], T0 + 4 * MIN + GRACE_MS).map((x) => x.body), ['Shipped, really']);
});

test('options turned off say nothing', () => {
  const n = started([row('a', 'working'), row('b', 'working')], { needs: false, failed: false });
  assert.deepEqual(change(n, [row('a', 'needs-you', 'Q'), row('b', 'failed', 'x')], T0 + 1), quiet);
});

test('a watched session is always told about: needs you, failed, done and long', () => {
  const off = { needs: false, failed: false, done: false, long: false };
  const n = started([row('a', 'working'), row('b', 'working'), row('c', 'working')], off);
  const out = change(n, [row('a', 'needs-you', 'Q'), row('b', 'failed', 'x'), row('c', 'new', 'Done.')], T0 + 1, { watch: 'b' });
  assert.deepEqual(out.atOnce.map((x) => x.kind), ['failed']);
  assert.deepEqual(out.later, []);
  const w = started([row('a', 'working')], off);
  assert.deepEqual(change(w, [row('a', 'needs-you', 'Q')], T0 + 1, { watch: 'a' }).later.map((x) => x.kind), ['needs']);
  w.observe([row('a', 'working')], T0 + MIN, { watch: 'a' });
  assert.deepEqual(change(w, [row('a', 'new', 'Done.')], T0 + 2 * MIN, { watch: 'a' }).later.map((x) => x.kind), ['done']);
  assert.deepEqual(w.observe([row('a', 'working', 'Again', { since: T0 })], T0 + 21 * MIN, { watch: 'a' }).map((x) => x.kind), ['long']);
});

test('a long run is told once per run, after longMinutes', () => {
  const n = started([row('a', 'working', 'Build', { since: T0 })], { long: true, longMinutes: 20 });
  assert.deepEqual(n.observe([row('a', 'working', 'Build', { since: T0 })], T0 + 19 * MIN), []);
  assert.deepEqual(n.observe([row('a', 'working', 'Build', { since: T0 })], T0 + 20 * MIN), [{ id: 'a', kind: 'long', title: 'Session a', body: 'Working for 20 min' }]);
  assert.deepEqual(n.observe([row('a', 'working', 'Build', { since: T0 })], T0 + 40 * MIN), [], 'once for this run');
  // A new run (a new since) is a new chance.
  const since = T0 + 41 * MIN;
  assert.equal(n.observe([row('a', 'working', 'Next', { since })], since + 25 * MIN + 30e3)[0].body, 'Working for 25 min');
  // Only working rows run long.
  assert.deepEqual(change(n, [row('a', 'needs-you', 'Q', { since: T0 })], T0 + 999 * MIN, {}).later.map((x) => x.kind), ['needs']);
});

test('work already running long when Wilfred starts is not news', () => {
  const n = started([row('a', 'working', 'Build', { since: T0 - 60 * MIN })], { long: true });
  assert.deepEqual(n.observe([row('a', 'working', 'Build', { since: T0 - 60 * MIN })], T0 + MIN), []);
});

test('without text, the body says only what happened; a row with nothing to say does the same', () => {
  const n = started([row('a', 'working'), row('b', 'working'), row('c', 'working')], { text: false, done: true });
  const out = change(n, [row('a', 'needs-you', 'Secret question'), row('b', 'failed', 'Secret error'), row('c', 'new', 'Secret result')], T0 + 1);
  assert.deepEqual([...out.atOnce, ...out.later].map((x) => x.body).sort(), ['Done', 'Failed', 'Needs you']);
  const empty = started([row('a', 'working')]);
  assert.equal(change(empty, [row('a', 'needs-you', '')], T0 + 1).later[0].body, 'Needs you');
  // A long body is clipped, an untitled session still has a title.
  const long = started([row('a', 'working')]);
  const x = change(long, [row('a', 'needs-you', 'q'.repeat(400), { title: '' })], T0 + 1).later[0];
  assert.equal(x.body.length, 180);
  assert.equal(x.title, 'Untitled session');
});

test('snoozed rows and rows new to the board never notify', () => {
  const n = started([row('a', 'working')]);
  assert.deepEqual(change(n, [snoozed('a', 'Q'), row('b', 'needs-you', 'Q')], T0 + 1), quiet);
  // From then on the new row is watched like the rest.
  n.observe([row('b', 'working')], T0 + MIN);
  assert.equal(change(n, [row('b', 'needs-you', 'R')], T0 + 2 * MIN).later.length, 1);
  // A question snoozed while it waited to be told was seen: waking it by hand stays quiet.
  const s = started([row('c', 'working')]);
  s.observe([row('c', 'needs-you', 'Q')], T0 + 1);
  s.observe([snoozed('c', 'Q')], T0 + 10e3);
  assert.deepEqual(change(s, [row('c', 'needs-you', 'Q')], T0 + MIN), quiet);
  // Snoozing a working row says nothing about its question.
  s.observe([snoozed('c', 'Build', 'working')], T0 + 3 * MIN);
  assert.equal(s.askedFor.get('c'), 'Q');
  // A session that leaves the board while its notice waits is forgotten.
  const g = started([row('d', 'working'), row('e', 'working')]);
  g.observe([row('d', 'needs-you', 'Q'), row('e', 'working')], T0 + 1);
  assert.deepEqual(g.observe([row('e', 'working')], T0 + 1 + GRACE_MS), []);
  assert.equal(g.waiting.size, 0);
});

test('more than three at once become one notice', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const n = started(ids.map((id) => row(id, 'working')));
  assert.deepEqual(change(n, ids.map((id) => row(id, 'needs-you', id)), T0 + 1).later, [{ id: '', kind: 'many', title: 'Wilfred', body: '4 sessions need you' }]);
  const m = started(ids.map((id) => row(id, 'working')), { done: true });
  assert.equal(change(m, [...ids.slice(0, 3).map((id) => row(id, 'needs-you', id)), row('d', 'new', 'x')], T0 + 1).later[0].body, '4 sessions changed');
  // Three stay separate.
  const t = started(ids.slice(0, 3).map((id) => row(id, 'working')));
  assert.equal(change(t, ids.slice(0, 3).map((id) => row(id, 'needs-you', id)), T0 + 1).later.length, 3);
});

test('setOptions changes what is told from then on; missing options take their defaults', () => {
  const n = started([row('a', 'working')], { needs: false });
  n.setOptions({ on: true, needs: true });
  assert.equal(n.opts.failed, true);
  assert.equal(change(n, [row('a', 'needs-you', 'Q')], T0 + 1).later.length, 1);
});

test('a kind switched off while its notice waits, or a session unwatched meanwhile, is not told', () => {
  const n = started([row('a', 'working'), row('b', 'working')], { done: true });
  n.observe([row('a', 'needs-you', 'Q'), row('b', 'new', 'Done.')], T0 + 1);
  n.setOptions({ on: true, needs: false, done: false });
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Q'), row('b', 'new', 'Done.')], T0 + 1 + GRACE_MS), []);
  assert.equal(n.waiting.size, 0, 'dropped, not kept for later');
  const w = started([row('c', 'working')], { needs: false });
  w.observe([row('c', 'needs-you', 'Q')], T0 + 1, { watch: 'c' });
  assert.deepEqual(w.observe([row('c', 'needs-you', 'Q')], T0 + 1 + GRACE_MS, { watch: '' }), []);
});

test('by default the real clock is used', () => {
  const n = new Notifier({ on: true });
  const old = Date.now() - 30 * MIN;
  n.observe([row('a', 'working', 'x', { since: Date.now() })]);
  n.setOptions({ on: true, long: true });
  assert.equal(n.observe([row('a', 'working', 'x', { since: old })])[0].kind, 'long');
});

test('a question hidden by a snooze that ran out is told again; one woken by hand is not', () => {
  const n = started([row('a', 'working')]);
  assert.equal(change(n, [row('a', 'needs-you', 'Post it?')], T0 + 1).later.length, 1);
  n.observe([snoozed('a', 'Post it?')], T0 + MIN);
  // Woken by hand (no `woken` mark): the same question was already told.
  assert.deepEqual(change(n, [row('a', 'needs-you', 'Post it?')], T0 + 2 * MIN), quiet);
  n.observe([snoozed('a', 'Post it?')], T0 + 3 * MIN);
  // The snooze ran out: a reminder, after the usual wait.
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Post it?', { woken: true })], T0 + 4 * MIN), []);
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Post it?')], T0 + 4 * MIN + GRACE_MS).map((x) => x.kind), ['needs']);
});

test('a question already waiting at the start, or on a row new to the board, counts as asked: waking it by hand is quiet', () => {
  // Waiting when Wilfred started: never told, so a manual wake must not raise it either.
  const n = started([row('a', 'needs-you', 'Post it?')]);
  n.observe([snoozed('a', 'Post it?')], T0 + 1);
  assert.deepEqual(change(n, [row('a', 'needs-you', 'Post it?')], T0 + MIN), quiet);
  // A snooze that ran out still reminds.
  n.observe([snoozed('a', 'Post it?')], T0 + 2 * MIN);
  n.observe([row('a', 'needs-you', 'Post it?', { woken: true })], T0 + 3 * MIN);
  assert.deepEqual(n.observe([row('a', 'needs-you', 'Post it?')], T0 + 3 * MIN + GRACE_MS).map((x) => x.kind), ['needs']);
  // New to the board while already asking: the same rule.
  const m = started([row('b', 'working')]);
  assert.deepEqual(change(m, [row('b', 'working'), row('c', 'needs-you', 'Merge?')], T0 + 1), quiet);
  m.observe([row('b', 'working'), snoozed('c', 'Merge?')], T0 + MIN);
  assert.deepEqual(change(m, [row('b', 'working'), row('c', 'needs-you', 'Merge?')], T0 + 2 * MIN), quiet);
  // A question that changed while the row was snoozed is news, even woken by hand.
  m.observe([row('b', 'working'), snoozed('c', 'Merge?')], T0 + 3 * MIN);
  assert.deepEqual(change(m, [row('b', 'working'), row('c', 'needs-you', 'Rebase first?')], T0 + 4 * MIN).later.map((x) => x.body), ['Rebase first?']);
});
