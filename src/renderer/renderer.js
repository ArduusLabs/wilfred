// DOM wiring for the board. The decisions (labels, mood, what Wilfred says) live in view.js.
const View = window.WilfredView;

const root = document.getElementById('root');
const board = document.getElementById('board');
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const chipsEl = document.getElementById('chips');
const summary = document.getElementById('summary');
const butler = document.getElementById('butler');
const badgeEl = document.getElementById('badge');
const bubble = document.getElementById('bubble');
const tpl = document.getElementById('row-tpl');

let rows = [];
let collapsed = false;
// From main: do not disturb, the session being watched, whether side sessions nest under their parent.
let mode = { dnd: false, watch: '', families: true };
const liById = new Map();

function fillRow(li, r) {
  li.dataset.state = r.state;
  li.dataset.depth = String(r.depth || 0);
  li.classList.toggle('quiet', !!r.quiet);
  li.classList.toggle('background', !!r.background);
  li.classList.toggle('transitional', View.transitional(r));
  li.classList.toggle('starred', !!r.starred);
  li.classList.toggle('snoozed', !!r.snoozed);
  li.classList.toggle('watched', !!r.watched);
  const meta = View.metaOf(r);
  li.classList.toggle('unguarded', meta.unguarded);
  li.querySelector('.state').textContent = View.stateLabel(r);
  li.querySelector('.title').textContent = r.title;
  li.querySelector('.proj').textContent = r.project || '';
  const t = li.querySelector('.ago');
  t.dataset.at = r.since;
  t.textContent = View.ago(r.since, Date.now());
  t.title = (r.state === 'working' ? 'Working since ' : 'Since ') + new Date(r.since).toLocaleTimeString();
  li.querySelector('.headline').textContent = r.headline;
  const step = li.querySelector('.step');
  step.hidden = !r.step;
  step.querySelector('b').textContent = View.stepLabel(r.step);
  step.style.setProperty('--done', View.stepFraction(r.step));
  step.querySelector('span').textContent = r.step ? r.step.text : '';
  const m = li.querySelector('.meta');
  m.hidden = !meta.text;
  m.querySelector('.model').textContent = meta.model;
  m.querySelector('.effort').textContent = meta.effort;
  m.querySelector('.mode').textContent = meta.mode;
  m.querySelector('.context').textContent = meta.context;
  li.classList.toggle('filling', meta.filling);
  li.classList.toggle('full', meta.full);
  li.querySelector('.kin').textContent = View.kinLabel(r);
  li.querySelector('.facts').textContent = View.factsLabel(r);
  li.querySelector('.detail').textContent = [View.snoozeLabel(r), r.detail || ''].filter(Boolean).join('\n');
}

function renderRows() {
  const { shown, hiddenIdle } = View.layout(View.uniqueRows(rows), { nest: mode.families });
  const keep = new Set(shown.map((r) => r.id));
  for (const [id, li] of liById) {
    if (!keep.has(id)) {
      li.remove();
      liById.delete(id);
    }
  }
  shown.forEach((r, i) => {
    let li = liById.get(r.id);
    if (!li) {
      li = tpl.content.firstElementChild.cloneNode(true);
      li.dataset.id = r.id;
      li.addEventListener('click', () => window.pet.open(li.dataset.id));
      // A row has its own menu (open, watch, snooze, copy); the board's menu is for everywhere else.
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.pet.rowMenu(li.dataset.id);
      });
      // Only a new row slides in; one that merely moves must not replay it.
      li.classList.add('entering');
      li.addEventListener('animationend', () => li.classList.remove('entering'), { once: true });
      liById.set(r.id, li);
    }
    fillRow(li, r);
    if (rowsEl.children[i] !== li) rowsEl.insertBefore(li, rowsEl.children[i] || null);
  });
  let more = rowsEl.querySelector('.more');
  if (hiddenIdle > 0) {
    if (!more) {
      more = document.createElement('li');
      more.className = 'more';
    }
    more.textContent = View.moreLabel(hiddenIdle);
    rowsEl.appendChild(more);
  } else if (more) {
    more.remove();
  }
  emptyEl.hidden = rows.length > 0;
  markOverflow();
}

// The list scrolls without a scrollbar: a fade at its bottom says there is more, until you get there.
function markOverflow() {
  rowsEl.classList.toggle('overflowing', rowsEl.scrollHeight > rowsEl.clientHeight + 1);
  rowsEl.classList.toggle('at-end', rowsEl.scrollTop + rowsEl.clientHeight >= rowsEl.scrollHeight - 1);
}
rowsEl.addEventListener('scroll', markOverflow);

// Full labels when they fit the header; just the counts when they would run under the fold button.
function renderChips() {
  drawChips(false);
  const last = chipsEl.lastElementChild;
  if (last && last.getBoundingClientRect().right > chipsEl.getBoundingClientRect().right + 0.5) drawChips(true);
}

function drawChips(compact) {
  const list = View.chips(rows);
  if (mode.dnd) list.push({ state: 'dnd', label: 'Do not disturb', short: 'Quiet' });
  chipsEl.replaceChildren(
    ...View.fitChips(list, compact).map((c) => {
      const el = document.createElement('span');
      el.className = 'chip';
      el.dataset.state = c.state;
      el.textContent = c.text;
      el.title = c.label;
      return el;
    }),
  );
}

// Wilfred's words, built from text nodes, so session titles can never become markup.
function sayInto(el, parts) {
  el.replaceChildren(
    ...parts.map((p) => {
      if (typeof p === 'string') return document.createTextNode(p);
      const b = document.createElement('b');
      b.textContent = p.b;
      return b;
    }),
  );
}

function renderButler() {
  const mood = View.mood(rows);
  butler.className = `interactive ${mood}`;
  bubble.dataset.mood = mood;
  board.dataset.mood = mood;
  const b = View.badge(rows);
  badgeEl.hidden = b.hidden;
  badgeEl.textContent = b.text;
  badgeEl.className = b.cls;
  const { parts, target, progress } = View.speech(rows, mode.watch);
  // The same sentence on the board and, once folded, in the speech bubble.
  sayInto(bubble, parts);
  sayInto(summary, parts);
  // A watched session's progress, drawn under Wilfred's words in the bubble.
  const watching = progress !== undefined;
  bubble.dataset.watch = watching ? '1' : '';
  if (watching) {
    const bar = document.createElement('i');
    bar.className = 'progress';
    bar.style.setProperty('--done', progress);
    bubble.append(bar);
  }
  bubble.dataset.id = target || '';
  summary.dataset.id = target || '';
  bubble.hidden = !collapsed;
}

function render() {
  root.classList.toggle('collapsed', collapsed);
  root.classList.toggle('dnd', mode.dnd);
  renderRows();
  renderChips();
  renderButler();
  // The content under a resting pointer may have changed (a shorter bubble, a row gone) without
  // the window moving. A resize sends its own, fresher check from main.
  if (!dragging && lastPoint) setOver(hitTest(lastPoint));
  reportShape();
}

// ---- click-through: the window is transparent, so only catch the mouse over real content ----
let over = false;
let lastPoint = null;
function setOver(v) {
  if (v === over) return;
  over = v;
  window.pet.hover(v);
}
function hitTest(point) {
  const el = point && document.elementFromPoint(point.x, point.y);
  return !!(el && el.closest('.interactive'));
}
document.addEventListener('mousemove', (e) => {
  lastPoint = { x: e.clientX, y: e.clientY };
  if (!dragging) setOver(!!e.target.closest('.interactive'));
});
document.addEventListener('mouseleave', () => {
  lastPoint = null;
  if (!dragging) setOver(false);
});

// Where the content is, for a platform that can't tell main where the pointer is over a
// click-through window (Linux): the board, the bubble and Wilfred, with a little room around each.
let lastShape = '';
function reportShape() {
  const rects = [];
  for (const el of [board, bubble, butler]) {
    if (el.hidden || (el === board && collapsed)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    rects.push({ x: Math.floor(r.left) - 6, y: Math.floor(r.top) - 6, w: Math.ceil(r.width) + 12, h: Math.ceil(r.height) + 12 });
  }
  const key = JSON.stringify(rects);
  if (key === lastShape) return;
  lastShape = key;
  window.pet.shape(rects);
}

// ---- drag (from the header or Wilfred) vs click ----
let press = null;
let dragging = false;
function bindDrag(el, onClick) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('#fold')) return;
    press = { x: e.screenX, y: e.screenY, onClick };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!press) return;
    // The release can be swallowed (a context menu opened mid-drag): no button held means it's over.
    if (!(e.buttons & 1)) {
      finish(false);
      return;
    }
    const dx = e.screenX - press.x;
    const dy = e.screenY - press.y;
    if (!dragging && Math.hypot(dx, dy) > 4) {
      dragging = true;
      window.pet.dragStart();
    }
    if (dragging) window.pet.dragMove(dx, dy);
  });
  function finish(click) {
    if (!press) return;
    if (dragging) window.pet.dragEnd();
    else if (click && press.onClick) press.onClick();
    press = null;
    dragging = false;
  }
  el.addEventListener('pointerup', () => finish(true));
  el.addEventListener('pointercancel', () => finish(false));
  el.addEventListener('lostpointercapture', () => finish(false));
}
bindDrag(butler, () => window.pet.toggle());
bindDrag(document.getElementById('board-head'), null);

document.getElementById('fold').addEventListener('click', () => window.pet.toggle());
bubble.addEventListener('click', () => {
  if (bubble.dataset.id) window.pet.open(bubble.dataset.id);
  else window.pet.toggle();
});
summary.addEventListener('click', () => {
  if (summary.dataset.id) window.pet.open(summary.dataset.id);
});
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet.menu();
});

new ResizeObserver(() => {
  window.pet.resize(Math.ceil(root.getBoundingClientRect().height));
  reportShape();
}).observe(root);
// The page's width changes when the zoom is applied (just after the first rows can arrive):
// refit the header chips to the width they really have.
window.addEventListener('resize', renderChips);

window.pet.onRows((next) => {
  rows = View.uniqueRows(next);
  render();
});
window.pet.onCollapsed((v) => {
  collapsed = v;
  render();
});
window.pet.onMode((m) => {
  const next = m && typeof m === 'object' ? m : {};
  mode = { dnd: next.dnd === true, watch: typeof next.watch === 'string' ? next.watch : '', families: next.families !== false };
  render();
});
window.pet.onListMax((px) => {
  if (!Number.isFinite(px)) return;
  rowsEl.style.maxHeight = `${px}px`;
  markOverflow();
});
window.pet.onHoverReset(() => {
  over = false;
  lastPoint = null; // the pointer has left; an old position must not switch clicks back on
  // Confirm it to main, in case a "hover on" from this page crossed main's reset in flight.
  window.pet.hover(false);
});
// After the window moves or resizes, main says where the pointer now is in page coordinates.
window.pet.onHoverCheck((point) => {
  if (dragging) return;
  lastPoint = point;
  setOver(hitTest(point));
});
// The theme (one CSS file, built in or your own) arrives from main as text and goes into a
// constructed stylesheet, which the page's content security policy allows (it isn't inline
// style). It sits after style.css in the cascade, so a theme can restyle anything in it.
const themeSheet = new CSSStyleSheet();
document.adoptedStyleSheets = [themeSheet];
window.pet.onTheme((theme) => {
  const t = theme || {};
  try {
    themeSheet.replaceSync(String(t.css || ''));
  } catch {
    return; // a theme that can't be parsed leaves the current one in place
  }
  document.documentElement.dataset.theme = String(t.id || '');
});
window.pet.onAvatar((dataUrl) => {
  const img = document.getElementById('avatar-img');
  img.src = dataUrl;
  img.hidden = false;
  document.getElementById('avatar-svg').style.display = 'none';
});
setInterval(() => {
  const now = Date.now();
  for (const t of document.querySelectorAll('time.ago')) t.textContent = View.ago(Number(t.dataset.at), now);
}, 15 * 1000);
window.pet.ready();
