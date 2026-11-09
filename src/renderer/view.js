// What the board shows for a list of session rows. No DOM here, so it runs in the page
// (as window.WilfredView), in the settings page, and in unit tests (via require).
(function (root) {
  const MAX_IDLE = 4;
  const STATES = ['needs-you', 'failed', 'working', 'new', 'idle'];

  /** "now", "4m", "2h 5m", "3d": time since `ms`. */
  function ago(ms, now) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 50) return 'now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h >= 24) return `${Math.floor(h / 24)}d`;
    return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  }

  /** "14:05": a time of day, 24-hour, in local time. */
  function clock(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** Rows to draw: everything that isn't idle, plus the few most recent idle ones. */
  function visibleRows(rows, maxIdle = MAX_IDLE) {
    const idle = rows.filter((r) => r.state === 'idle');
    return {
      shown: rows.filter((r) => r.state !== 'idle').concat(idle.slice(0, maxIdle)),
      hiddenIdle: Math.max(0, idle.length - maxIdle),
    };
  }

  /**
   * Rows in families: a side session sits under the session that started it (`parentId`), one
   * level deep, and a family keeps the place of its most urgent member in the sorted order
   * (the one row of it that comes first in `rows`). Each row comes back with `depth` (0 or 1)
   * and `kids` (how many sit under it). With `nest` off, every row is its own family.
   */
  function families(rows, nest = true) {
    const index = new Map(rows.map((r, i) => [r.id, i]));
    // A child's parent must be in view and not a child itself (so a loop makes two parents).
    const isKid = (r) => nest && !!r.parentId && r.parentId !== r.id && index.has(r.parentId)
      && !(rows[index.get(r.parentId)].parentId && index.has(rows[index.get(r.parentId)].parentId));
    const kidsOf = new Map();
    const tops = [];
    for (const r of rows) {
      if (isKid(r)) {
        if (!kidsOf.has(r.parentId)) kidsOf.set(r.parentId, []);
        kidsOf.get(r.parentId).push(r);
      } else {
        tops.push(r);
      }
    }
    const out = tops.map((top) => {
      const kids = kidsOf.get(top.id) || [];
      return { members: [top, ...kids], first: Math.min(index.get(top.id), ...kids.map((k) => index.get(k.id))) };
    });
    return out.sort((a, b) => a.first - b.first).map(({ members }) => members.map((r, i) => ({ ...r, depth: i ? 1 : 0, kids: i ? 0 : members.length - 1 })));
  }

  /**
   * What the list draws: busy families first, then the few most recently active idle ones; the
   * rest of the idle sessions are counted in `hiddenIdle`. A family is idle when all of it is.
   */
  function layout(rows, { nest = true, maxIdle = MAX_IDLE } = {}) {
    const fams = families(rows, nest);
    const busy = fams.filter((f) => f.some((r) => r.state !== 'idle'));
    const idle = fams.filter((f) => f.every((r) => r.state === 'idle'));
    return {
      shown: [...busy, ...idle.slice(0, maxIdle)].flat(),
      hiddenIdle: idle.slice(maxIdle).reduce((n, f) => n + f.length, 0),
    };
  }

  function moreLabel(n) {
    return n > 0 ? `+${n} quiet session${n > 1 ? 's' : ''}` : '';
  }

  const CHIPS = [
    ['needs-you', (n) => `${n} for you`],
    ['failed', (n) => `${n} failed`],
    ['working', (n) => `${n} busy`],
    ['new', (n) => `${n} done`],
  ];

  const STATE_LABELS = { 'needs-you': 'Needs you', failed: 'Failed', working: 'Working', new: 'Done', idle: 'Idle' };

  /** The state, as the word the row shows: "Needs you", "Failed", "Working", "In background", "Done", "Idle", "Snoozed". */
  function stateLabel(row) {
    if (row.snoozed) return 'Snoozed';
    if (row.state === 'working' && row.background) return 'In background';
    return STATE_LABELS[row.state] || '';
  }

  /**
   * A working row with no tool to name: a moment between things ("Starting…", "Thinking…",
   * "Wrapping up…", "Reading what came back…"), drawn softer than work in progress.
   */
  function transitional(row) {
    return row.state === 'working' && /…$/.test(String(row.headline || ''));
  }

  function countOf(rows, state) {
    return rows.filter((r) => r.state === state).length;
  }

  /** Header chips: one per state that has sessions in it, most urgent first. (The theme colours them by state.) */
  function chips(rows) {
    return CHIPS.map(([state, label]) => {
      const n = countOf(rows, state);
      return n ? { state, label: label(n) } : null;
    }).filter(Boolean);
  }

  /** Wilfred's face: alert beats happy beats working beats asleep. */
  function mood(rows) {
    if (countOf(rows, 'needs-you') || countOf(rows, 'failed')) return 'alert';
    if (countOf(rows, 'new')) return 'happy';
    if (countOf(rows, 'working')) return 'working';
    return 'sleep';
  }

  /** The count on Wilfred: things needing you (amber, or red if only failures), else new updates (green). */
  function badge(rows) {
    const needs = countOf(rows, 'needs-you');
    const failed = countOf(rows, 'failed');
    const fresh = countOf(rows, 'new');
    const urgent = needs + failed;
    if (urgent) return { hidden: false, text: String(urgent), cls: needs ? '' : 'failed' };
    if (fresh) return { hidden: false, text: String(fresh), cls: 'new' };
    return { hidden: true, text: '0', cls: 'new' };
  }

  /** The step of a watched session, in words: "step 3 of 6, Update the API reference". */
  function stepWords(row) {
    if (row.step) return `step ${row.step.index} of ${row.step.total}, ${row.step.text}`;
    return String(row.headline || '');
  }

  /**
   * What Wilfred says, as parts: plain strings and {b: text} for emphasis.
   * `target` is the session a click on the bubble should open, if there is exactly one.
   * A session you watch (`watch`) is reported on while it works; once it needs you, fails or
   * finishes, the usual words say so. When several await you, the starred one is named.
   */
  function speech(rows, watch = '') {
    const of = (state) => rows.filter((r) => r.state === state);
    const watched = watch ? rows.find((r) => r.id === watch) : null;
    if (watched && watched.state === 'working') return { parts: ['Watching ', { b: watched.title }, `: ${stepWords(watched)}`], target: watched.id, progress: stepFraction(watched.step) };
    const needs = of('needs-you');
    const failed = of('failed');
    const fresh = of('new');
    const working = of('working');
    if (needs.length === 1) return { parts: ['Pardon me, sir. ', { b: needs[0].title }, ' awaits your word.'], target: needs[0].id };
    if (needs.length > 1) {
      const lead = needs.find((r) => r.starred) || needs[0];
      const others = needs.length - 1;
      return { parts: ['Pardon me, sir. ', { b: lead.title }, ` and ${others} other${others > 1 ? 's' : ''} await your word.`], target: lead.id };
    }
    if (failed.length) return { parts: ["I'm afraid ", { b: failed[0].title }, ' has run into trouble.'], target: failed[0].id };
    if (fresh.length === 1) return { parts: ['Sir, ', { b: fresh[0].title }, ' has news for you.'], target: fresh[0].id };
    if (fresh.length > 1) return { parts: ['Sir, ', { b: `${fresh.length} sessions` }, ' have news for you.'], target: null };
    if (working.length) return { parts: ['All in hand, sir. ', { b: `${working.length} at work` }, '.'], target: null };
    return { parts: ['All quiet, sir.'], target: null };
  }

  /** The step chip text, e.g. "3/6". */
  function stepLabel(step) {
    return step ? `${step.index}/${step.total}` : '';
  }

  /** How far along the task list is, 0 to 1, for the step's progress bar. */
  function stepFraction(step) {
    if (!step || !(step.total > 0)) return 0;
    return Math.min(1, Math.max(0, step.index / step.total));
  }

  /** Chips with the text to draw: the full label, or just the count (compact, when space runs out; a chip may name its own short form). */
  function fitChips(list, compact) {
    return list.map((c) => ({ ...c, text: compact ? c.short || c.label.split(' ')[0] : c.label }));
  }

  /** Rows with each session id once (the first wins), so the board can key its rows by id. */
  function uniqueRows(rows) {
    const seen = new Set();
    return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
  }

  /** The tray icon's tooltip: Wilfred plus the header chips, e.g. "Wilfred: 1 for you, 3 busy". */
  function trayTooltip(rows) {
    const c = chips(rows).map((x) => x.label);
    return `Wilfred: ${c.length ? c.join(', ') : 'all quiet'}`;
  }

  // ---- what a session runs on ----

  const FAMILIES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', mythos: 'Mythos' };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /** "claude-opus-5-5" → "Opus 5.5"; "claude-opus-5[1m]" → "Opus 5 (1M)"; "claude-3-5-sonnet-20241022" → "Sonnet 3.5". */
  function modelLabel(id) {
    const s = String(id || '').trim();
    if (!s) return '';
    const long = /\[1m\]$/i.test(s) ? ' (1M)' : '';
    const bare = s.replace(/\[1m\]$/i, '');
    let m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i.exec(bare);
    if (m) return `${FAMILIES[m[1].toLowerCase()] || cap(m[1])} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}${long}`;
    m = /^claude-(\d+)(?:-(\d+))?-([a-z]+)(?:-\d{8})?$/i.exec(bare);
    if (m) return `${FAMILIES[m[3].toLowerCase()] || cap(m[3])} ${m[2] ? `${m[1]}.${m[2]}` : m[1]}${long}`;
    return bare.replace(/^claude-/i, '') + long;
  }

  const EFFORTS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max' };
  /** The effort as the row shows it: "max", "extra high"; unknown → ''. */
  function effortLabel(effort) {
    return EFFORTS[String(effort || '').toLowerCase()] || '';
  }

  const MODES = { auto: 'auto mode', acceptEdits: 'accepts edits', plan: 'plan mode', bypassPermissions: 'no permission checks' };
  /** The permission mode in words, '' for the default one. Bypassing every check is a warning. */
  function modeLabel(mode) {
    return MODES[String(mode || '')] || '';
  }

  /** What the row says the session runs on: the model and effort, the permission mode when it isn't the default. */
  // The context reading changes colour as the window fills, like the Claude app's own meter:
  // plain to start with, amber from half (where the app begins to offer a compaction), and
  // red past 80%, where a compaction is near and the figure stands out on the row.
  const CONTEXT_FILLING_PCT = 50;
  const CONTEXT_FULL_PCT = 80;

  /** "34% context": how much of the model's window the session holds. '' without a reading. */
  function contextLabel(ctx) {
    if (!ctx || !Number.isFinite(ctx.pct)) return '';
    return `${ctx.pct < 1 && ctx.tokens > 0 ? '<1' : ctx.pct}% context`;
  }

  function metaOf(row) {
    const model = modelLabel(row.model);
    const effort = effortLabel(row.effort);
    const mode = modeLabel(row.permissionMode);
    const context = contextLabel(row.context);
    const unguarded = row.permissionMode === 'bypassPermissions';
    const pct = row.context ? row.context.pct : NaN;
    const full = pct >= CONTEXT_FULL_PCT;
    const filling = !full && pct >= CONTEXT_FILLING_PCT;
    return { model, effort, mode, context, unguarded, filling, full, text: [model, effort, mode, context].filter(Boolean).join(' · ') };
  }

  /** "337k of 1.0M tokens in context" for the facts line. */
  function contextFacts(ctx) {
    return ctx ? `${fmtTokens(ctx.tokens)} of ${fmtTokens(ctx.window)} tokens in context` : '';
  }

  /** The row's facts line, shown on hover: the branch, the context, and what the session has used so far. */
  function factsLabel(row) {
    return [row.branch ? `on ${row.branch}` : '', contextFacts(row.context), usageLabel(row.cost)].filter(Boolean).join(' · ');
  }

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  /** "Wednesday 5 November" for a day key "2026-11-05"; '' for anything else. */
  function dayLabel(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // A day past the month's end rolls over (30 February becomes 2 March): not a real day.
    if (d.getMonth() !== Number(m[2]) - 1) return '';
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }

  // ---- numbers ----

  /** "4 h 12 min", "12 min", "< 1 min". */
  function fmtDuration(ms) {
    const m = Math.round(Math.max(0, ms || 0) / 60000);
    if (m < 1) return '< 1 min';
    if (m < 60) return `${m} min`;
    return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
  }

  /** "$26.40", "< $0.01", "$0". */
  function fmtUsd(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '$0';
    if (v < 0.01) return '< $0.01';
    return `$${v.toFixed(2)}`;
  }

  /** "30.1M", "249k", "126". */
  function fmtTokens(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
    return String(v);
  }

  /** "≈ $4.11 at API prices · 9.7M tokens · +78 −12 lines", or '' without a cost. */
  function usageLabel(cost) {
    if (!cost) return '';
    const parts = [`≈ ${fmtUsd(cost.usd)} at API prices`, `${fmtTokens(cost.tokens)} tokens`];
    if (cost.linesAdded > 0 || cost.linesRemoved > 0) parts.push(`+${cost.linesAdded || 0} −${cost.linesRemoved || 0} lines`);
    return parts.join(' · ');
  }

  /** The family note: "2 side sessions" on a parent, "from <title>" on a side session whose parent isn't in view. */
  function kinLabel(row) {
    if (row.kids > 0) return `${row.kids} side session${row.kids > 1 ? 's' : ''}`;
    if (!row.depth && row.parentTitle) return `from ${row.parentTitle}`;
    return '';
  }

  /** The first line of a snoozed row's detail. */
  function snoozeLabel(row) {
    if (!row.snoozed) return '';
    return row.snoozedUntil ? `Snoozed until ${clock(row.snoozedUntil)}` : 'Snoozed until it changes';
  }

  /** The board as plain text, for the clipboard: one line per session, most urgent first. */
  function statusText(rows, now) {
    const head = chips(rows).map((x) => x.label);
    const lines = [`Wilfred at ${clock(now)}: ${head.length ? head.join(', ') : 'all quiet'}`];
    for (const r of rows) {
      const bits = [stateLabel(r), r.project ? `${r.title} (${r.project})` : r.title, ago(r.since, now)];
      if (r.headline) bits.push(r.headline);
      if (r.step) bits.push(`step ${stepLabel(r.step)}: ${r.step.text}`);
      lines.push(bits.join(' · '));
    }
    return lines.join('\n');
  }

  /** Wilfred's line at the top of the day book, from the journal's totals. */
  function journalLine(t) {
    if (!t || !t.sessions) return 'Nothing in the book yet today, sir.';
    const parts = [`Claude worked ${fmtDuration(t.workingMs)} across ${t.sessions} session${t.sessions > 1 ? 's' : ''} today, sir`];
    const states = [];
    if (t.done) states.push(`${t.done} done`);
    if (t.needsYou) states.push(`${t.needsYou} await${t.needsYou > 1 ? '' : 's'} your word`);
    if (t.failed) states.push(`${t.failed} in trouble`);
    const first = states.length ? `${parts[0]}; ${states.join(', ')}.` : `${parts[0]}.`;
    const waited = t.waitingMs >= 60000 ? ` They waited on you ${fmtDuration(t.waitingMs)} in all.` : '';
    return first + waited;
  }

  const View = {
    MAX_IDLE, STATES, ago, clock, visibleRows, families, layout, moreLabel, chips, mood, badge, speech, stepLabel, stepFraction,
    trayTooltip, fitChips, uniqueRows, stateLabel, transitional, modelLabel, effortLabel, modeLabel, contextLabel, contextFacts, metaOf, factsLabel, dayLabel,
    fmtDuration, fmtUsd, fmtTokens, usageLabel, kinLabel, snoozeLabel, statusText, journalLine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = View;
  else root.WilfredView = View;
})(typeof window !== 'undefined' ? window : globalThis);
