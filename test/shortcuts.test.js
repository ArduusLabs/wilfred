const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/shortcuts');

test('validShortcut accepts only the offered accelerators, or off', () => {
  for (const [, accel] of S.SHORTCUT_CHOICES) assert.equal(S.validShortcut(accel), true, accel);
  // Anything else could register a key combination nobody chose, so it is refused.
  for (const bad of ['Alt+F4', 'commandorcontrol+alt+a', 'CommandOrControl+Alt+A ', null, undefined, 5, {}]) {
    assert.equal(S.validShortcut(bad), false, String(bad));
  }
});

test('shortcutLabel writes the shortcut as the platform names its keys', () => {
  assert.equal(S.shortcutLabel('CommandOrControl+Alt+A', 'win32'), 'Ctrl+Alt+A');
  assert.equal(S.shortcutLabel('CommandOrControl+Alt+A', 'linux'), 'Ctrl+Alt+A');
  assert.equal(S.shortcutLabel('CommandOrControl+Alt+A', 'darwin'), 'Cmd+Option+A');
  assert.equal(S.shortcutLabel('CommandOrControl+Shift+O', 'darwin'), 'Cmd+Shift+O');
  assert.equal(S.shortcutLabel('CommandOrControl+Alt+Space', 'darwin'), 'Cmd+Option+Space');
  assert.equal(S.shortcutLabel('', 'win32'), 'Off');
  assert.equal(S.shortcutLabel('Alt+F4', 'win32'), 'Off', 'never offered, so never on');
  // Off this machine's platform by default; on every platform the Windows labels match the choices.
  assert.equal(S.shortcutLabel('CommandOrControl+Alt+O'), S.shortcutLabel('CommandOrControl+Alt+O', process.platform));
  for (const [label, accel] of S.SHORTCUT_CHOICES) assert.equal(S.shortcutLabel(accel, 'win32'), label);
});

test('validShortcuts: both offered, and never the same key for both (two offs are fine)', () => {
  assert.equal(S.validShortcuts(S.DEFAULT_SHORTCUTS), true);
  assert.equal(S.validShortcuts({ toggle: 'CommandOrControl+Alt+A', open: '' }), true);
  assert.equal(S.validShortcuts({ toggle: '', open: 'CommandOrControl+Alt+O' }), true);
  assert.equal(S.validShortcuts({ toggle: 'CommandOrControl+Alt+A', open: 'CommandOrControl+Alt+O' }), true);
  assert.equal(S.validShortcuts({ toggle: 'CommandOrControl+Alt+A', open: 'CommandOrControl+Alt+A' }), false);
  assert.equal(S.validShortcuts({ toggle: 'Alt+F4', open: '' }), false);
  assert.equal(S.validShortcuts({ toggle: '', open: 'Alt+F4' }), false);
  assert.equal(S.validShortcuts({ toggle: '' }), false);
  for (const bad of [null, [], 'CommandOrControl+Alt+A']) assert.equal(S.validShortcuts(bad), false, String(bad));
});

test('the shortcuts start off', () => {
  assert.deepEqual(S.DEFAULT_SHORTCUTS, { toggle: '', open: '' });
  assert.deepEqual(S.SHORTCUT_CHOICES[0], ['Off', '']);
});
