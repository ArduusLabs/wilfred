// Themes: one CSS file each, applied over style.css. Built-in ones ship in renderer/themes; your
// own go in <userData>/themes, next to copies of the built-ins ("Day book.css", ...) to start from.
// Kept free of Electron so it can be unit tested.

const fs = require('node:fs');
const path = require('node:path');
const { validThemeId } = require('./window-logic');

const DEFAULT_THEME = 'day-book';
const BUILTIN_DIR = path.join(__dirname, 'renderer', 'themes');
const CUSTOM_PREFIX = 'custom/';
const THEME_MAX_BYTES = 1024 * 1024;
const NO_THEME = { id: '', name: '', css: '', custom: false, edited: false, file: '' };

const customDir = (userDataDir) => path.join(userDataDir, 'themes');

/** `bell-board` → `Bell board`. */
function builtinName(base) {
  const words = base.replace(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The .css files in `dir` as [base name, full path], sorted; nothing if the folder can't be read. */
function cssFiles(dir, fsImpl) {
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => /\.css$/i.test(n))) {
    const file = path.join(dir, name);
    try {
      if (fsImpl.statSync(file).isFile()) out.push([name.slice(0, -4), file]);
    } catch {
      // vanished or unreadable: leave it out
    }
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

const lf = (text) => text.replace(/\r\n/g, '\n');

/** FNV-1a, 32 bits, over the UTF-8 bytes, as 8 hex digits: enough to tell an edit, no crypto needed. */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

const SEED_MARK = /\[wilfred-seed:([0-9a-f]{8})\]/;

/** A built-in's copy for your themes folder: a header line carrying the body's hash, a blank line, the CSS. */
function sealedCopy(name, css) {
  const header = `/* Wilfred's built-in theme "${name}", copied here for you. Edit it and Wilfred uses your version `
    + `(and keeps it when he is updated); delete the file to get the original back. [wilfred-seed:${fnv1a(lf(css))}] */`;
  return `${header}\n\n${css}`;
}

/** True unless `text` is a copy just as Wilfred wrote it (line endings aside). No marker counts as edited. */
function isModifiedCopy(text) {
  const t = lf(text);
  const nl = t.indexOf('\n');
  const mark = nl < 0 ? null : SEED_MARK.exec(t.slice(0, nl));
  if (!mark || t[nl + 1] !== '\n') return true;
  return fnv1a(t.slice(nl + 2)) !== mark[1];
}

/** Whether your copy of a built-in is edited and usable; a copy too big or unreadable is passed over. */
function isEditedCopy(file, fsImpl) {
  try {
    if (fsImpl.statSync(file).size > THEME_MAX_BYTES) return false;
    return isModifiedCopy(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * What a theme is, for the settings: the first sentence of the file's leading comment, without its
 * "Name: " lead-in. A copy's seed header says nothing about the look, so it gives ''.
 */
function themeDescription(css) {
  const comment = /^\s*\/\*([\s\S]*?)\*\//.exec(css);
  if (!comment || SEED_MARK.test(comment[1])) return '';
  const text = comment[1].replace(/\s+/g, ' ').trim();
  const sentence = (/^.*?[.!?](?= |$)/.exec(text) || [text])[0].replace(/^[^:.!?]{1,40}: /, '');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** A built-in's description, from its own file (small; an unreadable one just has none). */
function builtinDescription(file, fsImpl) {
  try {
    return themeDescription(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

/**
 * Every theme: built-ins first, then your own. Files whose names can't be an id are left out. A
 * file named after a built-in ("Day book.css") is that built-in's copy, never a theme of its own:
 * once edited it stands in for the built-in (`edited: true`, its file), keeping the built-in's
 * description.
 */
function listThemes({ builtinDir = BUILTIN_DIR, userDataDir, fsImpl = fs }) {
  const builtins = cssFiles(builtinDir, fsImpl).map(([base, file]) => ({
    id: base, name: builtinName(base), custom: false, edited: false, file, description: builtinDescription(file, fsImpl),
  }));
  // Matched case-blind: on Windows "day book.css" is the same file as "Day book.css".
  const byName = new Map(builtins.map((t) => [t.name.toLowerCase(), t]));
  const customs = [];
  for (const [base, file] of cssFiles(customDir(userDataDir), fsImpl)) {
    const builtin = byName.get(base.toLowerCase());
    if (!builtin) customs.push({ id: CUSTOM_PREFIX + base, name: base, custom: true, edited: false, file, description: '' });
    else if (isEditedCopy(file, fsImpl)) Object.assign(builtin, { edited: true, file });
  }
  return [...builtins, ...customs].filter((t) => validThemeId(t.id));
}

// The theme author's page (docs/themes.md), copied next to the README. Nothing written into the
// folder names a path: a path would carry the user's folder, and so their name.
const DOCS_COPY = 'What a theme can style.md';

const README = `Wilfred's themes

The .css files here are Wilfred's built-in themes, copied for you.

- Edit one and save: Wilfred uses your version right away while that theme is selected
  (Settings > Appearance then marks it "edited"), and keeps it when he is updated.
  Delete the file to get the original back.
- To make your own theme, copy one of these files under a new name. It appears in
  Settings > Appearance under that name.
  "Save current theme as a custom theme" there does the copy for you.
- Your edits apply as you save; there is no need to restart.

What a theme can style is described in "${DOCS_COPY}", next to this file.

A theme is plain CSS over Wilfred's page. It can't load fonts, images or anything else from
the internet: Wilfred has no network access, on purpose.
`;

/**
 * Makes sure your themes folder holds a copy of every built-in, a README and the theme docs
 * (`docsFile`, when given), so there is something to start from. Missing copies are written,
 * unedited ones follow the app's version, edited ones are never touched. Returns the files written
 * and the problems met; never throws.
 */
function seedBuiltins({ builtinDir = BUILTIN_DIR, userDataDir, docsFile, fsImpl = fs }) {
  const dir = customDir(userDataDir);
  const written = [];
  const errors = [];
  const write = (name, text) => {
    try {
      fsImpl.writeFileSync(path.join(dir, name), text);
      written.push(name);
    } catch (e) {
      errors.push(`could not write ${name}: ${e.message}`);
    }
  };
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { written, errors: [`could not create ${dir}: ${e.message}`] };
  }
  for (const [base, file] of cssFiles(builtinDir, fsImpl)) {
    if (!validThemeId(base)) continue;
    const name = `${builtinName(base)}.css`;
    let want;
    try {
      want = sealedCopy(builtinName(base), fsImpl.readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(`could not read built-in ${base}: ${e.message}`);
      continue;
    }
    let have = null;
    try {
      have = fsImpl.readFileSync(path.join(dir, name), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') {
        errors.push(`could not read ${name}: ${e.message}`);
        continue;
      }
    }
    // Line endings alone are no reason to rewrite (an editor or git may change them).
    if (have === null || (!isModifiedCopy(have) && lf(have) !== lf(want))) write(name, want);
  }
  if (docsFile) {
    try {
      write(DOCS_COPY, fsImpl.readFileSync(docsFile, 'utf8'));
    } catch (e) {
      errors.push(`could not read the theme docs: ${e.message}`);
    }
  }
  write('README.txt', README);
  return { written, errors };
}

/** One theme with its CSS, or null. The file comes only from the listing, never from the id itself. */
function readTheme(id, { builtinDir = BUILTIN_DIR, userDataDir, fsImpl = fs }) {
  const theme = listThemes({ builtinDir, userDataDir, fsImpl }).find((t) => t.id === id);
  if (!theme) return null;
  try {
    if (fsImpl.statSync(theme.file).size > THEME_MAX_BYTES) return null;
    return { ...theme, css: fsImpl.readFileSync(theme.file, 'utf8') };
  } catch {
    return null;
  }
}

/** The theme for `id`, else the default, else the first one that reads, else no theme. Never throws. */
function resolveTheme(id, opts) {
  const found = readTheme(id, opts) || readTheme(DEFAULT_THEME, opts);
  if (found) return found;
  for (const t of listThemes(opts)) {
    const read = readTheme(t.id, opts);
    if (read) return read;
  }
  return { ...NO_THEME };
}

/**
 * Copies a theme's CSS into your themes folder as "<name> copy.css" (then "copy 2", ...), never
 * overwriting a file. Returns the new theme's id; throws if it can't be written.
 */
function saveCurrentAsCustom(theme, { userDataDir, fsImpl = fs }) {
  const dir = customDir(userDataDir);
  fsImpl.mkdirSync(dir, { recursive: true });
  // Short enough to leave room for " copy NNN" within the id limit, and a plain file name.
  const short = String(theme.name || '').slice(0, 60).trim();
  const base = validThemeId(CUSTOM_PREFIX + short) ? short : 'Theme';
  const nameFor = (n) => `${base} copy${n > 1 ? ` ${n}` : ''}`;
  let n = 1;
  while (fsImpl.existsSync(path.join(dir, `${nameFor(n)}.css`))) n++;
  // 'wx': should a file of that name appear meanwhile, fail rather than overwrite it.
  fsImpl.writeFileSync(path.join(dir, `${nameFor(n)}.css`), theme.css, { flag: 'wx' });
  return CUSTOM_PREFIX + nameFor(n);
}

/**
 * Watches your themes folder and calls `onChange` once a burst of changes settles (editors save
 * in several steps). Returns a stop function, or null when the folder can't be watched (not made
 * yet). On a watcher error it stops and reports it, so the caller can watch again later.
 */
function watchThemes(userDataDir, onChange, { fsImpl = fs, delayMs = 200, onError } = {}) {
  let timer = null;
  let watcher;
  try {
    watcher = fsImpl.watch(customDir(userDataDir), () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, delayMs);
    });
  } catch {
    return null;
  }
  const stop = () => {
    clearTimeout(timer);
    watcher.close();
  };
  watcher.on('error', (e) => {
    stop();
    onError(e);
  });
  return stop;
}

module.exports = {
  DEFAULT_THEME,
  BUILTIN_DIR,
  THEME_MAX_BYTES,
  customDir,
  isThemeId: validThemeId,
  listThemes,
  readTheme,
  resolveTheme,
  saveCurrentAsCustom,
  seedBuiltins,
  sealedCopy,
  isModifiedCopy,
  themeDescription,
  fnv1a,
  DOCS_COPY,
  watchThemes,
};
