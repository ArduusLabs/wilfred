const test = require('node:test');
const assert = require('node:assert/strict');
const { Quiet, rowKey, clock, GONE_KEEP_MS } = require('../src/quiet');

const MIN = 60 * 1000;
// A fixed local time, so the clock labels don't depend on the machine's time zone.
const T0 = new Date(2026, 10, 5, 14, 0, 0).getTime();
const row = (id, state, headline = '', extra = {}) => ({ id, state, headline, ...extra });

function quiet(start = T0) {
  let now = start;
  const q = new Quiet({ now: () => now });
  return { q, at: (ms) => (now = ms), get now() { return now; } };
}

test('rowKey is the state and the headline: what "until it changes" watches', () => {
  assert.equal(rowKey(row('a', 'needs-you', 'Post it?')), 'needs-you|Post it?');
  assert.notEqual(rowKey(row('a', 'needs-you', 'Post it?')), rowKey(row('a', 'needs-you', 'Merge it?')));
});

test('clock is the local 24-hour time, HH:MM', () => {
  assert.equal(clock(new Date(2026, 10, 5, 14, 30).getTime()), '14:30');
  assert.equal(clock(new Date(2026, 10, 5, 9, 5).getTime()), '09:05');
  assert.equal(clock(new Date(2026, 10, 5, 23, 59).getTime()), '23:59');
});

test('a timed snooze shows the row idle, after the rest, with its real state kept, until it runs out', () => {
  const { q, at } = quiet();
  const rows = [row('a', 'needs-you', 'Post it?'), row('b', 'working', 'Build')];
  q.snooze('a', 15);
  assert.deepEqual(q.snoozeOf('a', T0), { until: T0 + 15 * MIN });
  const shown = q.apply(rows, T0 + MIN);
  assert.deepEqual(shown.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(shown[1], { id: 'a', state: 'idle', stateWas: 'needs-you', headline: 'Post it?', snoozed: true, snoozedUntil: T0 + 15 * MIN });
  assert.equal(rows[0].state, 'needs-you', 'the rows given are left alone');
  // A timed snooze holds even when the row changes: you asked not to hear about it for a while.
  assert.equal(q.apply([row('a', 'failed', 'Broke')], T0 + 2 * MIN)[0].snoozed, true);
  at(T0 + 15 * MIN);
  assert.equal(q.snoozeOf('a'), null, 'ran out');
  assert.equal(q.apply(rows)[0].snoozed, undefined);
  assert.equal(q.snoozes.size, 0, 'and is forgotten');
});

test('"until it changes" lasts while the row looks as it did when you snoozed it', () => {
  const { q } = quiet();
  q.apply([row('a', 'needs-you', 'Post it?')], T0);
  q.snooze('a', 0);
  assert.deepEqual(q.snoozeOf('a', T0 + 999 * MIN), { until: 0 }, 'no end time');
  // Still the same, hours later.
  assert.equal(q.apply([row('a', 'needs-you', 'Post it?')], T0 + 300 * MIN)[0].snoozedUntil, 0);
  // It asks something else: the snooze ends and the row shows as it is.
  const changed = q.apply([row('a', 'needs-you', 'Merge it?')], T0 + 301 * MIN);
  assert.equal(changed[0].state, 'needs-you');
  assert.equal(changed[0].snoozed, undefined);
  assert.equal(q.snoozeOf('a'), null);
});

test('a snooze of a row not shown yet watches the row as it next appears', () => {
  const { q } = quiet();
  q.snooze('a');
  assert.equal(q.apply([row('a', 'working', 'Build')], T0)[0].snoozed, true);
  assert.equal(q.apply([row('a', 'working', 'Build')], T0 + MIN)[0].snoozed, true);
  assert.equal(q.apply([row('a', 'new', 'Done')], T0 + 2 * MIN)[0].snoozed, undefined);
});

test('unsnooze ends a snooze at once', () => {
  const { q } = quiet();
  q.snooze('a', 60);
  q.unsnooze('a');
  assert.equal(q.snoozeOf('a'), null);
  assert.equal(q.apply([row('a', 'failed')])[0].state, 'failed');
});

test('a snoozed row that leaves the board keeps its snooze for a day at most', () => {
  const { q } = quiet();
  q.apply([row('a', 'needs-you', 'Q')], T0);
  q.snooze('a', 0);
  q.apply([], T0 + MIN);
  // Back within the day: still snoozed, and the day starts over once it leaves again.
  assert.equal(q.apply([row('a', 'needs-you', 'Q')], T0 + 20 * 60 * MIN)[0].snoozed, true);
  q.apply([], T0 + 21 * 60 * MIN);
  q.apply([], T0 + 21 * 60 * MIN + GONE_KEEP_MS - 1);
  assert.deepEqual(q.snoozeOf('a', T0 + 21 * 60 * MIN + GONE_KEEP_MS - 1), { until: 0 });
  q.apply([], T0 + 21 * 60 * MIN + GONE_KEEP_MS);
  assert.equal(q.snoozeOf('a'), null);
  // A timed snooze of a row away from the board still runs out on time.
  q.snooze('b', 30);
  q.apply([], T0 + MIN);
  assert.ok(q.snoozeOf('b', T0 + MIN));
  q.apply([], T0 + 30 * MIN);
  assert.equal(q.snoozes.has('b'), false);
});

test('do not disturb: for a while, until turned off, or off', () => {
  const { q, at } = quiet();
  assert.equal(q.dnd(), false);
  assert.equal(q.dndLabel(), '');
  q.setDnd(30);
  assert.equal(q.dnd(T0 + 29 * MIN), true);
  assert.equal(q.dndLabel(T0), 'Do not disturb until 14:30');
  assert.equal(q.dnd(T0 + 30 * MIN), false, 'over at the time it said');
  assert.equal(q.dndLabel(T0 + 30 * MIN), '');
  q.setDnd(null);
  assert.equal(q.dnd(T0 + 1e9), true);
  assert.equal(q.dndLabel(), 'Do not disturb until you turn it off');
  q.setDnd(0);
  assert.equal(q.dnd(), false);
  q.setDnd();
  assert.equal(q.dnd(), true, 'undefined is until turned off too');
  at(T0 + 9 * 60 * MIN + 50 * MIN); // 23:50
  q.setDnd(60);
  assert.equal(q.dndLabel(), 'Do not disturb until 00:50');
});

test('by default the real clock is used', () => {
  const q = new Quiet();
  q.setDnd(1);
  assert.equal(q.dnd(), true);
  assert.equal(q.dnd(Date.now() + 2 * MIN), false);
  q.snooze('a', 1);
  assert.ok(q.snoozeOf('a').until > Date.now());
});

test('a snooze that ends on its own marks its row woken, once; a manual wake does not', () => {
  const { q } = quiet();
  q.snooze('a', 15);
  q.apply([row('a', 'needs-you', 'Q')], T0 + MIN);
  const ran = q.apply([row('a', 'needs-you', 'Q')], T0 + 15 * MIN);
  assert.equal(ran[0].woken, true, 'ran out: a reminder');
  assert.equal(q.apply([row('a', 'needs-you', 'Q')], T0 + 16 * MIN)[0].woken, undefined, 'only in the call it ended');
  // Until it changes: the change ends it, and says so.
  q.snooze('a', 0);
  q.apply([row('a', 'needs-you', 'Q')], T0 + 17 * MIN);
  assert.equal(q.apply([row('a', 'needs-you', 'R')], T0 + 18 * MIN)[0].woken, true);
  // "Wake it up" is you: nothing to remind you of.
  q.snooze('a', 60);
  q.apply([row('a', 'needs-you', 'R')], T0 + 19 * MIN);
  q.unsnooze('a');
  assert.equal(q.apply([row('a', 'needs-you', 'R')], T0 + 20 * MIN)[0].woken, undefined);
});
