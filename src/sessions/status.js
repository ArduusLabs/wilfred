// Turns a session's metadata (written by the desktop app) and its transcript summary into
// the one row the board shows. Pure, so every state can be tested.

const { clip, contextOf, ASKING_TOOLS, LONG_TOOLS } = require('./transcript');

const MIN = 60 * 1000;
// The app moves its turn edge the moment it raises a permission prompt: within this long of the
// tool call that triggered it (it moves the edge for nothing else mid-turn except a message you send).
const PROMPT_EDGE_MS = 5 * 1000;
// A quick tool (Read, Edit, …) silent for this long is probably held up by a permission prompt.
// (The fallback when the app's edge can't tell, e.g. a prompt raised before Wilfred started.)
const QUICK_TOOL_MS = MIN;
// Connector tools can be slow (a browser page, a Jira search), so they get longer.
const CONNECTOR_MS = 5 * MIN;
// Bash is given this much on top of its own timeout before we call it held up (a command that
// times out is moved to the background, which takes a while).
const TIMEOUT_GRACE_MS = 60 * 1000;
// A turn with no writes for this long probably died (app closed, crash); stop calling it working.
const DEAD_TURN_MS = 45 * MIN;
// Background work this old without a completion is assumed lost.
const BACKGROUND_MAX_MS = 3 * 60 * MIN;

// The app's session file and the transcript update moments apart. For this long after one of
// them moves, a turn boundary the other hasn't caught up with yet is shown as still in motion.
const BOUNDARY_GRACE_MS = 10 * 1000;
// A background task or another session reporting back is followed by a reply within this long.
const WAKE_GRACE_MS = 60 * 1000;
// A reply the app says has started, after a report-back, can take this long to write its first record.
const WAKE_REPLY_MAX_MS = 15 * 60 * 1000;
// A new session's transcript appears within seconds of the app's session file.
const NEW_SESSION_MS = 2 * 60 * 1000;

/** States, most urgent first. The board sorts by this order. */
const STATES = ['needs-you', 'failed', 'working', 'new', 'idle'];

function firstSentence(text) {
  const t = String(text || '').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t;
}

function planStep(plan) {
  if (!plan || !plan.length) return null;
  const i = plan.findIndex((p) => p.status === 'in_progress');
  if (i < 0) return null;
  return { index: i + 1, total: plan.length, text: plan[i].content };
}

/**
 * The pending tool the app has just raised a permission prompt for, if any: the app's edge moved
 * right after that tool started, nothing newer is in the transcript, and it wasn't a message you
 * sent mid-turn (those are queued in the transcript as they're sent).
 */
function promptedTool(pending, edge, t, permissionMode) {
  if (permissionMode === 'bypassPermissions' || !edge) return null;
  if (edge < (t.lastAt || 0) - 100) return null;
  if (Number.isFinite(t.queuedAt) && Math.abs(edge - t.queuedAt) < 3000) return null;
  // The prompt is raised after the call is recorded, so its edge comes strictly after the call.
  return pending.find((p) => !ASKING_TOOLS.has(p.name) && Number.isFinite(p.at) && edge > p.at && edge - p.at <= PROMPT_EDGE_MS) || null;
}

/** Whether a tool that has been silent for `quietFor` is probably waiting on a permission prompt. */
function looksHeldUp(tool, quietFor, permissionMode) {
  if (permissionMode === 'bypassPermissions') return false;
  if (LONG_TOOLS.has(tool.name) || tool.name === 'Monitor') return false;
  if (tool.timeoutMs) return quietFor > tool.timeoutMs + TIMEOUT_GRACE_MS;
  return quietFor > (tool.name.startsWith('mcp__') ? CONNECTOR_MS : QUICK_TOOL_MS);
}

/** What an API error at the end of a turn means for you. */
function apiErrorText(kind) {
  if (/rate/i.test(kind)) return 'Stopped: rate limited by the API';
  if (/auth/i.test(kind)) return 'Stopped: signed out, sign in again';
  if (/overload|529/i.test(kind)) return 'Stopped: the API is overloaded';
  return 'Stopped: API error';
}

function projectName(meta) {
  if (meta.worktreeName) return meta.worktreeName;
  const p = String(meta.originCwd || meta.cwd || '');
  if (/scratch-workspaces/i.test(p)) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * @param {object} meta  the desktop app's local_<id>.json
 * @param {ReturnType<import('./transcript').summarize>|null} t  transcript summary, if found
 * @param {number} now
 * @param {{activityAt?: number, sleeps?: {from: number, to: number}[]}} [extra]
 *   activityAt: latest write by the session's subagents; sleeps: the computer's recent sleeps
 *   (time asleep is not counted as time a tool was quiet or a turn was silent)
 */
function sessionStatus(meta, t, now, extra = {}) {
  const pts = meta.postTurnSummary && meta.postTurnSummary.summarizes_uuid === meta.lastAssistantUuid
    ? meta.postTurnSummary
    : null;
  const recap = t && t.wrapUp && t.wrapUp.recap ? String(t.wrapUp.recap) : '';
  const latest = (pts && pts.status_detail) || firstSentence(recap);
  const row = {
    id: meta.sessionId,
    title: meta.title || 'Untitled session',
    project: projectName(meta),
    starred: !!meta.isStarred,
    state: 'idle',
    headline: '',
    detail: '',
    since: meta.lastTurnEdgeAt || meta.lastActivityAt || now,
    step: null,
    quiet: false,
    background: false,
    // Whether you have opened the session since its last turn ended. The app stamps lastFocusedAt
    // when you switch to a session, so one you watch finish still counts as new until you revisit it.
    seen: (meta.lastFocusedAt || 0) >= (meta.lastTurnEdgeAt || 0) - 2000,
    lastActivityAt: meta.lastActivityAt || 0,
    // The scheduled routine this session is a run of, if any (see foldRuns).
    scheduledTaskId: meta.scheduledTaskId || '',
    // What the session runs on, as the app's file says (the row shows it, the branch on hover).
    model: meta.model || '',
    effort: meta.effort || '',
    permissionMode: meta.permissionMode || '',
    branch: meta.branch || '',
    // Where "Open project folder" goes: the worktree the session works in, else its folder.
    folder: meta.worktreePath || meta.cwd || '',
    // A side session nests under the session that started it.
    parentId: (meta.spawnedFrom && meta.spawnedFrom.sessionId) || '',
    parentTitle: (meta.spawnedFrom && meta.spawnedFrom.title) || '',
    completedTurns: meta.completedTurns || 0,
    cost: (t && t.cost) || null,
    // What the context holds now, as the latest reply's usage says (the app's own percentage).
    context: contextOf(t && t.context, meta.model),
  };

  // Silence since `since`, not counting time the computer spent asleep in between.
  const sleeps = extra.sleeps || [];
  const silentFor = (since) => {
    let slept = 0;
    for (const s of sleeps) if (s.to > s.from) slept += Math.max(0, Math.min(s.to, now) - Math.max(s.from, since));
    return now - since - slept;
  };
  // A session just created whose transcript hasn't appeared yet is starting, not finished.
  // (The app stamps the turn edge at creation too, so an edge at createdAt still means new.)
  const fresh = !meta.lastTurnEdgeAt || meta.lastTurnEdgeAt <= (meta.createdAt || 0) + 1000;
  if (!t && fresh && !meta.transcriptUnavailable && meta.createdAt && now - meta.createdAt < NEW_SESSION_MS) {
    return moving(row, 'Starting…', meta.createdAt);
  }
  const lastWork = Math.max(t ? t.lastAt || 0 : 0, extra.activityAt || 0);
  const pending = t && !t.turnEnded ? t.pending : [];
  // A question or a held-up tool waits on you however long it takes. Only a turn with nothing
  // that could be waiting on you (or just a long-running agent with no sign of life) goes dead.
  const mayWaitOnYou = pending.some((p) => !LONG_TOOLS.has(p.name) && p.name !== 'Monitor');
  const live = t && !t.turnEnded && (mayWaitOnYou || silentFor(lastWork) < DEAD_TURN_MS);

  if (live) {
    const asking = t.pending.find((p) => ASKING_TOOLS.has(p.name));
    const tool = t.pending[t.pending.length - 1];
    row.step = planStep(t.plan);
    row.since = Number.isNaN(t.turnStartAt) ? row.since : t.turnStartAt;
    if (asking) {
      row.state = 'needs-you';
      row.headline = asking.label;
      row.since = asking.at || row.since;
      row.detail = latest ? `Before this: ${latest}` : '';
      return row;
    }
    row.state = 'working';
    // Only the main transcript says whether this tool moved: a background agent writing its own
    // files says nothing about a quick tool stuck on a permission prompt. Without timestamps, count
    // from the turn's start. Time asleep doesn't count.
    const toolQuietSince = [t.lastAt, t.turnStartAt, meta.lastTurnEdgeAt].find((v) => Number.isFinite(v) && v > 0) || now;
    const quietFor = silentFor(toolQuietSince);
    const prompted = promptedTool(t.pending, meta.lastTurnEdgeAt || 0, t, meta.permissionMode);
    if (prompted) {
      row.state = 'needs-you';
      row.headline = `Permission needed: ${prompted.label}`;
      row.since = meta.lastTurnEdgeAt;
      row.detail = 'Claude is asking to run this; answer in the session.';
      return row;
    }
    if (tool) {
      row.headline = tool.label;
      if (looksHeldUp(tool, quietFor, meta.permissionMode)) {
        // Probably a permission prompt, which needs you as much as a question does.
        row.state = 'needs-you';
        row.quiet = true;
        row.since = toolQuietSince || row.since;
        row.detail = `No progress for ${Math.round(quietFor / MIN)} min. It may be waiting for your permission.`;
      }
    } else {
      row.headline = 'Thinking…';
    }
    if (!row.detail) row.detail = t.lastPrompt ? (t.promptByYou ? `You asked: ${t.lastPrompt}` : t.lastPrompt) : latest;
    return row;
  }

  // Between turns.
  row.since = (t && !Number.isNaN(t.endedAt) ? t.endedAt : 0) || meta.lastTurnEdgeAt || row.since;
  row.detail = recap;
  const endedAt = t && Number.isFinite(t.endedAt) ? t.endedAt : 0;
  const edge = meta.lastTurnEdgeAt || 0;
  if (t && t.turnEnded && endedAt > 0 && !t.interrupted && !t.apiError) {
    // The app has started a turn the transcript doesn't show yet (you just sent a message): its
    // edge moved past everything in the transcript. The app also moves the edge when a turn ends,
    // just before the transcript's stop-hook record; so only once that record is in (lastAt past
    // the end) does a newer edge mean a new turn.
    const hookIn = (t.lastAt || 0) > endedAt + 100;
    if (hookIn && edge > t.lastAt + 1000 && now - edge < BOUNDARY_GRACE_MS) {
      return moving(row, 'Starting…', edge);
    }
    // A background task or another session reported back; the reply is on its way.
    // (The app moves its edge when the reply starts; past the usual minute, that keeps it showing.)
    const replying = edge > t.wokeAt && now - t.wokeAt < WAKE_REPLY_MAX_MS;
    if (t.wokeAt > endedAt && (now - t.wokeAt < WAKE_GRACE_MS || replying)) {
      return moving(row, 'Reading what came back…', t.wokeAt, t.lastPrompt);
    }
    // The turn just ended and the app hasn't written its summary yet: hold still a moment
    // rather than flash "finished" before the real verdict (often "needs you") arrives.
    // Not needed when the transcript already holds the verdict: a question for you.
    if (endedAt > edge + 1000 && now - endedAt < BOUNDARY_GRACE_MS && !(t.wrapUp && t.wrapUp.ask)) {
      return moving(row, 'Wrapping up…', endedAt);
    }
  }
  // Seen means opened since the turn really ended (the app's edge can lag the transcript).
  row.seen = (meta.lastFocusedAt || 0) >= Math.max(edge, endedAt) - 2000;
  const background = ((t && t.background) || []).filter((b) => now - b.at < BACKGROUND_MAX_MS);
  const bgText = background.length
    ? background[background.length - 1].label + (background.length > 1 ? ` (+${background.length - 1} more)` : '')
    : '';
  // Stopping a turn (Esc, or the app closing) doesn't stop work already sent to the background.
  const stopped = t && !t.turnEnded ? 'Stopped mid-turn, no activity since' : t && t.interrupted ? 'Stopped by you' : '';
  if (stopped && bgText) {
    row.state = 'working';
    row.background = true;
    row.headline = `In background: ${bgText.replace(/^Running: /, '')}`;
    row.detail = `${stopped.replace(', no activity since', '')}; this is still running.`;
    return row;
  }
  if (t && !t.turnEnded) {
    row.headline = stopped;
    row.since = [t.lastAt, t.turnStartAt].find((v) => Number.isFinite(v) && v > 0) || row.since;
    return row;
  }
  if (t && t.interrupted) {
    row.headline = stopped;
    return row;
  }
  const ask = t && t.wrapUp && t.wrapUp.ask ? String(t.wrapUp.ask) : '';
  const category = pts ? pts.status_category : '';
  if (category === 'failed') {
    row.state = 'failed';
    row.headline = latest || 'The last turn failed';
    return row;
  }
  if (t && t.apiError) {
    row.state = 'failed';
    row.headline = apiErrorText(t.apiError.kind);
    row.since = t.apiError.at || row.since;
    return row;
  }
  // The app's summariser can lift an ask from the reply's text, even one meant for another session.
  // A next-step box with no question is the session itself saying nothing waits on you, so it wins.
  const saysNothingPending = !!(t && t.wrapUp && !ask);
  // A turn started by a report-back or a relayed notice, that ended without a next-step box of its
  // own, was passing news along: an ask the summary lifts from it belongs to the other session
  // (which shows its own row), so it is kept as detail here rather than calling for you.
  const relayed = !!(t && t.turnFrom === 'report' && !t.wrapUp);
  const summaryAsks = !saysNothingPending && !relayed && (category === 'need_input' || category === 'blocked');
  if (relayed && pts && pts.needs_action) row.detail = `Passed on: ${pts.needs_action}`;
  if (ask || summaryAsks) {
    row.state = 'needs-you';
    row.headline = clip(ask || (pts && pts.needs_action) || latest || 'Waiting for you', 160);
    if (bgText) row.detail = `Still running in the background: ${bgText}. ${row.detail}`.trim();
    return row;
  }
  if (bgText) {
    // The app counts a session with background work as running, and so do we.
    row.state = 'working';
    row.background = true;
    row.headline = `In background: ${bgText.replace(/^Running: /, '')}`;
    row.detail = latest ? `Last update: ${latest}` : recap;
    return row;
  }
  row.state = row.seen ? 'idle' : 'new';
  row.headline = latest || 'Finished';
  return row;
}

function moving(row, headline, since, detail) {
  row.state = 'working';
  row.headline = headline;
  row.since = since;
  if (detail) row.detail = detail;
  return row;
}

/** Board order: most urgent state first, then starred sessions, then the most recently active. */
function compareRows(a, b) {
  const s = STATES.indexOf(a.state) - STATES.indexOf(b.state);
  if (s) return s;
  // Sessions you starred in the app come first within their state.
  const starred = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
  if (starred) return starred;
  return b.lastActivityAt - a.lastActivityAt;
}

/**
 * Every run of a scheduled routine is a session of its own with the same title, so two runs read
 * as a duplicate. One row per routine: the run most recently active (the one you're in, if you
 * continued one), with any other run still waiting on you counted in its detail.
 */
function foldRuns(rows) {
  const runsOf = new Map();
  for (const r of rows) {
    if (!r.scheduledTaskId) continue;
    if (!runsOf.has(r.scheduledTaskId)) runsOf.set(r.scheduledTaskId, []);
    runsOf.get(r.scheduledTaskId).push(r);
  }
  const out = [];
  for (const r of rows) {
    if (!r.scheduledTaskId) {
      out.push(r);
      continue;
    }
    const runs = runsOf.get(r.scheduledTaskId);
    const keep = runs.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a));
    if (r !== keep) continue;
    const waiting = runs.filter((x) => x !== keep && (x.state === 'needs-you' || x.state === 'failed')).length;
    if (!waiting) {
      out.push(keep);
      continue;
    }
    const note = waiting > 1 ? `${waiting} other runs of this routine are waiting for you too.` : 'Another run of this routine is waiting for you too.';
    out.push({ ...keep, detail: keep.detail ? `${note}\n${keep.detail}` : note });
  }
  return out;
}

module.exports = { sessionStatus, compareRows, foldRuns, looksHeldUp, promptedTool, PROMPT_EDGE_MS, STATES, BOUNDARY_GRACE_MS, WAKE_GRACE_MS, NEW_SESSION_MS, QUICK_TOOL_MS, CONNECTOR_MS, TIMEOUT_GRACE_MS, DEAD_TURN_MS, BACKGROUND_MAX_MS };
