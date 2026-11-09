// Decisions the main process makes, kept free of Electron so they can be unit tested.

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SHORTCUTS, validShortcuts } = require('./shortcuts');
const { DEFAULT_NOTIFY } = require('./notify');

const WIDTH = 416; // CSS pixels: the 378 px board plus 38 px of transparent room for its shadow; times the zoom
const SIZES = [['Small', 1], ['Medium', 1.25], ['Large', 1.5], ['Extra large', 1.75], ['Huge', 2]];
const DEFAULT_ZOOM = 1.5;
// The page leaves transparent room for its shadow, so the window can sit right at the edge.
const MARGIN = 0;
// How much of the pet must sit on a screen for it to count as visible.
const MIN_VISIBLE = 70;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/;
// A theme id: a file name without .css, optionally under custom/. Letters, digits, spaces, dots,
// underscores and dashes only, so it can never name a path outside the themes folders.
const THEME_ID = /^(custom\/)?[\p{L}\p{N}_ -][\p{L}\p{N}._ -]*$/u;
const THEME_ID_MAX = 80;
// Hours of sessions the board may show (the settings offer HOUR_CHOICES), and the window's light/dark.
const MAX_WINDOW_HOURS = 168;
const HOUR_CHOICES = [6, 12, 24, 48];
const APPEARANCES = ['system', 'light', 'dark'];
// How long "runs long" may be set to, in minutes; and the do-not-disturb choices (null: until off).
const LONG_MINUTES_MIN = 5;
const LONG_MINUTES_MAX = 180;
const DND_CHOICES = [0, 30, 60, 120, null];

function defaultState() {
  // hidden: kept out of screen shares and recordings, since the board shows prompt text.
  // theme: '' means the default theme. appearance: Electron's nativeTheme.themeSource.
  // families: side sessions nest under the session that started them. dock: also give Wilfred a
  // Dock icon (macOS; opt-in, the menu bar is home). watch: the session Wilfred's bubble follows, '' for none.
  // toastActivator: the notification activator id Electron registered on Windows, kept so that it
  // stays one id (and one registry record) across runs and across switching notifications off and on.
  return {
    anchor: null, collapsed: false, zoom: DEFAULT_ZOOM, hidden: true, theme: '', windowHours: 12, appearance: 'system',
    notify: { ...DEFAULT_NOTIFY }, shortcuts: { ...DEFAULT_SHORTCUTS }, families: true, dock: false, watch: '', toastActivator: '',
  };
}

/** A COM class id as Windows writes it: braces, five groups of hex digits. */
const validActivator = (v) => typeof v === 'string' && /^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i.test(v);

/** Whether `value` has the shape of a theme id (see THEME_ID). */
function validThemeId(value) {
  return typeof value === 'string' && value.length <= THEME_ID_MAX && THEME_ID.test(value) && !value.includes('..');
}

const validHours = (h) => Number.isInteger(h) && h >= 1 && h <= MAX_WINDOW_HOURS;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validWatch = (v) => v === '' || (typeof v === 'string' && SESSION_ID.test(v));

/** Whether one notification setting has the right shape: on/off switches, and minutes for "runs long". */
function validNotifyField(key, value) {
  if (key === 'longMinutes') return Number.isInteger(value) && value >= LONG_MINUTES_MIN && value <= LONG_MINUTES_MAX;
  return Object.hasOwn(DEFAULT_NOTIFY, key) && typeof value === 'boolean';
}

/** The notification settings in `v`, field by field, with the defaults for any that are missing or odd. */
function parseNotify(v) {
  const notify = { ...DEFAULT_NOTIFY };
  if (!isPlainObject(v)) return notify;
  for (const key of Object.keys(DEFAULT_NOTIFY)) if (validNotifyField(key, v[key])) notify[key] = v[key];
  return notify;
}

/** Whether `v` is a complete set of notification settings, every one well-formed and nothing else. */
function validNotify(v) {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length === Object.keys(DEFAULT_NOTIFY).length && keys.every((k) => validNotifyField(k, v[k]));
}

/**
 * Reads saved settings, keeping only values of the right shape. Never throws. `defaults` override
 * the built-in ones for what the file doesn't have (the hours from WILFRED_WINDOW_HOURS).
 */
function parseState(text, defaults = {}) {
  const state = { ...defaultState(), ...defaults };
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    return state;
  }
  if (!s || typeof s !== 'object') return state;
  const a = s.anchor;
  if (a && Number.isFinite(a.right) && Number.isFinite(a.bottom)) state.anchor = { right: a.right, bottom: a.bottom };
  state.collapsed = s.collapsed === true;
  if (typeof s.hidden === 'boolean') state.hidden = s.hidden;
  if (SIZES.some(([, z]) => z === s.zoom)) state.zoom = s.zoom;
  if (validThemeId(s.theme)) state.theme = s.theme;
  if (validHours(s.windowHours)) state.windowHours = s.windowHours;
  if (APPEARANCES.includes(s.appearance)) state.appearance = s.appearance;
  state.notify = parseNotify(s.notify);
  if (validShortcuts(s.shortcuts)) state.shortcuts = { toggle: s.shortcuts.toggle, open: s.shortcuts.open };
  if (typeof s.families === 'boolean') state.families = s.families;
  if (typeof s.dock === 'boolean') state.dock = s.dock;
  if (validWatch(s.watch)) state.watch = s.watch;
  if (validActivator(s.toastActivator)) state.toastActivator = s.toastActivator;
  return state;
}

/**
 * Whether a change sent by the settings window has the right shape for its key. A theme must also
 * be one that is listed (checked by the caller); unknown keys are refused.
 */
function validSetting(key, value) {
  switch (key) {
    case 'zoom': return SIZES.some(([, z]) => z === value);
    case 'windowHours': return validHours(value);
    case 'startAtLogin':
    case 'families':
    case 'dock':
    case 'hidden': return typeof value === 'boolean';
    case 'notify': return validNotify(value);
    // Exactly the two shortcuts, so nothing else rides along into the saved settings.
    case 'shortcuts': return validShortcuts(value) && Object.keys(value).length === 2;
    case 'watch': return validWatch(value);
    case 'dnd': return DND_CHOICES.includes(value);
    case 'appearance': return APPEARANCES.includes(value);
    case 'theme': return validThemeId(value);
    default: return false;
  }
}

/** The project page as About shows it: no scheme, no fragment. */
function displayHomepage(url) {
  return typeof url === 'string' ? url.replace(/^https:\/\//, '').replace(/#.*$/, '') : '';
}

/** Writes settings via a temp file and rename, so a crash mid-write cannot leave a broken file. */
function writeState(file, state, fsImpl = fs) {
  const tmp = file + '.tmp';
  fsImpl.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fsImpl.renameSync(tmp, file);
}

/** The bottom-right corner of a work area, inset a little. */
function defaultAnchor(workArea) {
  return { right: workArea.x + workArea.width - MARGIN, bottom: workArea.y + workArea.height - MARGIN };
}

/** Whether the pet (anchored by its bottom-right corner) is on one of the given work areas. */
function anchorOnScreen(anchor, workAreas) {
  if (!anchor) return false;
  return workAreas.some((w) =>
    anchor.right - MIN_VISIBLE >= w.x - 1 && anchor.right <= w.x + w.width + 1 &&
    anchor.bottom - MIN_VISIBLE >= w.y - 1 && anchor.bottom <= w.y + w.height + 1);
}

/** Window bounds for a page of `cssHeight` CSS pixels at `zoom`, growing up and left from the anchor. */
function windowBounds(anchor, cssHeight, zoom) {
  const width = Math.round(WIDTH * zoom);
  const height = Math.round(cssHeight * zoom);
  return { x: Math.round(anchor.right - width), y: Math.round(anchor.bottom - height), width, height };
}

/**
 * Moves bounds the least distance needed to lie inside the work area. If too tall even so, the
 * bottom (Wilfred himself, who folds the board) stays on screen; if too wide, the left edge does.
 */
function clampBounds(b, w) {
  const x = Math.max(w.x, Math.min(b.x, w.x + w.width - b.width));
  const y = b.height > w.height ? w.y + w.height - b.height : Math.max(w.y, Math.min(b.y, w.y + w.height - b.height));
  return { ...b, x, y };
}

/** Where the pointer is in page (CSS) coordinates, or null when it is outside the window. */
function pagePoint(cursor, b, zoom) {
  if (!pointInside(cursor, b)) return null;
  return { x: (cursor.x - b.x) / zoom, y: (cursor.y - b.y) / zoom };
}

// Room the page needs around the session list: padding, the header and Wilfred himself.
const CHROME_CSS_HEIGHT = 190;
const MIN_LIST_HEIGHT = 60;
const MAX_LIST_HEIGHT = 760;

/** The tallest the session list may be (CSS px) so the whole board fits the work area at `zoom`. */
function maxListHeight(workArea, zoom) {
  const fits = Math.floor(workArea.height / zoom) - CHROME_CSS_HEIGHT;
  return Math.max(MIN_LIST_HEIGHT, Math.min(MAX_LIST_HEIGHT, fits));
}

function pointInside(p, b) {
  return p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
}

/** The app's own link for "continue this session"; anything else just opens the app. */
function sessionUrl(id) {
  return SESSION_ID.test(String(id)) ? `claude://code/continue?session=${id}` : 'claude://';
}

/** Your own picture for Wilfred (avatar.jpg/.jpeg/.png/.webp in `dir`) as a data URL, or null. */
function loadAvatar(dir, fsImpl = fs) {
  for (const [ext, mime] of Object.entries(AVATAR_TYPES)) {
    const p = path.join(dir, `avatar${ext}`);
    try {
      const st = fsImpl.statSync(p);
      if (!st.isFile() || st.size > AVATAR_MAX_BYTES) continue;
      return `data:${mime};base64,${fsImpl.readFileSync(p).toString('base64')}`;
    } catch {
      // not there, or unreadable: try the next type
    }
  }
  return null;
}

// The name Wilfred's entry has in Windows' startup list (Task Manager shows it).
const LOGIN_NAME = 'Wilfred';

/**
 * Reads Wilfred's startup entries (Electron's launchItems for this exe and app folder): whether
 * he starts with Windows, and older entries under another name to replace.
 */
function loginStatus(launchItems) {
  const items = launchItems || [];
  return {
    on: items.some((i) => i.name === LOGIN_NAME && i.enabled !== false),
    // Older entries under another name, and whether you had left them switched on.
    stale: items.filter((i) => i.name !== LOGIN_NAME).map((i) => ({ name: i.name, enabled: i.enabled !== false })),
  };
}

/** Hours of sessions to show: the env value when it is a positive number, else 12. */
function windowHours(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

/** A usable resize request from the page: a positive CSS height below a sane cap. */
function validHeight(h) {
  return Number.isFinite(h) && h > 0 && h < 2000;
}

/**
 * The privacy line in the menu, from the startup network check ({blocked, open}: the ways out
 * tried): what passed, or, should the lock ever not hold, what can get out.
 */
function privacyLines(check) {
  const open = (check && check.open) || [];
  const blocked = (check && check.blocked) || [];
  const ways = (n) => `${n} way${n === 1 ? '' : 's'} out`;
  if (!open.length) {
    return { ok: true, label: "Privacy check passed: Wilfred can't reach any network", detail: `Checked at startup: ${ways(blocked.length)} tried, all blocked` };
  }
  const list = open.length > 1 ? `${open.slice(0, -1).join(', ')} and ${open[open.length - 1]}` : open[0];
  return { ok: false, label: `Privacy check failed: ${list} can reach out`, detail: `Checked at startup: ${ways(open.length)} open, of ${open.length + blocked.length} tried` };
}

module.exports = {
  WIDTH,
  SIZES,
  HOUR_CHOICES,
  APPEARANCES,
  DND_CHOICES,
  DEFAULT_ZOOM,
  AVATAR_MAX_BYTES,
  defaultState,
  parseState,
  validSetting,
  displayHomepage,
  validThemeId,
  writeState,
  defaultAnchor,
  anchorOnScreen,
  windowBounds,
  clampBounds,
  pagePoint,
  maxListHeight,
  pointInside,
  sessionUrl,
  loadAvatar,
  validHeight,
  windowHours,
  privacyLines,
  LOGIN_NAME,
  loginStatus,
};
