// What Wilfred does differently on Windows, macOS and Linux, decided here as small pure functions so
// the tests can drive every platform from any machine. main.js only wires the answers to Electron.
// Why each one is needed is written next to it; the evidence is in the platform research notes.

const fs = require('node:fs');
const path = require('node:path');

// A fixed id for the menu bar item, so macOS keeps it where you dragged it between launches.
const TRAY_GUID = '6f1c2a9e-3b7d-4e85-9a40-2d5c8b71e0f4';
// Wilfred's own launch flags (the Linux launcher's actions use them). Prefixed so they can never
// collide with a Chromium switch.
const COMMANDS = [['--wilfred-toggle', 'toggle'], ['--wilfred-settings', 'settings'], ['--wilfred-quit', 'quit']];
// The most rectangles a page may report for the window's shape (Linux click-through).
const MAX_SHAPE_RECTS = 64;
// Crash recovery: at most one reload per RELOAD_GAP_MS, and none after RELOAD_LIMIT within RELOAD_WINDOW_MS.
const RELOAD_GAP_MS = 2000;
const RELOAD_WINDOW_MS = 30000;
const RELOAD_LIMIT = 5;
// macOS drops a Dock hide/show that comes within a second of the previous one; wait a little longer.
const DOCK_GAP_MS = 1100;

/**
 * The board window's options. Everywhere: transparent, frameless, square-cornered (Windows 11 and
 * Linux round frameless windows, which clips the shadow room), never white while loading, shown
 * later with showInactive only. macOS adds what a floating companion needs there: never full
 * screen, out of Mission Control, and a first click that reaches the page instead of only
 * activating Wilfred.
 */
function boardWindowOptions(platform, { width, height, iconPath, preload }) {
  const options = {
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    icon: iconPath,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
  if (platform === 'darwin') Object.assign(options, { fullscreenable: false, hiddenInMissionControl: true, acceptFirstMouse: true });
  return options;
}

/** The tray picture: a black template pair macOS tints for the menu bar, a PNG for Linux panels. */
function trayImageFor(platform) {
  if (platform === 'darwin') return 'trayTemplate.png';
  if (platform === 'linux') return 'wilfred-32.png';
  return 'tray.png';
}

/**
 * How the tray icon behaves. Linux has no right-click event and no pop-up menu: the menu must be
 * attached (and re-attached when it changes). macOS swallows a quick second click as a double
 * click unless told not to, and keeps the item's place only with a fixed id.
 */
function trayBehaviour(platform) {
  return {
    attachMenu: platform === 'linux',
    rightClick: platform !== 'linux',
    ctrlClickMenu: platform === 'darwin',
    ignoreDoubleClick: platform === 'darwin',
    guid: platform === 'darwin' ? TRAY_GUID : null,
    title: platform === 'darwin',
  };
}

/**
 * The macOS application menu: never drawn (Wilfred has no Dock icon), but its keys still work in
 * Settings: copy and paste, Cmd+Q, Cmd+H, Cmd+W. It also drops the default Cmd+R reload and DevTools.
 */
function macAppMenu() {
  return [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
}

/** The sessions waiting on you: those that need you and those that failed. */
function attentionCount(rows) {
  return (rows || []).filter((r) => r && (r.state === 'needs-you' || r.state === 'failed')).length;
}

/** The Dock badge and menu bar title for those sessions: the number, or nothing. */
function dockBadge(rows) {
  const n = attentionCount(rows);
  return n ? String(n) : '';
}

/**
 * Where that count shows: next to the menu bar icon on macOS; on the Dock icon only while Wilfred
 * is kept in the Dock; on Linux docks that show launcher badges (Ubuntu Dock, KDE).
 */
function badgePlaces(platform, dockOn) {
  const mac = platform === 'darwin';
  return { trayTitle: mac, dock: mac && dockOn, count: platform === 'linux' || (mac && dockOn) };
}

/** Milliseconds to wait before the next Dock hide or show may take effect (0: now). */
function dockWait(lastChange, now) {
  return Math.max(0, lastChange + DOCK_GAP_MS - now);
}

/** Whether the system reports unlocking the screen (powerMonitor's unlock-screen). */
function unlockEventSupported(platform) {
  return platform === 'win32' || platform === 'darwin';
}

/** Whether a window can be kept out of screen shares (setContentProtection). Not on Linux. */
function contentProtectionSupported(platform) {
  return platform !== 'linux';
}

/**
 * What re-asserting the overlay re-applies besides staying on top. Linux ignores skipTaskbar
 * (Wilfred's board is unmanaged there anyway); on macOS the board must keep joining every Space.
 */
function reassertPlan(platform) {
  return { skipTaskbar: platform !== 'linux', allSpaces: platform === 'darwin' };
}

/**
 * Whether to start again through XWayland. On a native Wayland window Wilfred can't place himself,
 * stay on top or read the pointer, and the switch only works on the real command line, so the
 * process relaunches itself with it. Not when you opted out (WILFRED_WAYLAND=1), not without an X
 * server to reach (DISPLAY), and never twice (the relaunch carries the switch).
 */
function relaunchForX11({ platform, env, ozoneSwitch }) {
  return platform === 'linux' && env.XDG_SESSION_TYPE === 'wayland' && env.WILFRED_WAYLAND !== '1' && !!env.DISPLAY && ozoneSwitch !== 'x11';
}

/** The command a launch carries: 'toggle', 'settings', 'quit' or null (the first flag wins). */
function commandIn(argv) {
  for (const arg of argv || []) {
    const hit = COMMANDS.find(([flag]) => flag === arg);
    if (hit) return hit[1];
  }
  return null;
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * The window shape for the page's interactive rectangles (CSS pixels): scaled by the zoom and
 * rounded outwards to whole pixels, so nothing clickable is shaved off. Null for a malformed
 * report (ignored). With nothing usable left, a single pixel in the corner: an empty shape
 * would make the whole window catch clicks again.
 */
function shapeRects(rects, zoom) {
  if (!Array.isArray(rects) || rects.length > MAX_SHAPE_RECTS || !finite(zoom) || zoom <= 0) return null;
  const out = [];
  for (const r of rects) {
    if (!r || !finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h) || r.w <= 0 || r.h <= 0) continue;
    const x = Math.max(0, Math.floor(r.x * zoom));
    const y = Math.max(0, Math.floor(r.y * zoom));
    const width = Math.ceil((r.x + r.w) * zoom) - x;
    const height = Math.ceil((r.y + r.h) * zoom) - y;
    if (width > 0 && height > 0) out.push({ x, y, width, height });
  }
  return out.length ? out : [{ x: 0, y: 0, width: 1, height: 1 }];
}

/** The whole window as a shape: used while dragging, so the pointer can't slip off mid-drag. */
function fullShape(width, height) {
  return [{ x: 0, y: 0, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }];
}

/**
 * Crash recovery for the board: when to reload after a renderer or GPU crash. `times` are the
 * reloads already done or planned. Returns { delay, times } (the times kept, with this reload), or
 * null to give up: a page that keeps crashing would only spin.
 */
function reloadPlan(times, now) {
  const recent = (times || []).filter((t) => now - t < RELOAD_WINDOW_MS);
  if (recent.length >= RELOAD_LIMIT) return null;
  const last = recent.length ? Math.max(...recent) : -Infinity;
  const at = Math.max(now, last + RELOAD_GAP_MS);
  return { delay: at - now, times: [...recent, at] };
}

// ---- Windows: the name on a notification ----

/**
 * The ID Windows knows Wilfred by. The taskbar groups his windows under it, and a notification is
 * named after the Start Menu shortcut that carries it; an app run from its folder has none, so
 * without one Windows names them after the program file: "Electron".
 */
const APP_ID = 'com.arduuslabs.wilfred';

/** Where Windows looks for that shortcut: the user's own Start Menu, no administrator needed. */
function startMenuShortcutPath(appData) {
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Wilfred.lnk');
}

/**
 * What the shortcut says: run this Electron on this app folder, with Wilfred's icon and ID, and the
 * toast activator ID Electron registered (once known), so Windows finds it through Wilfred's entry.
 */
function startMenuShortcut({ execPath, appPath, clsid = '' }) {
  return {
    target: execPath,
    args: `"${appPath}"`,
    cwd: appPath,
    description: 'Wilfred: what every Claude session is doing',
    icon: path.join(appPath, 'assets', 'wilfred.ico'),
    iconIndex: 0,
    appUserModelId: APP_ID,
    ...(clsid ? { toastActivatorClsid: clsid } : {}),
  };
}

/**
 * Electron's own entry, which it writes when a process sends its first notification: named after
 * electron.exe ("Electron"), pointing at the bare exe, carrying the id and an activator ID it mints
 * unless the file already holds one. Wilfred writes this one for the moment Electron looks, so the
 * activator ID stays the same from run to run, then removes it again.
 */
function electronShortcutPath(appData) {
  return path.join(path.dirname(startMenuShortcutPath(appData)), 'Electron.lnk');
}

function electronShortcut({ execPath, clsid }) {
  return { target: execPath, cwd: path.dirname(execPath), appUserModelId: APP_ID, toastActivatorClsid: clsid };
}

/** Whether a shortcut read back from disk still says what Wilfred would write (paths compare without case). */
function shortcutCurrent(read, wanted) {
  if (!read) return false;
  const same = (key) => String(read[key] || '').toLowerCase() === String(wanted[key]).toLowerCase();
  const keys = ['target', 'args', 'icon', 'appUserModelId'];
  if (wanted.toastActivatorClsid) keys.push('toastActivatorClsid');
  return keys.every(same);
}

// ---- the Linux launcher entry (the app menu, the dock, and its right-click actions) ----

/** An XDG base folder from the environment, when it is set to an absolute path; else the default under home. */
function xdgDir(value, home, ...fallback) {
  return typeof value === 'string' && value && path.isAbsolute(value) ? value : path.join(home, ...fallback);
}

/** A value of type string in a desktop entry: backslashes and line breaks escaped. */
function desktopString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/** One quoted argument for a desktop entry's Exec line (freedesktop quoting, then string escaping). */
function execArg(s) {
  return desktopString(`"${String(s).replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%')}"`);
}

/**
 * The launcher entry for Wilfred in the folder `appPath`. Its paths are the ones on this machine,
 * written at runtime (the repository never names one). The window class matches setDesktopName,
 * so the Settings window shows Wilfred's name and icon.
 */
function desktopEntry(appPath) {
  const launcher = path.posix.join(appPath, 'start-wilfred.sh');
  const exec = execArg(launcher);
  return `[Desktop Entry]
Type=Application
Name=Wilfred
Comment=Shows what every Claude session is doing, at a glance
Exec=${exec}
TryExec=${desktopString(launcher)}
Path=${desktopString(appPath)}
Icon=wilfred
Terminal=false
Categories=Utility;
StartupWMClass=wilfred
StartupNotify=false
Actions=show;settings;quit;

[Desktop Action show]
Name=Show or hide Wilfred
Exec=${exec} --wilfred-toggle

[Desktop Action settings]
Name=Settings
Exec=${exec} --wilfred-settings

[Desktop Action quit]
Name=Quit Wilfred
Exec=${exec} --wilfred-quit
`;
}

/** The launcher entry's text and where it and its icon go (under $XDG_DATA_HOME, else ~/.local/share). */
function launcherFiles({ appPath, home, env = {} }) {
  const data = xdgDir(env.XDG_DATA_HOME, home, '.local', 'share');
  return {
    entryPath: path.join(data, 'applications', 'wilfred.desktop'),
    entryText: desktopEntry(appPath),
    iconPath: path.join(data, 'icons', 'hicolor', '256x256', 'apps', 'wilfred.png'),
    iconSource: path.join(appPath, 'assets', 'wilfred-256.png'),
  };
}

/** Adds Wilfred to the app menu: the entry and its icon. */
function installLauncher({ appPath, home, env, fsImpl = fs }) {
  const f = launcherFiles({ appPath, home, env });
  fsImpl.mkdirSync(path.dirname(f.iconPath), { recursive: true });
  fsImpl.copyFileSync(f.iconSource, f.iconPath);
  fsImpl.mkdirSync(path.dirname(f.entryPath), { recursive: true });
  fsImpl.writeFileSync(f.entryPath, f.entryText);
}

/** Takes Wilfred out of the app menu again (both files; already gone is fine). */
function removeLauncher({ appPath, home, env, fsImpl = fs }) {
  const f = launcherFiles({ appPath, home, env });
  fsImpl.rmSync(f.entryPath, { force: true });
  fsImpl.rmSync(f.iconPath, { force: true });
}

/** Whether Wilfred's launcher entry is there. */
function launcherInstalled({ appPath, home, env, fsImpl = fs }) {
  return fsImpl.existsSync(launcherFiles({ appPath, home, env }).entryPath);
}

module.exports = {
  TRAY_GUID,
  DOCK_GAP_MS,
  boardWindowOptions,
  trayImageFor,
  trayBehaviour,
  macAppMenu,
  attentionCount,
  dockBadge,
  badgePlaces,
  dockWait,
  unlockEventSupported,
  contentProtectionSupported,
  reassertPlan,
  relaunchForX11,
  commandIn,
  shapeRects,
  fullShape,
  reloadPlan,
  desktopString,
  execArg,
  desktopEntry,
  launcherFiles,
  installLauncher,
  removeLauncher,
  launcherInstalled,
  APP_ID,
  startMenuShortcutPath,
  startMenuShortcut,
  electronShortcutPath,
  electronShortcut,
  shortcutCurrent,
};
