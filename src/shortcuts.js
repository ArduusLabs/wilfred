// The global keyboard shortcuts you may pick in Settings. Only these few are offered, so a saved
// setting can never register some other key combination with the operating system. Pure.

/** [label, Electron accelerator] for each choice; '' is no shortcut at all. */
const SHORTCUT_CHOICES = [
  ['Off', ''],
  ['Ctrl+Alt+A', 'CommandOrControl+Alt+A'],
  ['Ctrl+Shift+A', 'CommandOrControl+Shift+A'],
  ['Ctrl+Alt+Space', 'CommandOrControl+Alt+Space'],
  ['Ctrl+Alt+O', 'CommandOrControl+Alt+O'],
  ['Ctrl+Shift+O', 'CommandOrControl+Shift+O'],
];

/** toggle: show or hide the board; open: open the session that needs you most. Off until chosen. */
const DEFAULT_SHORTCUTS = { toggle: '', open: '' };

/** Whether `v` is one of the offered accelerators, or '' (off). */
function validShortcut(v) {
  return typeof v === 'string' && SHORTCUT_CHOICES.some(([, accel]) => accel === v);
}

/**
 * How a shortcut is written on this platform: Ctrl+Alt+A, or Cmd+Option+A on a Mac (where
 * CommandOrControl is the Command key). Anything not offered reads as Off.
 */
function shortcutLabel(accel, platform = process.platform) {
  if (!accel || !validShortcut(accel)) return 'Off';
  const mac = platform === 'darwin';
  return accel.replace('CommandOrControl', mac ? 'Cmd' : 'Ctrl').replace('Alt', mac ? 'Option' : 'Alt');
}

/** Whether `obj` is a usable pair of shortcuts: both offered ones, and not the same key twice. */
function validShortcuts(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!validShortcut(obj.toggle) || !validShortcut(obj.open)) return false;
  return obj.toggle === '' || obj.toggle !== obj.open;
}

module.exports = { SHORTCUT_CHOICES, DEFAULT_SHORTCUTS, validShortcut, shortcutLabel, validShortcuts };
