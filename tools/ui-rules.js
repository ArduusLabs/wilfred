// What the UI check holds Wilfred's pages to. Pure: tools/ui-check.js measures the real pages (it
// runs inside Electron) and hands the measurements here; the tests feed it made-up ones.

// Small print must be readable: the contrast WCAG asks of body text.
const MIN_CONTRAST = 4.5;
// The context reading turns amber from half the window and red from 80% (src/renderer/view.js).
const FILLING_PCT = 50;
const FULL_PCT = 80;

const verdict = (name, ok, detail = '') => ({ name, ok: !!ok, detail: ok ? '' : String(detail) });

/** The contrast of two colours ([r, g, b], 0 to 255), as WCAG defines it: 1 to 21. */
function contrast(a, b) {
  const channel = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A colour with some transparency ([r, g, b, a]) as it looks painted over an opaque one. */
function over(ink, bg) {
  return [0, 1, 2].map((i) => ink[i] * ink[3] + bg[i] * (1 - ink[3]));
}

/** The stage a context reading should be drawn in: '' (plain), 'filling' or 'full'. */
function stageOf(pct) {
  if (pct >= FULL_PCT) return 'full';
  return pct >= FILLING_PCT ? 'filling' : '';
}

/**
 * The board. `m` is what the page reported: rows (title, state word, the parts of the small-print
 * line with the faintest of them, the context reading and how it is drawn), and page-wide facts.
 * `titles` are the sessions that must each have a row.
 */
function judgeBoard(m, titles) {
  const shown = m.rows.map((r) => r.title);
  const missing = titles.filter((t) => !shown.includes(t));
  const nameless = m.rows.filter((r) => !r.title || !r.stateWord);
  const staged = m.rows.filter((r) => r.context);
  const wrongStage = staged.filter((r) => r.context.stage !== stageOf(r.context.pct));
  // A reading past half must stand out from the line it sits in: by its colour, or underlined
  // where the row itself is painted in that colour.
  const flat = staged.filter((r) => stageOf(r.context.pct) && r.context.color === r.metaColor && !r.context.underlined);
  const dots = m.rows.filter((r) => r.dots !== Math.max(r.parts - 1, 0) || r.dotsBefore || r.lastHasDot);
  const dim = m.rows.filter((r) => !r.dimmed && r.faintest && r.faintest.ratio < MIN_CONTRAST);
  return [
    verdict('every session has a row', !missing.length, `missing: ${missing.join(', ')}`),
    verdict('every row says its state and its title', !nameless.length, `${nameless.length} row(s) without one`),
    verdict('the context reading is plain, amber from 50%, red from 80%', !wrongStage.length, wrongStage.map((r) => `${r.title}: ${r.context.pct}% drawn as "${r.context.stage}"`).join('; ')),
    verdict('a context reading past half stands out from its line', !flat.length, flat.map((r) => r.title).join(', ')),
    verdict('the dots sit between the parts of the small print, never before or after', !dots.length, dots.map((r) => `${r.title}: ${r.dots} dot(s) for ${r.parts} part(s)`).join('; ')),
    verdict(`the small print is readable (${MIN_CONTRAST}:1)`, !dim.length, dim.map((r) => `${r.title}, "${r.faintest.text}": ${r.faintest.ratio.toFixed(2)}`).join('; ')),
    verdict('the board fits its width', !m.overflowX, 'the page scrolls sideways'),
    verdict('the page reports no errors', !m.errors.length, m.errors.join(' | ')),
  ];
}

/** A row under the pointer: its facts come out in full, and it doesn't cover the next row. */
function judgeHover(m) {
  return [
    verdict('hovering a row shows its facts', m.hovered && m.opacity > 0.99 && m.lines > 0, `hovered: ${m.hovered}, opacity ${m.opacity}, ${m.lines} line(s)`),
    verdict('the facts are not cut off', !m.clippedV && !m.clippedH, `cut ${m.clippedV ? 'at the bottom' : 'at the side'}`),
    verdict('a hovered row does not cover the next one', m.gapToNext === null || m.gapToNext >= -0.5, `overlaps by ${-m.gapToNext}px`),
  ];
}

/** Folding the board away and bringing it back. */
function judgeFold(m) {
  return [
    verdict('folded, Wilfred keeps his line', m.collapsed && m.bubbleShown && !!m.bubbleText, `collapsed: ${m.collapsed}, bubble shown: ${m.bubbleShown}`),
    verdict('unfolded, the rows are back', !m.collapsedAfter && m.rowsAfter > 0, `collapsed: ${m.collapsedAfter}, ${m.rowsAfter} row(s)`),
  ];
}

/**
 * The settings window. `steps` are menu items clicked in turn (label, the page wanted, the page
 * shown, whether the window was loaded afresh); `pages` what each entry of the list opened;
 * `unnamed` the controls a screen reader would have no name for.
 */
function judgeSettings(m) {
  const lost = m.steps.filter((s) => s.shown !== s.wanted || s.reloaded);
  const closed = m.pages.filter((p) => p.shown !== p.page || p.hash !== p.page);
  return [
    verdict('menu items open their page, also when Settings is already open', !lost.length, lost.map((s) => `"${s.label}" showed ${s.shown}${s.reloaded ? ' (reloaded)' : ''}`).join('; ')),
    verdict('every page in the list opens, and the address follows', !closed.length, closed.map((p) => `${p.page} showed ${p.shown} at #${p.hash}`).join('; ')),
    verdict('every control has a name', !m.unnamed.length, m.unnamed.join(', ')),
    verdict('the privacy page reports the network check', /network/i.test(m.privacy), `it says "${m.privacy}"`),
    verdict('the page reports no errors', !m.errors.length, m.errors.join(' | ')),
  ];
}

/** The report: one line per verdict under its heading, and how it ended. */
function report(sections) {
  const lines = [];
  let failed = 0;
  for (const [heading, verdicts] of sections) {
    lines.push(heading);
    for (const v of verdicts) {
      if (!v.ok) failed++;
      lines.push(`  ${v.ok ? ' ok ' : 'FAIL'}  ${v.name}${v.ok ? '' : `: ${v.detail}`}`);
    }
  }
  lines.push('', failed ? `${failed} check(s) failed.` : 'Every check passed.');
  return { text: lines.join('\n'), failed };
}

module.exports = { MIN_CONTRAST, contrast, over, stageOf, judgeBoard, judgeHover, judgeFold, judgeSettings, report };
