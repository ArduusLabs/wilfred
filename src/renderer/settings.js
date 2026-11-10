// The settings window. Everything shown comes from a snapshot main sends; every change goes back
// to main at once (there is nothing to save). Built from text nodes only.
const api = window.settings;
const View = window.WilfredView;
const $ = (sel) => document.querySelector(sel);

let snap = null;

// The theme's CSS, for its colours and type (see settings.css).
const themeSheet = new CSSStyleSheet();
document.adoptedStyleSheets = [themeSheet];
api.onTheme((theme) => {
  try {
    themeSheet.replaceSync(String((theme && theme.css) || ''));
  } catch {
    // an unparsable theme leaves the current look in place
  }
});

function showPage(name) {
  for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('on', b.dataset.page === name);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.id === `page-${name}`);
  $('#pages').scrollTop = 0;
  // Keep the address on the page shown: main asks for a page by its hash, and asking for the hash
  // the address already has would change nothing.
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
}

/** A row of choices: one button per option, the current one lit. */
function segment(el, options, current, onPick) {
  el.replaceChildren(
    ...options.map(([label, value]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(value === current));
      b.classList.toggle('on', value === current);
      b.addEventListener('click', () => onPick(value));
      return b;
    }),
  );
}

/** A drop-down of choices ([label, value]), the current one selected. */
function fillSelect(sel, choices, current) {
  sel.replaceChildren(
    ...(choices || []).map(([label, value]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      o.selected = value === current;
      return o;
    }),
  );
}

/** Table rows from cells: a string, or { text, cls, sub } for a styled cell, `sub` a second line in small print. */
function fillTable(table, rows) {
  table.querySelector('tbody').replaceChildren(
    ...rows.map((cells) => {
      const tr = document.createElement('tr');
      for (const c of cells) {
        const td = document.createElement('td');
        if (c && typeof c === 'object') {
          td.textContent = c.text;
          td.className = c.cls || '';
          if (c.sub) {
            const small = document.createElement('small');
            small.textContent = c.sub;
            td.append(small);
          }
        } else {
          td.textContent = c;
        }
        tr.append(td);
      }
      return tr;
    }),
  );
}

function renderThemes() {
  const list = $('#themes');
  list.replaceChildren(
    ...snap.themes.map((t) => {
      const li = document.createElement('li');
      li.className = 'theme-card';
      li.tabIndex = 0;
      li.setAttribute('role', 'radio');
      li.setAttribute('aria-checked', String(t.id === snap.theme));
      li.classList.toggle('on', t.id === snap.theme);
      const b = document.createElement('b');
      b.textContent = t.name;
      const s = document.createElement('span');
      s.textContent = t.description || (t.custom ? 'Your own theme.' : '');
      li.append(b, s);
      if (t.edited || t.custom) {
        const em = document.createElement('em');
        em.textContent = t.edited ? 'edited' : 'yours';
        li.append(em);
      }
      const pick = () => change('theme', t.id);
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      return li;
    }),
  );
}

const LOGIN_LABELS = { darwin: 'Open at login', win32: 'Start with Windows' };
const LONG_CHOICES = [['Off', 0], ['10 min', 10], ['20 min', 20], ['45 min', 45], ['90 min', 90]];
const DND_CHOICES = [['Off', 0], ['30 min', 30], ['1 h', 60], ['2 h', 120], ['Until I turn it off', null]];

function renderGeneral() {
  segment($('#zoom'), snap.sizes, snap.zoom, (v) => change('zoom', v));
  segment($('#hours'), snap.hourChoices.map((h) => [`${h} h`, h]), snap.windowHours, (v) => change('windowHours', v));
  $('#families').checked = snap.families !== false;
  const login = $('#opt-login');
  login.hidden = snap.startAtLogin === null || snap.startAtLogin === undefined;
  $('#login-label').textContent = LOGIN_LABELS[snap.platform] || 'Start at login';
  $('#login').checked = snap.startAtLogin === true;
  $('#opt-dock').hidden = typeof snap.dock !== 'boolean';
  $('#dock').checked = snap.dock === true;
  const launcher = snap.launcher && typeof snap.launcher === 'object' ? snap.launcher : null;
  $('#opt-launcher').hidden = !launcher;
  if (launcher) {
    $('#launcher-state').textContent = launcher.installed ? 'Wilfred is in your app menu, with Show, Settings and Quit on its right-click menu.' : "Wilfred isn't in your app menu yet.";
    $('#launcher-add').hidden = !!launcher.installed;
    $('#launcher-remove').hidden = !launcher.installed;
  }
  const sc = snap.shortcuts || {};
  const problems = Array.isArray(snap.shortcutProblems) ? snap.shortcutProblems : [];
  for (const key of ['toggle', 'open']) {
    fillSelect($(`#sc-${key}`), snap.shortcutChoices, sc[key] || '');
    $(`#sc-${key}-problem`).hidden = !problems.includes(key);
  }
}

function renderNotifications() {
  const n = snap.notify || {};
  const on = n.on === true;
  $('#n-on').checked = on;
  // Off, the kinds show what you would get, out of reach until you switch on.
  const kinds = $('#n-kinds');
  kinds.inert = !on;
  kinds.classList.toggle('dim', !on);
  $('#n-try').disabled = !on;
  // The system refused the last one: say so here, not only in the log.
  const refused = $('#n-refused');
  refused.hidden = !(on && snap.notifyRefused);
  refused.textContent = snap.notifyRefused
    ? (snap.platform === 'darwin'
      ? 'macOS refused the last one: it blocks notifications from apps without a developer signature, and does not ask. Watch the count beside the menu bar icon instead.'
      : `Your system refused the last one (${snap.notifyRefused}).`)
    : '';
  // Windows names a notification after the Start Menu entry Wilfred keeps while they're on.
  const reg = $('#n-registered');
  reg.hidden = !(on && snap.platform === 'win32');
  reg.classList.toggle('on', snap.registered === true);
  reg.textContent = snap.registered === true
    ? 'Registered with Windows: a Start Menu entry gives them his name and icon. Windows may take a few minutes to start using it.'
    : 'Not registered with Windows: they arrive as from "Electron".';
  for (const key of ['needs', 'failed', 'done', 'text', 'sound']) $(`#n-${key}`).checked = n[key] === true;
  segment($('#n-long'), LONG_CHOICES, n.long ? n.longMinutes : 0, (v) => change('notify', { ...n, long: v > 0, longMinutes: v > 0 ? v : n.longMinutes }));
  $('#n-mac-note').hidden = snap.platform !== 'darwin';
  const d = snap.dnd && typeof snap.dnd === 'object' ? snap.dnd : { on: false };
  // On for a set time lights no button: the line under the heading says until when.
  const current = !d.on ? 0 : d.until === null ? null : NaN;
  segment($('#dnd'), DND_CHOICES, current, (v) => change('dnd', v));
  const label = $('#dnd-label');
  label.hidden = !d.on;
  label.textContent = d.on ? d.label || 'On' : '';
}

function renderToday() {
  const j = snap.journal && typeof snap.journal === 'object' ? snap.journal : null;
  const t = j && j.totals;
  $('#today-date').textContent = j ? View.dayLabel(j.day) : '';
  $('#today-line').textContent = View.journalLine(t);
  const any = !!(t && t.sessions);
  $('#today-body').hidden = !any;
  if (!any) return;
  const num = (text) => ({ text, cls: 'num' });
  fillTable($('#today-projects'), (j.projects || []).map((p) => [
    p.project || '(no project)', num(View.fmtDuration(p.workingMs)), num(p.waitingMs >= 60000 ? View.fmtDuration(p.waitingMs) : ''),
    num(String(p.sessions)), num(String(p.turns)),
  ]));
  fillTable($('#today-sessions'), (j.sessions || []).map((s) => {
    const runs = [View.modelLabel(s.model), View.effortLabel(s.effort)].filter(Boolean).join(' · ');
    const lines = s.linesAdded || s.linesRemoved ? `+${s.linesAdded} −${s.linesRemoved} lines` : '';
    return [
      { text: s.project ? `${s.title} (${s.project})` : s.title, cls: 'name', sub: [runs, lines].filter(Boolean).join(' · ') },
      num(View.fmtDuration(s.workingMs)), num(s.waitingMs >= 60000 ? View.fmtDuration(s.waitingMs) : ''),
      num(String(s.turns)), num(s.usd > 0 ? `≈ ${View.fmtUsd(s.usd)}` : ''),
    ];
  }));
}

function render() {
  renderGeneral();
  segment($('#appearance'), [['System', 'system'], ['Light', 'light'], ['Dark', 'dark']], snap.appearance, (v) => change('appearance', v));
  renderThemes();
  renderNotifications();
  renderToday();
  const verdict = $('#verdict');
  verdict.classList.toggle('bad', !snap.privacy.ok);
  $('#privacy-label').textContent = snap.privacy.label;
  $('#privacy-detail').textContent = snap.privacy.detail;
  $('#opt-hidden').hidden = snap.platform === 'linux';
  $('#hidden-linux-note').hidden = snap.platform !== 'linux';
  $('#hidden').checked = snap.hidden;
  $('#version').textContent = snap.version;
  $('#homepage').textContent = snap.homepage;
}

async function change(key, value) {
  const next = await api.set(key, value);
  if (next) {
    snap = next;
    render();
  }
}

for (const b of document.querySelectorAll('#nav button')) b.addEventListener('click', () => showPage(b.dataset.page));
for (const b of document.querySelectorAll('[data-act]')) {
  b.addEventListener('click', async () => {
    await api.act(b.dataset.act);
    // A copy button says so for a moment.
    if (b.dataset.done) {
      const was = b.textContent;
      b.textContent = b.dataset.done;
      setTimeout(() => { b.textContent = was; }, 1500);
    }
  });
}
$('#login').addEventListener('change', (e) => change('startAtLogin', e.target.checked));
$('#families').addEventListener('change', (e) => change('families', e.target.checked));
$('#dock').addEventListener('change', (e) => change('dock', e.target.checked));
$('#hidden').addEventListener('change', (e) => change('hidden', e.target.checked));
for (const key of ['on', 'needs', 'failed', 'done', 'text', 'sound']) {
  $(`#n-${key}`).addEventListener('change', (e) => change('notify', { ...(snap.notify || {}), [key]: e.target.checked }));
}
for (const key of ['toggle', 'open']) {
  $(`#sc-${key}`).addEventListener('change', (e) => change('shortcuts', { ...(snap.shortcuts || {}), [key]: e.target.value }));
}
$('#close').addEventListener('click', () => api.act('close'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.act('close'); });

api.onSnapshot((s) => {
  snap = s;
  render();
});
api.get().then((s) => {
  snap = s;
  render();
  showHashPage();
});
// Opened at a page (settings.html#privacy), or asked for one while already open: the same file
// with another hash is no reload, only a hash change.
function showHashPage() {
  const page = location.hash.slice(1);
  if (page && $(`#page-${page}`)) showPage(page);
}
window.addEventListener('hashchange', showHashPage);
