const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../tools/ui-rules');

const failed = (verdicts) => verdicts.filter((v) => !v.ok).map((v) => v.name);
const detail = (verdicts, start) => verdicts.find((v) => v.name.startsWith(start)).detail;

// A row as tools/ui-check.js reports it, good unless told otherwise.
const row = (over = {}) => ({
  title: 'Billing API', stateWord: 'Needs you', dimmed: false, parts: 3, dots: 2, dotsBefore: 0, lastHasDot: false,
  metaColor: 'rgb(150, 140, 120)', faintest: { text: 'Fable 5.1', ratio: 5.2 }, context: null, ...over,
});
const board = (rows, over = {}) => ({ rows, overflowX: false, errors: [], ...over });

test('contrast is the WCAG ratio, whichever colour comes first', () => {
  assert.equal(R.contrast([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(R.contrast([255, 255, 255], [0, 0, 0]), 21);
  assert.equal(R.contrast([120, 120, 120], [120, 120, 120]), 1);
  // the dark end of the scale is the linear part of the curve
  assert.ok(R.contrast([8, 8, 8], [0, 0, 0]) > 1 && R.contrast([8, 8, 8], [0, 0, 0]) < 1.1);
  assert.equal(R.MIN_CONTRAST, 4.5);
});

test('a see-through ink is the mix of itself and what it is painted on', () => {
  assert.deepEqual(R.over([255, 255, 255, 1], [0, 0, 0]), [255, 255, 255]);
  assert.deepEqual(R.over([255, 255, 255, 0], [10, 20, 30]), [10, 20, 30]);
  assert.deepEqual(R.over([200, 100, 0, 0.5], [0, 100, 200]), [100, 100, 100]);
});

test('the context reading has three stages', () => {
  assert.deepEqual([0, 49, 50, 79, 80, 100].map(R.stageOf), ['', '', 'filling', 'filling', 'full', 'full']);
});

test('a good board passes every rule', () => {
  const rows = [
    row(),
    row({ title: 'Docs site', context: { pct: 34, stage: '', color: 'rgb(150, 140, 120)', underlined: false } }),
    row({ title: 'Importer', context: { pct: 58, stage: 'filling', color: 'rgb(243, 169, 60)', underlined: false } }),
    // on a row painted in the warning's own colour, the reading is underlined instead
    row({ title: 'Changelog', context: { pct: 91, stage: 'full', color: 'rgb(150, 140, 120)', underlined: true } }),
    row({ title: 'Bare', parts: 0, dots: 0, faintest: undefined }),
    row({ title: 'Retry policy', dimmed: true, faintest: { text: 'Opus 5.5', ratio: 2.1 } }),
  ];
  const verdicts = R.judgeBoard(board(rows), rows.map((r) => r.title));
  assert.deepEqual(failed(verdicts), []);
  assert.ok(verdicts.every((v) => v.detail === ''));
  assert.equal(verdicts.length, 8);
});

test('the board: each rule says what broke it', () => {
  const titles = ['Billing API', 'Docs site'];
  let v = R.judgeBoard(board([row()]), titles);
  assert.deepEqual(failed(v), ['every session has a row']);
  assert.equal(detail(v, 'every session'), 'missing: Docs site');

  v = R.judgeBoard(board([row({ title: '' }), row({ stateWord: '' })]), []);
  assert.deepEqual(failed(v), ['every row says its state and its title']);
  assert.equal(detail(v, 'every row'), '2 row(s) without one');

  v = R.judgeBoard(board([row({ context: { pct: 58, stage: '', color: 'red', underlined: false } }), row({ title: 'B', context: { pct: 20, stage: 'full', color: 'red', underlined: false } })]), []);
  assert.deepEqual(failed(v), ['the context reading is plain, amber from 50%, red from 80%']);
  assert.equal(detail(v, 'the context reading'), 'Billing API: 58% drawn as ""; B: 20% drawn as "full"');

  // right stage, but drawn like the rest of the line and not underlined either
  v = R.judgeBoard(board([row({ context: { pct: 87, stage: 'full', color: 'rgb(150, 140, 120)', underlined: false } })]), []);
  assert.deepEqual(failed(v), ['a context reading past half stands out from its line']);
  assert.equal(detail(v, 'a context reading past half'), 'Billing API');

  for (const bad of [{ dots: 3 }, { dotsBefore: 1 }, { lastHasDot: true }, { parts: 0, dots: 1, faintest: undefined }]) {
    v = R.judgeBoard(board([row(bad)]), []);
    assert.deepEqual(failed(v), ['the dots sit between the parts of the small print, never before or after'], JSON.stringify(bad));
  }
  assert.equal(detail(R.judgeBoard(board([row({ dots: 3 })]), []), 'the dots'), 'Billing API: 3 dot(s) for 3 part(s)');

  v = R.judgeBoard(board([row({ faintest: { text: 'no permission checks', ratio: 3.742 } })]), []);
  assert.deepEqual(failed(v), ['the small print is readable (4.5:1)']);
  assert.equal(detail(v, 'the small print'), 'Billing API, "no permission checks": 3.74');

  v = R.judgeBoard(board([row()], { overflowX: true, errors: ['boom', 'bang'] }), []);
  assert.deepEqual(failed(v), ['the board fits its width', 'the page reports no errors']);
  assert.equal(detail(v, 'the page reports'), 'boom | bang');
});

test('a hovered row shows its facts in full and stays off the next row', () => {
  const good = { hovered: true, opacity: 1, lines: 2, clippedV: false, clippedH: false, gapToNext: 0 };
  assert.deepEqual(failed(R.judgeHover(good)), []);
  assert.deepEqual(failed(R.judgeHover({ ...good, gapToNext: null })), []); // the last row has no next
  for (const bad of [{ hovered: false }, { opacity: 0.4 }, { lines: 0 }]) {
    assert.deepEqual(failed(R.judgeHover({ ...good, ...bad })), ['hovering a row shows its facts'], JSON.stringify(bad));
  }
  assert.equal(detail(R.judgeHover({ ...good, clippedV: true }), 'the facts are not'), 'cut at the bottom');
  assert.equal(detail(R.judgeHover({ ...good, clippedH: true }), 'the facts are not'), 'cut at the side');
  assert.equal(detail(R.judgeHover({ ...good, gapToNext: -12 }), 'a hovered row'), 'overlaps by 12px');
});

test('folding keeps Wilfred and his line, unfolding brings the rows back', () => {
  const good = { collapsed: true, bubbleShown: true, bubbleText: 'Two for you, sir.', collapsedAfter: false, rowsAfter: 8 };
  assert.deepEqual(failed(R.judgeFold(good)), []);
  for (const bad of [{ collapsed: false }, { bubbleShown: false }, { bubbleText: '' }]) {
    assert.deepEqual(failed(R.judgeFold({ ...good, ...bad })), ['folded, Wilfred keeps his line'], JSON.stringify(bad));
  }
  for (const bad of [{ collapsedAfter: true }, { rowsAfter: 0 }]) {
    assert.deepEqual(failed(R.judgeFold({ ...good, ...bad })), ['unfolded, the rows are back'], JSON.stringify(bad));
  }
});

test('the settings window: pages open from the menu and the list, and every control has a name', () => {
  const good = {
    steps: [{ label: 'Privacy settings…', wanted: 'privacy', shown: 'privacy', reloaded: false }],
    pages: [{ page: 'general', shown: 'general', hash: 'general' }],
    unnamed: [], privacy: "Privacy check passed: Wilfred can't reach any network", errors: [],
  };
  assert.deepEqual(failed(R.judgeSettings(good)), []);

  let v = R.judgeSettings({ ...good, steps: [{ label: 'Day book…', wanted: 'today', shown: 'general', reloaded: false }, { label: 'Privacy settings…', wanted: 'privacy', shown: 'privacy', reloaded: true }] });
  assert.deepEqual(failed(v), ['menu items open their page, also when Settings is already open']);
  assert.equal(detail(v, 'menu items'), '"Day book…" showed general; "Privacy settings…" showed privacy (reloaded)');

  v = R.judgeSettings({ ...good, pages: [{ page: 'today', shown: 'general', hash: 'today' }, { page: 'about', shown: 'about', hash: 'general' }] });
  assert.deepEqual(failed(v), ['every page in the list opens, and the address follows']);
  assert.equal(detail(v, 'every page'), 'today showed general at #today; about showed about at #general');

  v = R.judgeSettings({ ...good, unnamed: ['page-general input#login'], privacy: '', errors: ['boom'] });
  assert.deepEqual(failed(v), ['every control has a name', 'the privacy page reports the network check', 'the page reports no errors']);
  assert.equal(detail(v, 'every control'), 'page-general input#login');
  assert.equal(detail(v, 'the privacy page'), 'it says ""');
});

test('the report lists every verdict under its heading and counts the failures', () => {
  const ok = R.report([['Board', [{ name: 'a', ok: true, detail: '' }]]]);
  assert.equal(ok.failed, 0);
  assert.equal(ok.text, 'Board\n   ok   a\n\nEvery check passed.');
  const bad = R.report([['Board', [{ name: 'a', ok: true, detail: '' }, { name: 'b', ok: false, detail: 'why' }]], ['Settings', [{ name: 'c', ok: false, detail: 'so' }]]]);
  assert.equal(bad.failed, 2);
  assert.equal(bad.text, 'Board\n   ok   a\n  FAIL  b: why\nSettings\n  FAIL  c: so\n\n2 check(s) failed.');
});
