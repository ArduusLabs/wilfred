// Looks at the real app the way a person would: starts Wilfred on his demo sessions, moves the
// pointer over the board, folds it, opens Settings from the menu, goes through every theme in
// light and dark, and holds what it sees to the rules in tools/ui-rules.js. It also saves a
// picture of each state, which is what a pull request's screenshots can be taken from.
//
//   npm run ui-check                    (pictures go to a folder under the system's temp folder)
//   npm run ui-check -- --out=<folder>  (pictures go there)
//
// It is loaded into Electron ahead of the app (electron -r), so the app runs exactly as it does
// for you, network lock included. It always runs the demo on a settings folder of its own, so it
// never reads your sessions or touches your settings. Exit code 0 when every check passed, 1 when
// one failed, 2 when the run itself broke.
const { app, BrowserWindow, Menu, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contrast, over, judgeBoard, judgeHover, judgeFold, judgeSettings, report } = require('./ui-rules');

// Anything that goes wrong ends the run with a message, never with a dialog nobody is there to close.
const fail = (e) => {
  console.error('ui-check broke:', e);
  app.exit(2);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
setTimeout(() => fail(new Error('it did not finish in four minutes')), 240000).unref();

const home = path.join(os.tmpdir(), 'wilfred-ui-check');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const out = path.resolve(outArg ? outArg.slice('--out='.length) : path.join(home, 'pictures'));
// The app reads its flags as it loads, which is after this file: the demo, on settings of this
// run's own (a folder per run, so two runs never meet). A run can't remove its folder while it
// is still using it, so each run clears away the ones earlier runs left, once they are old enough
// that no run can still be going.
fs.mkdirSync(home, { recursive: true });
for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
  const old = path.join(home, entry.name);
  if (!entry.isDirectory() || !entry.name.startsWith('settings') || Date.now() - fs.statSync(old).mtimeMs < 10 * 60000) continue;
  try {
    fs.rmSync(old, { recursive: true, force: true });
  } catch {
    // held by something: left for a later run
  }
}
const settingsDir = fs.mkdtempSync(path.join(home, 'settings-'));
for (const flag of ['--demo', `--user-data-dir=${settingsDir}`]) {
  if (!process.argv.some((a) => a.split('=')[0] === flag.split('=')[0])) process.argv.push(flag);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageOf = (name) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(name));
async function waitFor(what, test, ms = 20000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) {
    const got = await test();
    if (got) return got;
  }
  throw new Error(`timed out waiting for ${what}`);
}
// No verdict here rests on a fixed wait for the app to catch up: a busy machine (a runner, say) is
// many times slower than a desk, and a wait that is long enough there is wasted everywhere else.
/** Reads until the reading is good, or for five seconds: what is really wrong is still wrong then. */
async function until(read, good, ms = 5000) {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const got = await read();
    if (good(got) || Date.now() > end) return got;
  }
}

// What each page logged as an error, by page.
const errors = { 'index.html': [], 'settings.html': [] };
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (details, level, message) => {
    const error = typeof details.level === 'string' ? details.level === 'error' : level === 3;
    const list = Object.entries(errors).find(([name]) => wc.getURL().includes(name));
    if (error && list) list[1].push(String(details.message || message));
  });
});

// The app's menus pop up natively, where nothing can click them: keep the menu instead, and click
// its items by their label.
let menu = null;
Menu.prototype.popup = function popup() {
  menu = this;
};
function pick(label) {
  const find = (items) => items.reduce((hit, i) => hit || (i.label === label ? i : i.submenu && find(i.submenu.items)), null);
  const item = menu && find(menu.items);
  if (!item) throw new Error(`the menu has no item "${label}"`);
  item.click();
}

const run = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn})(${args.map((a) => JSON.stringify(a)).join(', ')})`);
// Real pointer events, at the middle of an element (the window's points: the page's times its zoom).
async function middle(win, selector) {
  const p = await run(win, (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, selector);
  if (!p) throw new Error(`nothing matches ${selector}`);
  const zoom = win.webContents.getZoomFactor();
  return { x: Math.round(p.x * zoom), y: Math.round(p.y * zoom) };
}
async function hover(win, selector) {
  win.webContents.sendInputEvent({ type: 'mouseMove', ...(await middle(win, selector)) });
}
async function click(win, selector) {
  const at = await middle(win, selector);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...at });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
}
// Copying a frame off the screen can fail once and work the next time (seen on a Linux runner's
// virtual screen, on the very first picture), so a picture gets a few tries before the run breaks.
// A copy that comes back with no pixels counts as a failure too: every colour read off it would be
// nothing, and nothing is "readable" against nothing.
const PICTURE_TRIES = 5;
async function picture(win, name) {
  let image = null;
  for (let tries = 1; !image; tries++) {
    try {
      image = await win.webContents.capturePage();
      if (image.isEmpty()) throw new Error('the picture is empty');
    } catch (e) {
      image = null;
      if (tries === PICTURE_TRIES) throw e;
      console.error(`picture ${name}: try ${tries} failed (${e.message}), trying again`);
      await sleep(500);
    }
  }
  fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
  return image;
}
/** The colour of the picture at a point of the page ([r, g, b]). The bitmap is BGRA, a row after a row. */
function colourAt(image, page, point) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  const scale = Math.sqrt(bitmap.length / 4 / (width * height)); // the bitmap's pixels per picture point
  const w = Math.round(width * scale);
  const x = Math.round((point.x / page.width) * w);
  const y = Math.round((point.y / page.height) * Math.round(height * scale));
  const at = (y * w + x) * 4;
  return [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
}

/** Resolves once the page has drawn what it now holds: two frames on, or a second if none come. */
const painted = (win) => run(win, () => new Promise((done) => {
  setTimeout(done, 1000);
  requestAnimationFrame(() => requestAnimationFrame(() => done()));
}));
// The board as it reads and as it is painted, once it has stopped changing: two looks in a row
// that agree, in what the page says and in the colour under every row measured. (A picture taken
// while a theme is still arriving shows the old paint under the new ink.)
const LOOKS = 20;
async function look(board, name) {
  let last = '';
  for (let looks = 1; ; looks++) {
    await painted(board);
    const seen = await run(board, readBoard);
    const image = await picture(board, name);
    const now = JSON.stringify([seen, seen.rows.map((r) => r.inView && colourAt(image, seen.page, r.bare))]);
    if (now === last || looks === LOOKS) return [seen, image];
    last = now;
    await sleep(200);
  }
}

// ---- What the pages are asked. These run in the page, so they can use nothing from this file.

/** The board: every row, as drawn. */
function readBoard() {
  // Colours through a canvas, so that color-mix() and the like come out as numbers.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = (colour) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  // An element's text colour as painted: its own transparency times every ancestor's opacity.
  const ink = (el) => {
    const c = rgba(getComputedStyle(el).color);
    for (let e = el; e; e = e.parentElement) c[3] *= Number(getComputedStyle(e).opacity);
    return c;
  };
  const hasDot = (span, pseudo) => !['none', 'normal', ''].includes(getComputedStyle(span, pseudo).content);

  const listEl = document.querySelector('#rows');
  const list = listEl.getBoundingClientRect();
  // The end of a list that goes on fades out: a row there can't be told from the picture.
  const fade = listEl.classList.contains('overflowing') && !listEl.classList.contains('at-end') ? 44 : 0;
  const rows = [...document.querySelectorAll('#rows .row')].map((row) => {
    const meta = row.querySelector('.meta');
    const spans = [...meta.querySelectorAll('span')].filter((s) => s.textContent);
    const box = meta.getBoundingClientRect();
    const context = row.querySelector('.context');
    const reading = /^(<?\d+)% context$/.exec(context.textContent);
    return {
      title: row.querySelector('.title').textContent,
      stateWord: row.querySelector('.state').textContent,
      parts: spans.length,
      dots: spans.filter((s) => hasDot(s, '::after')).length,
      dotsBefore: spans.filter((s) => hasDot(s, '::before')).length,
      lastHasDot: !!spans.length && hasDot(spans[spans.length - 1], '::after'),
      metaColor: getComputedStyle(meta).color,
      // Every part's ink, and a point of bare row just above the line, for the picture to tell
      // what the ink is painted on (a gradient or a tint has no one colour to ask the page for).
      inks: spans.map((s) => ({ text: s.textContent, ink: ink(s) })),
      bare: { x: box.left + 3, y: box.top - 2 },
      inView: box.top >= list.top + 8 && box.bottom <= list.bottom - fade,
      // Rows that ask for nothing are dimmed on purpose.
      dimmed: row.dataset.state === 'idle' || row.classList.contains('snoozed'),
      context: reading && {
        pct: Number(reading[1].replace('<', '')),
        stage: row.classList.contains('full') ? 'full' : row.classList.contains('filling') ? 'filling' : '',
        color: getComputedStyle(context).color,
        underlined: getComputedStyle(context).textDecorationLine.includes('underline'),
      },
    };
  });
  const page = document.scrollingElement;
  return { rows, overflowX: page.scrollWidth > page.clientWidth + 1, page: { width: innerWidth, height: innerHeight } };
}

/** Scrolls the list of rows to its end, or back to its start. */
function scrollRows(toEnd) {
  const list = document.querySelector('#rows');
  list.scrollTop = toEnd ? list.scrollHeight : 0;
}

/** One row while the pointer is over it. */
function readHover(index) {
  const rows = [...document.querySelectorAll('#rows .row')];
  const row = rows[index];
  const facts = row.querySelector('.facts');
  const range = document.createRange();
  range.selectNodeContents(facts);
  const next = rows[index + 1];
  return {
    hovered: row.matches(':hover'),
    opacity: Number(getComputedStyle(facts).opacity),
    lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size,
    clippedV: facts.scrollHeight > facts.clientHeight + 1,
    clippedH: facts.scrollWidth > facts.clientWidth + 1,
    gapToNext: next ? next.getBoundingClientRect().top - row.getBoundingClientRect().bottom : null,
  };
}

function readFold() {
  const bubble = document.querySelector('#bubble');
  return { collapsed: document.querySelector('#root').classList.contains('collapsed'), bubbleShown: !bubble.hidden, bubbleText: bubble.textContent.trim(), rows: document.querySelectorAll('#rows .row').length };
}

/** The settings window: where it is, and the controls on the page shown that have no name. */
function readSettings() {
  const shown = document.querySelector('.pane.on');
  const text = (id) => (document.getElementById(id) || { textContent: '' }).textContent.trim();
  const name = (el) => el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(' ').map(text).join(' ').trim() || el.textContent.trim() || el.title;
  return {
    shown: shown ? shown.id.replace('page-', '') : '',
    hash: location.hash.slice(1),
    marked: window.uiCheckMark === true,
    unnamed: [...shown.querySelectorAll('input, select, button, [role="radio"]')].filter((el) => !el.closest('[hidden]') && !name(el)).map((el) => `${shown.id} ${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`),
    privacy: text('privacy-label'),
    themes: [...document.querySelectorAll('#themes li b')].map((b) => b.textContent),
  };
}

// ---- The run.

const SCHEMES = ['dark', 'light'];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const sections = [];
  const board = await waitFor('the board', () => pageOf('index.html'));
  await waitFor('the demo rows', () => run(board, () => document.querySelectorAll('#rows .row').length));
  const titles = await run(board, () => [...document.querySelectorAll('#rows .row .title')].map((t) => t.textContent));

  // Settings, opened the way a person opens it: from the menu.
  await run(board, () => window.pet.menu());
  await waitFor('the menu', () => menu);
  pick('Settings…');
  const settings = await waitFor('the settings window', () => pageOf('settings.html'));
  await waitFor('the settings page', async () => (await run(settings, readSettings)).themes.length);
  await run(settings, () => { window.uiCheckMark = true; });
  const steps = [];
  const step = async (label, wanted) => {
    pick(label);
    await sleep(300);
    const now = await until(() => run(settings, readSettings), (at) => at.shown === wanted);
    steps.push({ label, wanted, shown: now.shown, reloaded: !now.marked });
  };
  await step('Privacy settings…', 'privacy');
  await step('Day book…', 'today');
  await click(settings, '#nav button[data-page="general"]');
  await until(() => run(settings, readSettings), (at) => at.shown === 'general');
  await step('Day book…', 'today'); // the page left through the list, asked for again
  const pages = [];
  const unnamed = [];
  let privacy = '';
  for (const page of await run(settings, () => [...document.querySelectorAll('#nav button')].map((b) => b.dataset.page))) {
    await click(settings, `#nav button[data-page="${page}"]`);
    const now = await until(() => run(settings, readSettings), (at) => at.shown === page && at.hash === page);
    pages.push({ page, shown: now.shown, hash: now.hash });
    unnamed.push(...now.unnamed);
    privacy = now.privacy;
    await painted(settings);
    await picture(settings, `settings-${page}`);
  }

  // The board in every theme, light and dark, chosen in Settings like anyone would.
  await click(settings, '#nav button[data-page="appearance"]');
  const { themes } = await until(() => run(settings, readSettings), (at) => at.shown === 'appearance');
  const themeOn = () => run(board, () => document.documentElement.dataset.theme);
  for (let t = 0; t < themes.length; t++) {
    // A theme not already chosen has reached the board once the board names another than before.
    const card = `#themes li:nth-child(${t + 1})`;
    const chosen = await run(settings, (sel) => document.querySelector(sel).classList.contains('on'), card);
    const before = await themeOn();
    await click(settings, card);
    if (!chosen) await waitFor(`the ${themes[t]} theme on the board`, async () => (await themeOn()) !== before);
    for (const scheme of SCHEMES) {
      const dark = scheme === 'dark';
      await click(settings, `#appearance button:nth-child(${dark ? 3 : 2})`);
      await waitFor(`the ${scheme} scheme`, () => nativeTheme.shouldUseDarkColors === dark);
      await waitFor(`the ${scheme} scheme on the board`, () => run(board, (d) => matchMedia('(prefers-color-scheme: dark)').matches === d, dark));
      const name = `${slug(themes[t])}-${scheme}`;
      board.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
      // The list as it opens, then scrolled to its end: each row's small print is measured in
      // whichever of the two shows it whole.
      const views = [await look(board, `board-${name}`)];
      const seen = views[0][0];
      if (seen.rows.some((r) => !r.inView)) {
        await run(board, scrollRows, true);
        views.push(await look(board, `board-${name}-end`));
        await run(board, scrollRows, false);
        await painted(board);
      }
      seen.rows.forEach((row, i) => {
        const view = views.find(([v]) => v.rows[i].inView);
        if (!view) return;
        const bg = colourAt(view[1], view[0].page, view[0].rows[i].bare);
        row.faintest = view[0].rows[i].inks.map((p) => ({ text: p.text, ratio: contrast(over(p.ink, bg), bg) })).sort((a, b) => a.ratio - b.ratio)[0];
      });
      sections.push([`Board, ${themes[t]}, ${scheme}`, judgeBoard({ ...seen, errors: errors['index.html'].splice(0) }, titles)]);

      await hover(board, '#rows .row:nth-child(1) .title');
      const hovered = await until(() => run(board, readHover, 0), (h) => judgeHover(h).every((v) => v.ok));
      sections[sections.length - 1][1].push(...judgeHover(hovered));
      await painted(board);
      await picture(board, `board-${name}-hover`);
    }
  }

  // Folded away and back, in the last theme shown.
  await click(board, '#fold');
  const folded = await until(() => run(board, readFold), (f) => f.collapsed && f.bubbleShown && f.bubbleText);
  await sleep(600); // for the picture only: the fold is still closing
  await picture(board, 'board-folded');
  await click(board, '#butler');
  const unfolded = await until(() => run(board, readFold), (f) => !f.collapsed && f.rows > 0);
  sections.push(['Folding', judgeFold({ ...folded, collapsedAfter: unfolded.collapsed, rowsAfter: unfolded.rows })]);
  sections.push(['Settings', judgeSettings({ steps, pages, unnamed, privacy, errors: errors['settings.html'] })]);

  const { text, failed } = report(sections);
  console.log(`${text}\n\nPictures: ${out}`);
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(main).catch(fail);
