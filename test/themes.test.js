const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('../src/themes');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wilfred-th-'));

/** A built-in folder and a userData folder with the given files. */
function setup({ builtin = {}, custom = null } = {}) {
  const root = tmpdir();
  const builtinDir = path.join(root, 'builtin');
  const userDataDir = path.join(root, 'user');
  fs.mkdirSync(builtinDir);
  fs.mkdirSync(userDataDir);
  for (const [name, css] of Object.entries(builtin)) fs.writeFileSync(path.join(builtinDir, name), css);
  if (custom) {
    fs.mkdirSync(path.join(userDataDir, 'themes'));
    for (const [name, css] of Object.entries(custom)) fs.writeFileSync(path.join(userDataDir, 'themes', name), css);
  }
  return { root, builtinDir, userDataDir, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the shipped themes include the default, and BUILTIN_DIR points at them', () => {
  assert.equal(T.BUILTIN_DIR, path.join(__dirname, '..', 'src', 'renderer', 'themes'));
  const ids = T.listThemes({ userDataDir: tmpdir() }).map((t) => t.id);
  assert.ok(ids.includes(T.DEFAULT_THEME), ids.join());
});

test('listThemes: built-ins sorted, then your own sorted, with display names', () => {
  const s = setup({
    builtin: { 'signal.css': 'b', 'bell-board.css': 'a', 'day_book.css': 'c', 'notes.txt': 'x' },
    custom: { 'Zebra.css': 'z', 'my theme.CSS': 'm', 'readme.md': 'x' },
  });
  fs.mkdirSync(path.join(s.userDataDir, 'themes', 'folder.css'));
  const list = T.listThemes(s);
  assert.deepEqual(list.map(({ id, name, custom }) => ({ id, name, custom })), [
    { id: 'bell-board', name: 'Bell board', custom: false },
    { id: 'day_book', name: 'Day book', custom: false },
    { id: 'signal', name: 'Signal', custom: false },
    { id: 'custom/my theme', name: 'my theme', custom: true },
    { id: 'custom/Zebra', name: 'Zebra', custom: true },
  ]);
  assert.equal(list[0].file, path.join(s.builtinDir, 'bell-board.css'));
  assert.equal(list[3].file, path.join(s.userDataDir, 'themes', 'my theme.CSS'));
  s.done();
});

test('listThemes leaves out files whose names cannot be a theme id', () => {
  const s = setup({ custom: { 'a..b.css': '', '.hidden.css': '', 'odd(name).css': '', 'fine.css': '' } });
  assert.deepEqual(T.listThemes(s).map((t) => t.id), ['custom/fine']);
  s.done();
});

test('listThemes never throws: missing folders, and files that vanish mid-listing, give nothing', () => {
  const root = tmpdir();
  assert.deepEqual(T.listThemes({ builtinDir: path.join(root, 'nope'), userDataDir: path.join(root, 'nope') }), []);
  const flaky = { readdirSync: () => ['gone.css'], statSync: () => { throw new Error('ENOENT'); } };
  assert.deepEqual(T.listThemes({ builtinDir: root, userDataDir: root, fsImpl: flaky }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('themeDescription: the first sentence of the leading comment, without its "Name: " lead-in', () => {
  const dayBook = "/* Day book: typography on paper, Wilfred's line as the heading, the state as a word in the margin.\n   A theme is one file like this, applied over style.css. */\n\n:root { --panel: #262420; }\n";
  assert.equal(T.themeDescription(dayBook), "Typography on paper, Wilfred's line as the heading, the state as a word in the margin.");
  assert.equal(T.themeDescription(dayBook.replace(/\n/g, '\r\n')), "Typography on paper, Wilfred's line as the heading, the state as a word in the margin.", 'CRLF');
  // A sentence over two lines is one line; one without a colon is kept whole; one without a stop runs to the comment's end.
  assert.equal(T.themeDescription('\n/* Night: dark\r\n   and quiet. More. */'), 'Dark and quiet.');
  assert.equal(T.themeDescription('/* plain and simple, v1.5 now! Then more. */'), 'Plain and simple, v1.5 now!');
  assert.equal(T.themeDescription('/* Mine: no stop at all */'), 'No stop at all');
  assert.equal(T.themeDescription('/* Why? Because. */'), 'Why?');
  assert.equal(T.themeDescription('/* */'), '');
  // No comment, or a comment that isn't first: nothing.
  assert.equal(T.themeDescription(':root { --x: 1; }'), '');
  assert.equal(T.themeDescription(':root {} /* Late: comment. */'), '');
  assert.equal(T.themeDescription(''), '');
  // An edited copy's seed header says nothing about the look.
  assert.equal(T.themeDescription(T.sealedCopy('Day book', dayBook)), '');
});

test('listThemes describes the built-ins from their own files, even when an edited copy stands in', () => {
  const s = setup({
    builtin: { 'day-book.css': '/* Day book: on paper. More. */\n','signal.css': '.sig{}', 'bell-board.css': '/* Bell board: brass. */' },
    custom: { 'Day book.css': '/* Mine: blue. */ .day{color:blue}', 'Night.css': '/* Night: dark. */' },
  });
  const unreadable = { ...fs, readFileSync: (f, ...a) => (f.endsWith('bell-board.css') ? assert.fail('EACCES') : fs.readFileSync(f, ...a)) };
  assert.deepEqual(T.listThemes({ ...s, fsImpl: unreadable }).map(({ id, edited, description }) => [id, edited, description]), [
    ['bell-board', false, ''],
    ['day-book', true, 'On paper.'],
    ['signal', false, ''],
    ['custom/Night', false, ''],
  ]);
  // The shipped ones all have one.
  for (const t of T.listThemes({ userDataDir: s.root })) assert.ok(t.description.length > 10, t.id);
  s.done();
});

test('isThemeId accepts plain names and custom/ names, nothing that could be a path', () => {
  for (const ok of ['bell-board', 'custom/my theme', 'custom/Ünal 2.0', 'a', 'x'.repeat(80)]) assert.equal(T.isThemeId(ok), true, ok);
  for (const bad of ['', '.hidden', 'custom/.x', 'a..b', 'custom/../x', '../x', 'a/b', 'custom/a/b', 'custom\\x', 'a\\b', 'custom/', 'x'.repeat(81), 'C:x', 42, null, undefined]) {
    assert.equal(T.isThemeId(bad), false, String(bad));
  }
});

test('readTheme returns the CSS of a listed theme, and null for anything else', () => {
  const s = setup({ builtin: { 'signal.css': '.a{}' }, custom: { 'mine.css': '.b{}' } });
  assert.deepEqual(T.readTheme('signal', s), { id: 'signal', name: 'Signal', custom: false, edited: false, file: path.join(s.builtinDir, 'signal.css'), description: '', css: '.a{}' });
  assert.equal(T.readTheme('custom/mine', s).css, '.b{}');
  // Ids are only looked up, never joined into a path.
  fs.writeFileSync(path.join(s.root, 'outside.css'), 'secret');
  for (const id of ['../outside', 'custom/../../outside', 'nope', 'mine', 'custom/signal', '']) assert.equal(T.readTheme(id, s), null, id);
  s.done();
});

test('readTheme returns null for a file over 1 MB or one that cannot be read', () => {
  const s = setup({ builtin: { 'big.css': 'x'.repeat(T.THEME_MAX_BYTES + 1), 'edge.css': 'x'.repeat(T.THEME_MAX_BYTES) } });
  assert.equal(T.readTheme('big', s), null);
  assert.equal(T.readTheme('edge', s).css.length, T.THEME_MAX_BYTES);
  const unreadable = { ...fs, readFileSync: () => { throw new Error('EACCES'); } };
  assert.equal(T.readTheme('edge', { ...s, fsImpl: unreadable }), null);
  s.done();
});

test('resolveTheme falls back to the default, then the first readable theme, then no theme', () => {
  const s = setup({ builtin: { [`${T.DEFAULT_THEME}.css`]: 'default', 'alpha.css': 'first', 'beta.css': 'second' } });
  assert.equal(T.resolveTheme('beta', s).css, 'second');
  assert.equal(T.resolveTheme('custom/gone', s).css, 'default');
  assert.equal(T.resolveTheme(undefined, s).id, T.DEFAULT_THEME);
  fs.rmSync(path.join(s.builtinDir, `${T.DEFAULT_THEME}.css`));
  assert.equal(T.resolveTheme('nope', s).id, 'alpha');
  // The first listed one can't be read: the next one is used.
  const alphaFails = { ...fs, readFileSync: (f, ...a) => (f.endsWith('alpha.css') ? assert.fail('unreadable') : fs.readFileSync(f, ...a)) };
  assert.equal(T.resolveTheme('nope', { ...s, fsImpl: alphaFails }).id, 'beta');
  const noneRead = { ...fs, readFileSync: () => { throw new Error('EACCES'); } };
  assert.deepEqual(T.resolveTheme('nope', { ...s, fsImpl: noneRead }), { id: '', name: '', css: '', custom: false, edited: false, file: '' });
  fs.rmSync(s.builtinDir, { recursive: true });
  assert.deepEqual(T.resolveTheme('nope', s), { id: '', name: '', css: '', custom: false, edited: false, file: '' });
  s.done();
});

test('saveCurrentAsCustom copies the theme under a new name, never overwriting one', () => {
  const s = setup();
  const theme = { id: 'bell-board', name: 'Bell board', css: '.x{}' };
  assert.equal(T.saveCurrentAsCustom(theme, s), 'custom/Bell board copy');
  assert.equal(fs.readFileSync(path.join(s.userDataDir, 'themes', 'Bell board copy.css'), 'utf8'), '.x{}');
  assert.equal(T.saveCurrentAsCustom(theme, s), 'custom/Bell board copy 2');
  assert.equal(T.saveCurrentAsCustom(theme, s), 'custom/Bell board copy 3');
  assert.deepEqual(T.listThemes(s).map((t) => t.id), ['custom/Bell board copy', 'custom/Bell board copy 2', 'custom/Bell board copy 3']);
  // The copy can itself be copied, and is then listed and readable.
  assert.equal(T.saveCurrentAsCustom(T.readTheme('custom/Bell board copy', s), s), 'custom/Bell board copy copy');
  s.done();
});

test('saveCurrentAsCustom keeps the id valid: long names are cut, odd or missing names become "Theme"', () => {
  const s = setup();
  const long = T.saveCurrentAsCustom({ name: 'n'.repeat(79), css: '' }, s);
  assert.equal(long, `custom/${'n'.repeat(60)} copy`);
  assert.ok(T.isThemeId(long));
  assert.equal(T.saveCurrentAsCustom({ name: 'custom/x', css: '' }, s), 'custom/Theme copy');
  assert.equal(T.saveCurrentAsCustom({ name: '', css: '' }, s), 'custom/Theme copy 2');
  assert.equal(T.saveCurrentAsCustom({ css: '' }, s), 'custom/Theme copy 3');
  s.done();
});

test('saveCurrentAsCustom throws when the copy cannot be written', () => {
  const failing = { mkdirSync: () => {}, existsSync: () => false, writeFileSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  assert.throws(() => T.saveCurrentAsCustom({ name: 'A', css: '' }, { userDataDir: 'x', fsImpl: failing }), /disk full/);
});

/** A fake fs.watch whose watcher records closes and lets the test fire events. */
function fakeWatch() {
  const w = { closed: 0, handlers: {}, close() { this.closed++; }, on(ev, fn) { this.handlers[ev] = fn; } };
  return { w, fsImpl: { watch: (dir, fn) => { w.dir = dir; w.fire = fn; return w; } } };
}

test('watchThemes calls back once a burst of changes settles', async () => {
  const { w, fsImpl } = fakeWatch();
  let calls = 0;
  const stop = T.watchThemes('ud', () => calls++, { fsImpl, delayMs: 20, onError: () => assert.fail('no error') });
  assert.equal(w.dir, path.join('ud', 'themes'));
  w.fire('change', 'a.css');
  w.fire('rename', 'a.css');
  w.fire('change', null);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1);
  // Stopping cancels a pending call.
  w.fire('change', 'a.css');
  stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1);
  assert.equal(w.closed, 1);
});

test('watchThemes reports a watcher error and stops', () => {
  const { w, fsImpl } = fakeWatch();
  const errors = [];
  T.watchThemes('ud', () => assert.fail('no change'), { fsImpl, onError: (e) => errors.push(e.message) });
  w.fire('change', 'a.css');
  w.handlers.error(new Error('EPERM'));
  assert.deepEqual(errors, ['EPERM']);
  assert.equal(w.closed, 1);
});

test('watchThemes returns null when the folder cannot be watched (not made yet)', () => {
  const root = tmpdir();
  assert.equal(T.watchThemes(root, () => {}, { onError: () => {} }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('watchThemes sees a real file change in the themes folder', async () => {
  const s = setup({ custom: { 'live.css': 'one' } });
  let resolve;
  const changed = new Promise((r) => { resolve = r; });
  const stop = T.watchThemes(s.userDataDir, resolve, { delayMs: 20, onError: () => {} });
  fs.writeFileSync(path.join(s.userDataDir, 'themes', 'live.css'), 'two');
  await changed;
  stop();
  assert.equal(T.readTheme('custom/live', s).css, 'two');
  s.done();
});

// ---- Copies of the built-ins in your themes folder ----

const BUILTINS = { 'day-book.css': '.day{}\n', 'bell-board.css': '.bell{}\n', 'signal.css': '.sig{}\n' };
const DOCS = '# Themes\n\nWhat a theme can style.\n';
// The app's docs/themes.md, as the test's own file.
const docsFileFor = (s) => {
  const f = path.join(s.root, 'themes.md');
  if (!fs.existsSync(f)) fs.writeFileSync(f, DOCS);
  return f;
};
const seed = (s, extra = {}) => T.seedBuiltins({ ...s, docsFile: docsFileFor(s), ...extra });
const SEEDED = ['Bell board.css', 'Day book.css', 'README.txt', 'Signal.css', T.DOCS_COPY];
const userFile = (s, name) => path.join(s.userDataDir, 'themes', name);
const readUser = (s, name) => fs.readFileSync(userFile(s, name), 'utf8');

test('fnv1a is the 32-bit FNV-1a of the UTF-8 bytes, as 8 hex digits', () => {
  assert.equal(T.fnv1a(''), '811c9dc5');
  assert.equal(T.fnv1a('a'), 'e40c292c');
  assert.equal(T.fnv1a('foobar'), 'bf9cf968');
  assert.match(T.fnv1a('Ünal'), /^[0-9a-f]{8}$/);
});

test('sealedCopy: the header line, a blank line, then the CSS verbatim', () => {
  const text = T.sealedCopy('Day book', '.x{}\n');
  const [header, blank, ...body] = text.split('\n');
  assert.equal(header, `/* Wilfred's built-in theme "Day book", copied here for you. Edit it and Wilfred uses your version (and keeps it when he is updated); delete the file to get the original back. [wilfred-seed:${T.fnv1a('.x{}\n')}] */`);
  assert.equal(blank, '');
  assert.equal(body.join('\n'), '.x{}\n');
  // The hash is of the body with \r\n made \n.
  assert.ok(T.sealedCopy('A', '.x{}\r\n').includes(`[wilfred-seed:${T.fnv1a('.x{}\n')}]`));
});

test('isModifiedCopy: only a copy just as written (line endings aside) is unmodified', () => {
  const copy = T.sealedCopy('Signal', '.a{}\n.b{}\n');
  assert.equal(T.isModifiedCopy(copy), false);
  assert.equal(T.isModifiedCopy(copy.replace(/\n/g, '\r\n')), false);
  assert.equal(T.isModifiedCopy(copy.replace('.b{}', '.b{color:red}')), true);
  assert.equal(T.isModifiedCopy(copy.replace(/\[wilfred-seed:[0-9a-f]+\]/, '')), true);
  assert.equal(T.isModifiedCopy(copy.replace('\n\n', '\n')), true); // no blank line after the header
  assert.equal(T.isModifiedCopy('.a{}'), true); // one line, no header
  assert.equal(T.isModifiedCopy(''), true);
  // The marker counts only on the first line.
  assert.equal(T.isModifiedCopy(`/* mine */\n\n${copy}`), true);
});

test('seedBuiltins: the first run makes the folder, the three copies, the README and the docs', () => {
  const s = setup({ builtin: BUILTINS });
  const r = seed(s);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.written.sort(), SEEDED);
  assert.equal(readUser(s, 'Day book.css'), T.sealedCopy('Day book', '.day{}\n'));
  assert.equal(T.isModifiedCopy(readUser(s, 'Signal.css')), false);
  assert.equal(readUser(s, T.DOCS_COPY), DOCS);
  const readme = readUser(s, 'README.txt');
  assert.ok(readme.startsWith("Wilfred's themes\n\nThe .css files here are Wilfred's built-in themes, copied for you.\n"));
  assert.ok(readme.includes(`What a theme can style is described in "${T.DOCS_COPY}", next to this file.\n`));
  // Nothing written there names a path or an address: a path would carry the user's folder, and so their name.
  for (const name of ['README.txt', T.DOCS_COPY]) assert.doesNotMatch(readUser(s, name), /[\\/]|https?:/, name);
  // Unedited copies don't shadow their built-ins, and are not themes of their own.
  assert.deepEqual(T.listThemes(s).map(({ id, edited, file }) => ({ id, edited, file })), [
    { id: 'bell-board', edited: false, file: path.join(s.builtinDir, 'bell-board.css') },
    { id: 'day-book', edited: false, file: path.join(s.builtinDir, 'day-book.css') },
    { id: 'signal', edited: false, file: path.join(s.builtinDir, 'signal.css') },
  ]);
  assert.equal(T.readTheme('day-book', s).css, '.day{}\n');
  // A second run leaves the copies be and only rewrites the README and the docs.
  assert.deepEqual(seed(s).written, [T.DOCS_COPY, 'README.txt']);
  s.done();
});

test('seedBuiltins: an unedited copy follows the app when the built-in changes, CRLF or not', () => {
  const s = setup({ builtin: BUILTINS });
  seed(s);
  fs.writeFileSync(userFile(s, 'Signal.css'), readUser(s, 'Signal.css').replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(s.builtinDir, 'day-book.css'), '.day{color:blue}\n');
  assert.deepEqual(seed(s).written, ['Day book.css', T.DOCS_COPY, 'README.txt']); // CRLF alone is no change
  assert.equal(readUser(s, 'Day book.css'), T.sealedCopy('Day book', '.day{color:blue}\n'));
  assert.equal(T.readTheme('signal', s).edited, false);
  s.done();
});

test('seedBuiltins never touches an edited copy, which then stands in for its built-in', () => {
  const s = setup({ builtin: BUILTINS });
  seed(s);
  const edited = readUser(s, 'Day book.css').replace('.day{}', '.day{color:red}');
  fs.writeFileSync(userFile(s, 'Day book.css'), edited);
  const unmarked = '.bell{color:green}\n';
  fs.writeFileSync(userFile(s, 'Bell board.css'), unmarked);
  fs.writeFileSync(path.join(s.builtinDir, 'day-book.css'), '.day{v2}\n');
  fs.writeFileSync(path.join(s.builtinDir, 'bell-board.css'), '.bell{v2}\n');
  assert.deepEqual(seed(s).written, [T.DOCS_COPY, 'README.txt']);
  assert.equal(readUser(s, 'Day book.css'), edited);
  assert.equal(readUser(s, 'Bell board.css'), unmarked);
  assert.deepEqual(T.readTheme('day-book', s), { id: 'day-book', name: 'Day book', custom: false, edited: true, file: userFile(s, 'Day book.css'), description: '', css: edited });
  assert.equal(T.readTheme('bell-board', s).css, unmarked);
  assert.equal(T.resolveTheme('bell-board', s).edited, true);
  assert.equal(T.readTheme('signal', s).edited, false);
  // Deleting the copy brings the original back.
  fs.rmSync(userFile(s, 'Day book.css'));
  assert.equal(T.resolveTheme('day-book', s).css, '.day{v2}\n');
  s.done();
});

test('listThemes: copies are matched case-blind, never listed as custom, and customs beside them still are', () => {
  const s = setup({ builtin: BUILTINS, custom: { 'day BOOK.css': 'mine', 'Signal.CSS': T.sealedCopy('Signal', '.sig{}\n'), 'Night.css': 'n' } });
  const list = T.listThemes(s);
  assert.deepEqual(list.map((t) => `${t.id}${t.edited ? '*' : ''}`), ['bell-board', 'day-book*', 'signal', 'custom/Night']);
  assert.equal(list[1].file, userFile(s, 'day BOOK.css'));
  // The copies' names are taken: no custom theme can be called that.
  for (const id of ['custom/Day book', 'custom/day BOOK', 'custom/Signal']) assert.equal(T.readTheme(id, s), null, id);
  s.done();
});

test('listThemes passes over an edited copy that is too big or cannot be read', () => {
  const s = setup({ builtin: BUILTINS, custom: { 'Day book.css': 'x'.repeat(T.THEME_MAX_BYTES + 1), 'Signal.css': 'edited' } });
  const unreadable = { ...fs, readFileSync: (f, ...a) => (f.endsWith('Signal.css') ? assert.fail('EACCES') : fs.readFileSync(f, ...a)) };
  const list = T.listThemes({ ...s, fsImpl: unreadable });
  assert.deepEqual(list.map((t) => [t.id, t.edited]), [['bell-board', false], ['day-book', false], ['signal', false]]);
  s.done();
});

test('seedBuiltins makes a missing userData folder too, skips built-ins whose names cannot be an id, and needs no docs', () => {
  const s = setup({ builtin: { ...BUILTINS, 'a..b.css': 'x' } });
  const nested = path.join(s.root, 'not', 'yet');
  const r = T.seedBuiltins({ builtinDir: s.builtinDir, userDataDir: nested });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(fs.readdirSync(path.join(nested, 'themes')).sort(), ['Bell board.css', 'Day book.css', 'README.txt', 'Signal.css']);
  // Docs that can't be read are reported; everything else is still written.
  const r2 = T.seedBuiltins({ builtinDir: s.builtinDir, userDataDir: nested, docsFile: path.join(s.root, 'missing.md') });
  assert.equal(r2.errors.length, 1);
  assert.match(r2.errors[0], /^could not read the theme docs: ENOENT/);
  assert.deepEqual(r2.written, ['README.txt']);
  s.done();
});

test('seedBuiltins reports problems without throwing', () => {
  const s = setup({ builtin: BUILTINS });
  const err = (code) => Object.assign(new Error(code), { code });
  // The folder can't be made: nothing else is tried.
  const noDir = { ...fs, mkdirSync: () => { throw err('EACCES'); } };
  const r1 = seed(s, { fsImpl: noDir });
  assert.deepEqual(r1.written, []);
  assert.equal(r1.errors.length, 1);
  assert.match(r1.errors[0], /could not create .*themes: EACCES/);
  // Writes fail: each is reported.
  const noWrite = { ...fs, writeFileSync: () => { throw err('ENOSPC'); } };
  const r2 = seed(s, { fsImpl: noWrite });
  assert.deepEqual(r2.written, []);
  assert.deepEqual(r2.errors.sort(), SEEDED.map((n) => `could not write ${n}: ENOSPC`));
  // A built-in can't be read, and a copy can't be read (other than missing): both skipped and reported.
  const badReads = {
    ...fs,
    readFileSync: (f, ...a) => {
      if (f.endsWith('signal.css')) throw err('EIO');
      if (f.endsWith('Day book.css')) throw err('EPERM');
      return fs.readFileSync(f, ...a);
    },
  };
  const r3 = seed(s, { fsImpl: badReads });
  assert.deepEqual(r3.written.sort(), ['Bell board.css', 'README.txt', T.DOCS_COPY]);
  assert.deepEqual(r3.errors, ['could not read Day book.css: EPERM', 'could not read built-in signal: EIO']);
  s.done();
});
