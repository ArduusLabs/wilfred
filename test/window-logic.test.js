const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../src/window-logic');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wilfred-wl-'));

test('parseState keeps well-formed values', () => {
  const saved = {
    anchor: { right: 100, bottom: 200 }, collapsed: true, zoom: 1.75, hidden: false, theme: 'custom/my theme', windowHours: 48, appearance: 'dark',
    notify: { on: true, needs: false, failed: true, done: true, long: true, longMinutes: 45, text: false, sound: false },
    shortcuts: { toggle: 'CommandOrControl+Alt+A', open: 'CommandOrControl+Shift+O' }, families: false, dock: true, watch: 'local_0f1e2d3c-4b5a',
    toastActivator: '{B45EE618-8848-4576-BD3B-AB09D226CFB4}',
  };
  assert.deepEqual(W.parseState(JSON.stringify(saved)), saved);
  // The activator id is a COM class id as Windows writes it; anything else is dropped.
  for (const bad of ['B45EE618-8848-4576-BD3B-AB09D226CFB4', '{nope}', 42, null, '{B45EE618-8848-4576-BD3B-AB09D226CFB4}x']) {
    assert.equal(W.parseState(JSON.stringify({ ...saved, toastActivator: bad })).toastActivator, '', String(bad));
  }
  assert.equal(W.parseState(JSON.stringify({ ...saved, toastActivator: '{b45ee618-8848-4576-bd3b-ab09d226cfb4}' })).toastActivator, '{b45ee618-8848-4576-bd3b-ab09d226cfb4}');
  for (const windowHours of [1, 168]) assert.equal(W.parseState(JSON.stringify({ windowHours })).windowHours, windowHours);
  for (const appearance of W.APPEARANCES) assert.equal(W.parseState(JSON.stringify({ appearance })).appearance, appearance);
  assert.equal(W.defaultState().windowHours, 12);
  assert.equal(W.defaultState().appearance, 'system');
  assert.equal(W.defaultState().theme, '', 'the default theme');
  assert.equal(W.defaultState().hidden, true, 'kept out of screen shares unless you turn it off');
});

test('parseState falls back to defaults for anything malformed', () => {
  const d = W.defaultState();
  assert.deepEqual(W.parseState('not json'), d);
  assert.deepEqual(W.parseState('null'), d);
  assert.deepEqual(W.parseState('42'), d);
  assert.deepEqual(W.parseState(JSON.stringify({ anchor: { right: 'x', bottom: 1 }, collapsed: 'yes', zoom: 3, hidden: 'no' })), d);
  assert.deepEqual(W.parseState(JSON.stringify({ anchor: { right: Infinity, bottom: 1 } })), d);
  for (const theme of ['../x', 'custom/../x', 'a/b', '.x', 42, 'x'.repeat(81)]) assert.deepEqual(W.parseState(JSON.stringify({ theme })), d, String(theme));
  for (const windowHours of [0, 169, 1.5, '12', null, -6]) assert.deepEqual(W.parseState(JSON.stringify({ windowHours })), d, String(windowHours));
  for (const appearance of ['System', 'auto', '', 1]) assert.deepEqual(W.parseState(JSON.stringify({ appearance })), d, String(appearance));
  assert.equal(d.zoom, W.DEFAULT_ZOOM);
});

test('the new settings start as: notifications off (the usual ones once on), no shortcuts, families nested, no Dock icon, nothing watched', () => {
  const d = W.defaultState();
  assert.deepEqual(d.notify, { on: false, needs: true, failed: true, done: false, long: false, longMinutes: 20, text: true, sound: true });
  assert.deepEqual(d.shortcuts, { toggle: '', open: '' });
  assert.equal(d.families, true);
  assert.equal(d.dock, false, 'the menu bar is home on a Mac; the Dock icon is opt-in');
  assert.equal(d.watch, '');
  assert.equal(d.toastActivator, '', 'no notification activator id until Electron registers one');
  // Each state gets its own copies, so changing one never changes the defaults.
  d.notify.done = true;
  d.shortcuts.toggle = 'x';
  assert.equal(W.defaultState().notify.done, false);
  assert.equal(W.defaultState().shortcuts.toggle, '');
});

test('parseState keeps each well-formed notification setting and defaults the rest', () => {
  const d = W.defaultState().notify;
  const notify = (v) => W.parseState(JSON.stringify({ notify: v })).notify;
  assert.deepEqual(notify({ done: true, sound: 'loud', longMinutes: 4, extra: true }), { ...d, done: true });
  for (const longMinutes of [5, 180]) assert.equal(notify({ longMinutes }).longMinutes, longMinutes);
  for (const longMinutes of [4, 181, 20.5, '20', null]) assert.equal(notify({ longMinutes }).longMinutes, 20, String(longMinutes));
  for (const v of [null, [], 'on', 3]) assert.deepEqual(notify(v), d, JSON.stringify(v));
  assert.equal('extra' in notify({ extra: true }), false);
});

test('parseState keeps shortcuts only as a valid pair, and booleans and a session id for the rest', () => {
  const parse = (v) => W.parseState(JSON.stringify(v));
  const d = W.defaultState();
  assert.deepEqual(parse({ shortcuts: { toggle: 'CommandOrControl+Alt+A', open: '', more: 1 } }).shortcuts, { toggle: 'CommandOrControl+Alt+A', open: '' });
  for (const shortcuts of [{ toggle: 'CommandOrControl+Alt+A', open: 'CommandOrControl+Alt+A' }, { toggle: 'Alt+F4', open: '' }, 'Ctrl+Alt+A', null]) {
    assert.deepEqual(parse({ shortcuts }).shortcuts, d.shortcuts, JSON.stringify(shortcuts));
  }
  assert.equal(parse({ families: 'no', dock: 0 }).families, true);
  assert.equal(parse({ families: 'no', dock: 0 }).dock, false);
  for (const watch of ['local_x/..', 'cse_1', 5, null]) assert.equal(parse({ watch }).watch, '', String(watch));
  assert.equal(parse({ watch: '' }).watch, '');
});

test('parseState takes defaults for what the file lacks (the hours from the environment), never over a saved value', () => {
  assert.equal(W.parseState('', { windowHours: 24 }).windowHours, 24, 'first run');
  assert.equal(W.parseState('{}', { windowHours: 24 }).windowHours, 24);
  assert.equal(W.parseState(JSON.stringify({ windowHours: 6 }), { windowHours: 24 }).windowHours, 6);
  assert.equal(W.parseState(JSON.stringify({ windowHours: 999 }), { windowHours: 24 }).windowHours, 24);
});

test('validSetting accepts only well-formed changes, key by key', () => {
  const ok = [['zoom', 1.25], ['windowHours', 1], ['windowHours', 168], ['startAtLogin', true], ['hidden', false], ['appearance', 'light'], ['theme', 'custom/my theme']];
  for (const [k, v] of ok) assert.equal(W.validSetting(k, v), true, `${k}=${v}`);
  const bad = [['zoom', 3], ['zoom', '1.5'], ['windowHours', 0], ['windowHours', 169], ['windowHours', 2.5], ['windowHours', '12'],
    ['startAtLogin', 'yes'], ['hidden', 1], ['appearance', 'Dark'], ['theme', '../x'], ['theme', 7], ['anchor', { right: 1, bottom: 1 }], ['toString', 'x'], [undefined, undefined]];
  for (const [k, v] of bad) assert.equal(W.validSetting(k, v), false, `${k}=${v}`);
  assert.deepEqual(W.HOUR_CHOICES.filter((h) => W.validSetting('windowHours', h)), W.HOUR_CHOICES);
});

test('validSetting: notifications only as a whole, well-formed set', () => {
  const all = W.defaultState().notify;
  assert.equal(W.validSetting('notify', all), true);
  assert.equal(W.validSetting('notify', { ...all, done: true, longMinutes: 180 }), true);
  const bad = [{ ...all, sound: 'yes' }, { ...all, longMinutes: 0 }, { ...all, extra: true }, { needs: true }, (({ text, ...rest }) => ({ ...rest, other: true }))(all), [], null, 'all'];
  for (const v of bad) assert.equal(W.validSetting('notify', v), false, JSON.stringify(v));
});

test('validSetting: shortcuts as exactly the pair, families and dock as switches, watch and do not disturb', () => {
  assert.equal(W.validSetting('shortcuts', { toggle: 'CommandOrControl+Alt+A', open: 'CommandOrControl+Alt+O' }), true);
  assert.equal(W.validSetting('shortcuts', { toggle: '', open: '' }), true);
  assert.equal(W.validSetting('shortcuts', { toggle: 'CommandOrControl+Alt+A', open: 'CommandOrControl+Alt+A' }), false);
  assert.equal(W.validSetting('shortcuts', { toggle: '', open: '', extra: 'CommandOrControl+Alt+A' }), false);
  assert.equal(W.validSetting('shortcuts', 'CommandOrControl+Alt+A'), false);
  for (const k of ['families', 'dock']) {
    assert.equal(W.validSetting(k, false), true, k);
    assert.equal(W.validSetting(k, 'true'), false, k);
  }
  assert.equal(W.validSetting('watch', ''), true);
  assert.equal(W.validSetting('watch', 'local_0f1e2d3c-4b5a'), true);
  for (const v of ['local_a&b', 'x', null, 3]) assert.equal(W.validSetting('watch', v), false, String(v));
  for (const v of W.DND_CHOICES) assert.equal(W.validSetting('dnd', v), true, String(v));
  for (const v of [15, -1, undefined, '30', Infinity]) assert.equal(W.validSetting('dnd', v), false, String(v));
});

test('displayHomepage drops the scheme and the fragment', () => {
  assert.equal(W.displayHomepage('https://github.com/ArduusLabs/wilfred#readme'), 'github.com/ArduusLabs/wilfred');
  assert.equal(W.displayHomepage('https://github.com/ArduusLabs/wilfred'), 'github.com/ArduusLabs/wilfred');
  assert.equal(W.displayHomepage(undefined), '');
});

test('writeState writes through a temp file and leaves no temp behind', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'state.json');
  W.writeState(file, { zoom: 1.25 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { zoom: 1.25 });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  // A failure while writing the temp file leaves the old file intact.
  const calls = [];
  const failing = { writeFileSync: () => { throw new Error('disk full'); }, renameSync: () => calls.push('rename') };
  assert.throws(() => W.writeState(file, { zoom: 2 }, failing), /disk full/);
  assert.deepEqual(calls, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { zoom: 1.25 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('defaultAnchor is the bottom-right corner of the work area (the page brings its own margin)', () => {
  assert.deepEqual(W.defaultAnchor({ x: 0, y: 0, width: 2560, height: 1392 }), { right: 2560, bottom: 1392 });
  assert.deepEqual(W.defaultAnchor({ x: -1920, y: 100, width: 1920, height: 1040 }), { right: 0, bottom: 1140 });
});

test('anchorOnScreen accepts a pet on any monitor and rejects one off every monitor', () => {
  const screens = [{ x: 0, y: 0, width: 2560, height: 1392 }, { x: 2560, y: 0, width: 1920, height: 1040 }];
  assert.equal(W.anchorOnScreen({ right: 2548, bottom: 1380 }, screens), true);
  assert.equal(W.anchorOnScreen({ right: 4000, bottom: 900 }, screens), true);
  assert.equal(W.anchorOnScreen({ right: 4000, bottom: 1300 }, screens), false); // below the second monitor
  assert.equal(W.anchorOnScreen({ right: 30, bottom: 500 }, screens), false); // pet mostly off the left edge
  assert.equal(W.anchorOnScreen({ right: 500, bottom: 30 }, screens), false); // mostly off the top
  assert.equal(W.anchorOnScreen({ right: 9000, bottom: 500 }, screens), false);
  assert.equal(W.anchorOnScreen(null, screens), false);
  assert.equal(W.anchorOnScreen({ right: 500, bottom: 500 }, []), false);
});

test('windowBounds grows up and left from the anchor and scales with zoom', () => {
  assert.deepEqual(W.windowBounds({ right: 1000, bottom: 800 }, 300, 1), { x: 584, y: 500, width: 416, height: 300 });
  assert.deepEqual(W.windowBounds({ right: 1000, bottom: 800 }, 300, 1.5), { x: 376, y: 350, width: 624, height: 450 });
  assert.deepEqual(W.windowBounds({ right: 1000, bottom: 800 }, 101, 1.25), { x: 480, y: 674, width: 520, height: 126 });
});

test('pointInside uses half-open bounds', () => {
  const b = { x: 10, y: 20, width: 100, height: 50 };
  assert.equal(W.pointInside({ x: 10, y: 20 }, b), true);
  assert.equal(W.pointInside({ x: 109, y: 69 }, b), true);
  assert.equal(W.pointInside({ x: 110, y: 30 }, b), false);
  assert.equal(W.pointInside({ x: 50, y: 70 }, b), false);
  assert.equal(W.pointInside({ x: 9, y: 30 }, b), false);
  assert.equal(W.pointInside({ x: 50, y: 19 }, b), false);
});

test('sessionUrl only builds a session link from a well-formed id', () => {
  assert.equal(W.sessionUrl('local_0f1e2d3c-4b5a-4968-8776-655443322110'), 'claude://code/continue?session=local_0f1e2d3c-4b5a-4968-8776-655443322110');
  for (const bad of ['', 'local_', 'local_x&evil=1', 'local_a/b', 'cse_123', 'local_' + 'a'.repeat(65), undefined, null]) {
    assert.equal(W.sessionUrl(bad), 'claude://', String(bad));
  }
});

test('loadAvatar returns the first usable picture as a data URL', () => {
  const dir = tmpdir();
  assert.equal(W.loadAvatar(dir), null);
  fs.writeFileSync(path.join(dir, 'avatar.png'), Buffer.from([1, 2, 3]));
  assert.equal(W.loadAvatar(dir), 'data:image/png;base64,AQID');
  fs.writeFileSync(path.join(dir, 'avatar.jpg'), Buffer.from([4]));
  assert.equal(W.loadAvatar(dir), 'data:image/jpeg;base64,BA==');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadAvatar skips folders, oversized files and unreadable files', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'avatar.jpg'));
  assert.equal(W.loadAvatar(dir), null);
  const big = {
    statSync: () => ({ isFile: () => true, size: W.AVATAR_MAX_BYTES + 1 }),
    readFileSync: () => assert.fail('should not read an oversized file'),
  };
  assert.equal(W.loadAvatar(dir, big), null);
  const unreadable = {
    statSync: () => ({ isFile: () => true, size: 10 }),
    readFileSync: () => { throw new Error('EACCES'); },
  };
  assert.equal(W.loadAvatar(dir, unreadable), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validHeight accepts only sane positive heights', () => {
  assert.equal(W.validHeight(120), true);
  assert.equal(W.validHeight(1999), true);
  for (const bad of [0, -1, 2000, NaN, Infinity, '120', undefined]) assert.equal(W.validHeight(bad), false, String(bad));
});

test('the size menu offers Small to Huge and includes the default', () => {
  assert.deepEqual(W.SIZES.map(([l]) => l), ['Small', 'Medium', 'Large', 'Extra large', 'Huge']);
  assert.ok(W.SIZES.some(([, z]) => z === W.DEFAULT_ZOOM));
});

test('clampBounds keeps the whole board on its screen', () => {
  const w = { x: 0, y: 0, width: 2560, height: 1392 };
  // Dragged so most of a 588 px board would hang off the left edge.
  assert.deepEqual(W.clampBounds({ x: -508, y: 400, width: 588, height: 500 }, w), { x: 0, y: 400, width: 588, height: 500 });
  // Off the top, the right and the bottom.
  assert.deepEqual(W.clampBounds({ x: 100, y: -200, width: 588, height: 500 }, w), { x: 100, y: 0, width: 588, height: 500 });
  assert.deepEqual(W.clampBounds({ x: 2300, y: 1200, width: 588, height: 500 }, w), { x: 1972, y: 892, width: 588, height: 500 });
  // Already inside: unchanged.
  assert.deepEqual(W.clampBounds({ x: 10, y: 10, width: 100, height: 100 }, w), { x: 10, y: 10, width: 100, height: 100 });
  // A monitor left of and above the primary (negative coordinates).
  const left = { x: -1920, y: -200, width: 1920, height: 1040 };
  assert.deepEqual(W.clampBounds({ x: -2000, y: -300, width: 588, height: 500 }, left), { x: -1920, y: -200, width: 588, height: 500 });
  // Too tall for the screen: the bottom (Wilfred, who folds the board) stays visible.
  assert.deepEqual(W.clampBounds({ x: 0, y: -100, width: 588, height: 2000 }, w), { x: 0, y: -608, width: 588, height: 2000 });
  // Too wide: the left edge stays visible.
  assert.deepEqual(W.clampBounds({ x: 500, y: 0, width: 3000, height: 100 }, w), { x: 0, y: 0, width: 3000, height: 100 });
});

test('privacyLines: the menu line for the startup check, passed or failed', () => {
  const ok = W.privacyLines({ blocked: ['tcp', 'dns', 'fetch'], open: [] });
  assert.deepEqual(ok, { ok: true, label: "Privacy check passed: Wilfred can't reach any network", detail: 'Checked at startup: 3 ways out tried, all blocked' });
  assert.equal(W.privacyLines({ blocked: ['tcp'], open: [] }).detail, 'Checked at startup: 1 way out tried, all blocked');
  assert.equal(W.privacyLines(null).ok, true, 'no check at all reads as nothing open');
  const one = W.privacyLines({ blocked: ['tcp', 'dns'], open: ['fetch'] });
  assert.deepEqual(one, { ok: false, label: 'Privacy check failed: fetch can reach out', detail: 'Checked at startup: 1 way out open, of 3 tried' });
  const two = W.privacyLines({ blocked: ['tcp'], open: ['fetch', 'dns'] });
  assert.equal(two.label, 'Privacy check failed: fetch and dns can reach out');
  assert.equal(W.privacyLines({ blocked: [], open: ['tcp', 'dns', 'fetch'] }).label, 'Privacy check failed: tcp, dns and fetch can reach out');
});

test('maxListHeight fits the board on short screens and large sizes, within limits', () => {
  // 1080p laptop at 150% scaling: about 688 DIP of work area. At Large (1.5) only 268 CSS px are left for the list.
  assert.equal(W.maxListHeight({ height: 688 }, 1.5), 268);
  assert.equal(W.maxListHeight({ height: 1392 }, 1), 760); // plenty of room: the normal cap
  assert.equal(W.maxListHeight({ height: 400 }, 2), 60); // never smaller than about one row
});

test('windowHours accepts positive numbers and falls back to 12 otherwise', () => {
  assert.equal(W.windowHours('6'), 6);
  assert.equal(W.windowHours('0.5'), 0.5);
  for (const bad of [undefined, '', '12h', '0', '-3', 'Infinity']) assert.equal(W.windowHours(bad), 12, String(bad));
});

test('loginStatus: on only with an enabled entry named Wilfred; other names are stale', () => {
  assert.deepEqual(W.loginStatus(undefined), { on: false, stale: [] });
  assert.deepEqual(W.loginStatus([]), { on: false, stale: [] });
  assert.deepEqual(W.loginStatus([{ name: 'electron.app.Electron', enabled: true }]), { on: false, stale: [{ name: 'electron.app.Electron', enabled: true }] });
  // An old entry you switched off stays remembered as off, so the rename can keep it off.
  assert.deepEqual(W.loginStatus([{ name: 'electron.app.Electron', enabled: false }]).stale, [{ name: 'electron.app.Electron', enabled: false }]);
  assert.deepEqual(W.loginStatus([{ name: 'Wilfred', enabled: true }]), { on: true, stale: [] });
  assert.deepEqual(W.loginStatus([{ name: 'Wilfred' }]), { on: true, stale: [] });
  assert.deepEqual(W.loginStatus([{ name: 'Wilfred', enabled: false }]), { on: false, stale: [] });
});

test('pagePoint turns a screen pointer into page coordinates, or null outside the window', () => {
  const b = { x: 1000, y: 500, width: 588, height: 300 };
  assert.deepEqual(W.pagePoint({ x: 1150, y: 650 }, b, 1.5), { x: 100, y: 100 });
  assert.equal(W.pagePoint({ x: 999, y: 650 }, b, 1.5), null);
  assert.equal(W.pagePoint({ x: 1588, y: 650 }, b, 1.5), null);
});
