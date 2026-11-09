// Works out what a Claude Code session is doing from the end of its transcript (.jsonl).
// summarize() is pure so it can be tested on hand-written records.

const fs = require('node:fs');

const TAIL_BYTES = 512 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

// Tools that hand the turn to you rather than doing work.
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// Tools that finish instantly and say nothing about the work.
const SILENT_TOOLS = new Set(['mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up', 'ToolSearch', 'TodoWrite']);
// Tools that legitimately run for a long time without writing to the main transcript.
const LONG_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'Skill']);

/** Reads whole lines from the end of a file; grows the window (up to a cap) until a turn start is in it. */
function readTail(file, size) {
  return readTailWindow(file, size).records;
}

/**
 * Like readTail, also saying how far from the end the current turn starts (`turnBytes`), so the
 * next read of a growing file can start with a window that just holds the turn (`startBytes`)
 * instead of growing again from 512 KB, and shrinks back once a new turn starts near the end.
 */
function readTailWindow(file, size, startBytes = TAIL_BYTES) {
  let bytes = Math.min(Math.max(TAIL_BYTES, startBytes), MAX_TAIL_BYTES);
  for (;;) {
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const records = [];
    let turnBytes = null;
    // Walk the lines by byte offset, so we know where in the file the latest turn starts.
    let pos = 0;
    if (start > 0) {
      const first = buf.indexOf(10);
      pos = first < 0 ? buf.length : first + 1; // the first line is cut
    }
    while (pos < buf.length) {
      const nl = buf.indexOf(10, pos);
      const end = nl < 0 ? buf.length : nl;
      let line = buf.toString('utf8', pos, end);
      if (start === 0 && pos === 0) line = line.replace(/^\uFEFF/, '');
      const lineStart = pos;
      pos = end + 1;
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // a line still being written; the next read gets it whole
      }
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      records.push(r);
      if (startsTurn(r)) turnBytes = buf.length - lineStart;
    }
    if (start === 0 || bytes >= MAX_TAIL_BYTES || turnBytes !== null) return { records, bytes, turnBytes: turnBytes ?? bytes };
    bytes = Math.min(bytes * 4, MAX_TAIL_BYTES);
  }
}

// Content blocks of a record; anything that isn't an object block is ignored.
function contentOf(r) {
  const c = r.message && r.message.content;
  return Array.isArray(c) ? c.filter((x) => x && typeof x === 'object') : [];
}

function isToolResult(r) {
  return contentOf(r).some((c) => c && c.type === 'tool_result');
}

function messageText(r) {
  const c = r.message && r.message.content;
  if (typeof c === 'string') return c;
  return contentOf(r).filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
}

/**
 * What a user-type record is:
 * - 'prompt': you (or a scheduled task) asking for something; starts or joins a turn
 * - 'command': a slash command you typed; remembered as your request, but only the model's
 *   reply starts a turn, because local commands (/compact, /model) never get one
 * - 'wake': a background task reporting back; ends that task, and the model's reply (if any)
 *   starts the turn
 * - 'result': a tool result; 'other': anything else
 */
function userKind(r) {
  if (r.type !== 'user' || r.isSidechain) return 'other';
  if (isToolResult(r)) return 'result';
  // A message from another session (an agent reporting back, a sibling session) arrives as meta.
  if (r.origin && r.origin.kind === 'peer') return 'peer';
  // Housekeeping the model sees but you never typed: reminders, skill bodies, compaction summaries.
  if (r.isMeta || r.isCompactSummary || r.isVisibleInTranscriptOnly) return 'other';
  const text = messageText(r).trimStart();
  const origin = r.origin && r.origin.kind;
  // A scheduled task fired into an existing session arrives like a notice, but it is a new request.
  if (text.startsWith('<scheduled-task')) return 'prompt';
  // A notice the desktop app relays into a session (another session reported in) is nothing but
  // its own added blocks: it isn't you asking for something.
  if (/^<(system-reminder|side-sessions-event)\b/.test(text) && !text.replace(ADDED_BLOCK, '').trim()) return 'peer';
  if (origin === 'task-notification' || text.startsWith('<task-notification>')) return 'wake';
  if (/^<local-command-(stdout|stderr|caveat)>/.test(text)) return 'other';
  if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) return 'command';
  return 'prompt';
}

function startsTurn(r) {
  return userKind(r) === 'prompt';
}

const ms = (r) => (r.timestamp ? Date.parse(r.timestamp) : NaN);

// The last part of a path, whichever separator it uses (a Windows path can be read on a Mac too).
function shortName(p) {
  return p ? String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
}

function clip(s, n = 90) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Tags the app wraps around commands and attachments; anything else in a prompt is your text.
const WRAPPER_TAG = /<\/?(?:command-[a-z-]+|local-command-[a-z-]+|ide_[a-z_]+|system-reminder|side-sessions-event|user-prompt-submit-hook|pasted_content)\b[^>]*>/g;
// Blocks the app or a hook adds to a prompt, which you didn't type: dropped with their contents.
const ADDED_BLOCK = /<(system-reminder|side-sessions-event|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;

/** What a prompt asked for, in one line. Scheduled tasks are named; other markup is dropped. */
function promptLine(text) {
  const scheduled = /^\s*<scheduled-task\b[^>]*\bname="([^"]*)"/.exec(text);
  if (scheduled) return { text: clip(`Scheduled task: ${scheduled[1]}`, 120), byYou: false };
  return { text: clip(String(text).replace(ADDED_BLOCK, ' ').replace(WRAPPER_TAG, ' '), 120), byYou: true };
}

/** One line saying what a tool call is doing, without showing its full input. */
function describeTool(name, input = {}) {
  const file = (verb, p) => `${verb} ${shortName(p) || 'a file'}`;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return input.description ? `Running: ${clip(input.description, 70)}` : 'Running a command';
    case 'Read':
      return file('Reading', input.file_path);
    case 'Edit':
    case 'MultiEdit':
      return file('Editing', input.file_path);
    case 'Write':
      return file('Writing', input.file_path);
    case 'NotebookEdit':
      return file('Editing', input.notebook_path);
    case 'Grep':
    case 'Glob':
      return `Searching for ${clip(input.pattern, 50)}`;
    case 'Agent':
    case 'Task':
      return `Agent: ${clip(input.description || input.subagent_type || 'working', 60)}`;
    case 'SendMessage':
      return `Agent: ${clip(input.summary || 'follow-up', 60)}`;
    case 'WebSearch':
      return `Searching the web: ${clip(input.query, 50)}`;
    case 'WebFetch':
      try {
        return `Reading ${new URL(input.url).host}`;
      } catch {
        return 'Reading a web page';
      }
    case 'Skill':
      return input.skill ? `Using skill ${input.skill}` : 'Using a skill';
    case 'Workflow':
      return 'Running a workflow';
    case 'Monitor':
      return `Watching: ${clip(input.description, 60)}`;
    case 'AskUserQuestion':
      return clip(input.questions && input.questions[0] && input.questions[0].question, 160) || 'Has a question for you';
    case 'ExitPlanMode':
      return 'Plan ready for your approval';
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
      if (m) {
        const server = m[1].replace(/^[0-9a-f-]{20,}$/, 'connector').replace(/^claude-in-chrome$|^Claude_Browser$/, 'browser');
        return `${server}: ${m[2].replace(/_/g, ' ')}`;
      }
      return name || 'Working';
    }
  }
}

/** Applies one update_plan call to the plan being tracked. */
function applyPlan(plan, input) {
  if (Array.isArray(input.items)) {
    return input.items.filter((i) => i && typeof i === 'object').map((i) => ({ content: String(i.content || ''), status: i.status }));
  }
  if (!plan) return plan;
  const next = plan.map((i) => ({ ...i }));
  const cur = next.findIndex((i) => i.status === 'in_progress');
  if (input.advance) {
    if (cur >= 0) next[cur].status = 'completed';
    const after = next.findIndex((i, n) => n > cur && i.status === 'pending');
    if (after >= 0) next[after].status = 'in_progress';
  }
  for (const n of Array.isArray(input.done) ? input.done : []) if (next[n - 1]) next[n - 1].status = 'completed';
  if (input.start && next[input.start - 1]) {
    for (const i of next) if (i.status === 'in_progress') i.status = 'pending';
    next[input.start - 1].status = 'in_progress';
  }
  return next;
}

function resultText(c) {
  if (typeof c.content === 'string') return c.content;
  if (Array.isArray(c.content)) return c.content.map((x) => (x && x.type === 'text' ? x.text : '')).join('\n');
  return '';
}

/**
 * The background task id if this call really started one: only these calls can, and their
 * result opens with a fixed phrase. Output that merely mentions the phrase doesn't count.
 */
function backgroundTaskId(call, text) {
  const t = text.trimStart();
  let m = null;
  if ((call.name === 'Bash' || call.name === 'PowerShell') && call.input.run_in_background) {
    m = /^Command running in background with ID: ([A-Za-z0-9_-]+)/.exec(t);
  } else if (call.name === 'Agent' || call.name === 'Task') {
    m = /^Async agent launched successfully[\s\S]{0,400}?agentId: ([A-Za-z0-9_-]+)/.exec(t);
  } else if (call.name === 'Monitor') {
    m = /^Monitor started \(task ([A-Za-z0-9_-]+)/.exec(t);
  } else if (call.name === 'SendMessage') {
    // Messaging an agent that had finished resumes it in the background: {"success":true,"resumedAgentId":"…"}.
    try {
      const r = JSON.parse(t);
      if (r && r.success && /^[A-Za-z0-9_-]+$/.test(r.resumedAgentId)) return r.resumedAgentId;
    } catch {
      // not a resume
    }
  }
  return m ? m[1] : null;
}

const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);

const FINAL_STATUS = /<status>(completed|failed|killed|stopped|cancelled|timeout|timed_out|error)<\/status>/;
// A Monitor that runs out of time reports it as an event, with no status.
const MONITOR_ENDED = /<event>\[?Monitor (?:timed out|expired|stopped|ended)/;

/** Ends every task a notice names (one notice can stop many) once it says they're finished. */
/** Ends the tasks a notice says are finished; returns how many it ended. */
function finishTasks(text, background, finished, at) {
  if (!text || !text.includes('<task-notification>')) return 0;
  let ended = 0;
  for (const block of text.split('<task-notification>').slice(1)) {
    if (!FINAL_STATUS.test(block) && !MONITOR_ENDED.test(block)) continue;
    for (const m of block.matchAll(/<task-id>([A-Za-z0-9_-]+)<\/task-id>/g)) {
      if (background.delete(m[1])) ended++;
      finished.set(m[1], at);
    }
  }
  return ended;
}

/** What the status needs to know about a tool call; never its full input. */
function callInfo(name, input, at) {
  return {
    name,
    at,
    label: describeTool(name, input),
    // Bash gives up after its timeout (2 min unless set), so quiet past that means a prompt.
    timeoutMs: name === 'Bash' || name === 'PowerShell'
      ? Number(input.timeout) || 120000
      // Waiting on a background task is meant to be quiet, up to its own timeout.
      : name === 'TaskOutput' && input.block !== false ? Number(input.timeout) || 600000 : null,
  };
}

// A count from a cost record: only a real, finite number of at least 0 counts; anything else is nothing.
const amount = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * What a cost-state record says the CLI session has used so far (it is cumulative, so the latest
 * wins). A record missing parts gives the parts it has.
 * @returns {{usd: number, tokens: number, linesAdded: number, linesRemoved: number, models: string[]}}
 */
function costOf(r) {
  const usage = r.modelUsage && typeof r.modelUsage === 'object' && !Array.isArray(r.modelUsage) ? r.modelUsage : {};
  let tokens = 0;
  for (const u of Object.values(usage)) {
    if (!u || typeof u !== 'object') continue;
    tokens += amount(u.inputTokens) + amount(u.outputTokens) + amount(u.cacheReadInputTokens) + amount(u.cacheCreationInputTokens);
  }
  return {
    usd: amount(r.totalCostUSD),
    tokens,
    linesAdded: amount(r.totalLinesAdded),
    linesRemoved: amount(r.totalLinesRemoved),
    models: Object.keys(usage),
  };
}

/**
 * @param {object[]} records transcript records, oldest first
 * @returns {{turnEnded: boolean, interrupted: boolean, turnStartAt: number, endedAt: number,
 *   lastAt: number, pending: {name: string, at: number, label: string, timeoutMs: number|null}[],
 *   background: {name: string, at: number, label: string}[], wrapUp: object|null,
 *   plan: {content: string, status: string}[]|null, lastPrompt: string, promptByYou: boolean,
 *   cost: ReturnType<typeof costOf>|null}}  cost: from the latest cost-state record, null when none
 */
function summarize(records) {
  const s = {
    turnEnded: true,
    interrupted: false,
    turnStartAt: NaN,
    endedAt: NaN,
    lastAt: NaN,
    pending: new Map(), // tool_use id -> {name, input, at}
    background: new Map(), // task id -> callInfo
    wrapUp: null,
    plan: null,
    lastPrompt: '',
    promptByYou: true,
    apiError: null, // set when the turn ended on an API error (rate limit, 5xx, signed out)
    wokeAt: NaN, // when a background task or another session last reported back
    finished: new Map(), // background task id -> when these records say it ended
    pendingAsk: '', // a question still waiting from before a report-back turn
    queuedAt: NaN, // when a message was last queued (sent while a turn was running)
    trigger: '', // what the next reply answers: 'report' (a report-back or relayed notice)
    turnFrom: '', // what started the current turn: 'you', 'schedule' or 'report'
    cost: null, // the latest cost-state record
    context: null, // {tokens, model} from the latest reply's usage: what the context holds now
  };
  const newTurn = (at, byYou) => {
    // You starting a turn answers any question left waiting; a report-back's turn doesn't.
    s.pendingAsk = byYou ? '' : (s.wrapUp && s.wrapUp.ask) || s.pendingAsk;
    s.turnEnded = false;
    s.interrupted = false;
    s.apiError = null;
    s.turnStartAt = at;
    s.trigger = '';
    s.wrapUp = null;
    s.plan = null;
    s.pending.clear();
  };
  const endTurn = (at) => {
    s.turnEnded = true;
    s.endedAt = at;
    s.pending.clear();
  };

  for (const r of records) {
    if (!r || typeof r !== 'object' || r.isSidechain) continue;
    // Usage so far, written between turns; it carries no time and says nothing about the turn.
    if (r.type === 'cost-state') {
      s.cost = r;
      continue;
    }
    const at = ms(r);
    const kind = userKind(r);
    // Records are not always in time order (compaction, interrupts); keep the latest time seen.
    if ((r.type === 'assistant' || r.type === 'system' || kind === 'result' || kind === 'prompt' || kind === 'command') && at > (s.lastAt || 0)) {
      s.lastAt = at;
    }

    // Completions are queued before they are delivered; either record ends the task.
    // A finished task is queued for the model (and written here) a moment before it's delivered:
    // count that as the report-back, so the row doesn't flash "finished" in between.
    let ended = 0;
    // A message sent while a turn runs is queued (and written here) as it is sent.
    const queued = (r.type === 'queue-operation' && r.operation === 'enqueue') || (r.type === 'attachment' && r.attachment && r.attachment.type === 'queued_command');
    if (queued && !Number.isNaN(at)) s.queuedAt = Math.max(s.queuedAt || 0, at);
    if (r.type === 'queue-operation') ended = finishTasks(typeof r.content === 'string' ? r.content : '', s.background, s.finished, at);
    if (r.type === 'attachment' && r.attachment) ended = finishTasks(String(r.attachment.prompt || ''), s.background, s.finished, at);
    if (ended && s.turnEnded && !Number.isNaN(at)) s.wokeAt = at;

    if (kind === 'result') {
      for (const c of contentOf(r)) {
        if (c.type !== 'tool_result') continue;
        const call = s.pending.get(c.tool_use_id);
        if (call) {
          const id = backgroundTaskId(call, resultText(c));
          if (id) s.background.set(id, { id, ...callInfo(call.name, call.input, at) });
          // A stopped task writes no completion notice.
          if (STOP_TOOLS.has(call.name) && !c.is_error) {
            const stopped = call.input.task_id || call.input.shell_id;
            s.background.delete(stopped);
            s.finished.set(stopped, at);
          }
        }
        s.pending.delete(c.tool_use_id);
      }
      continue;
    }

    // A background task or another session reporting back: the reply that follows (which starts
    // the turn) is about that, not about your previous prompt.
    if (kind === 'wake' || kind === 'peer') {
      if (kind === 'wake') finishTasks(messageText(r), s.background, s.finished, at);
      if (!Number.isNaN(at)) s.wokeAt = at;
      // Between turns it explains the reply to come; mid-turn, your request stays the subject.
      if (s.turnEnded) {
        s.trigger = 'report';
        s.lastPrompt = kind === 'wake' ? 'A background task reported back' : 'Another session sent a message';
        s.promptByYou = false;
      }
      continue;
    }

    if (kind === 'prompt' || kind === 'command') {
      const text = messageText(r);
      finishTasks(text, s.background, s.finished, at);
      if (/^\[Request interrupted by user/.test(text)) {
        endTurn(at);
        s.interrupted = true;
        continue;
      }
      const line = promptLine(text);
      // A message sent while a turn runs joins that turn; otherwise it starts a new one.
      if (kind === 'prompt' && s.turnEnded) {
        newTurn(at, true);
        s.turnFrom = line.byYou ? 'you' : 'schedule';
      }
      // A prompt that was nothing but added blocks leaves your last request in place.
      if (line.text) {
        s.lastPrompt = line.text;
        s.promptByYou = line.byYou;
      }
      continue;
    }

    if (r.type === 'assistant') {
      const msg = r.message || {};
      // Each reply's usage says what the request carried: the context as it stands after the
      // reply. The latest one is the session's context now (the same sum Claude Code shows).
      const used = contextUsed(msg.usage);
      if (used !== null) s.context = { tokens: used, model: typeof msg.model === 'string' ? msg.model : '' };
      // The app's own placeholder reply when it resumes a session ("No response requested.") is
      // not the model answering: it starts nothing and keeps a failure, but it does close a turn
      // the app quit in the middle of (whatever was pending then will never finish).
      if (msg.model === '<synthetic>' && !r.isApiErrorMessage) {
        if (!s.turnEnded) endTurn(at);
        continue;
      }
      // Work with no prompt in view (the tail starts mid-turn, or a scheduled wake-up).
      if (s.turnEnded && !Number.isNaN(at)) {
        const from = s.trigger; // read before newTurn uses it up
        newTurn(at);
        s.turnFrom = from;
      }
      for (const c of contentOf(r)) {
        if (c.type !== 'tool_use') continue;
        const input = c.input && typeof c.input === 'object' ? c.input : {};
        const name = typeof c.name === 'string' ? c.name : '';
        if (name === 'mcp__ccd_turn__update_plan') s.plan = applyPlan(s.plan, input);
        if (name === 'mcp__ccd_turn__wrap_up') s.wrapUp = { recap: input.recap, ask: input.ask };
        s.pending.set(c.id, { name, input, at });
      }
      if (r.isApiErrorMessage) {
        // Every 5xx arrives as server_error; an overloaded API is told apart only by its status.
        const kind = r.apiErrorStatus === 529 ? 'overloaded' : typeof r.error === 'string' ? r.error : 'error';
        s.apiError = { kind, at };
        endTurn(at);
        continue;
      }
      s.apiError = null;
      // Each block of a reply is its own record, and even the first (thinking) one carries the
      // reply's final stop reason. Only a block that shows the reply itself ends the turn; the
      // stop-hook record that follows ends it otherwise.
      const blocks = contentOf(r);
      const onlyThinking = blocks.length > 0 && blocks.every((c) => c.type === 'thinking' || c.type === 'redacted_thinking');
      const ending = msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence' || msg.stop_reason === 'max_tokens';
      if (ending && !onlyThinking) endTurn(at);
      continue;
    }

    // A /compact you ran on a turn that had already stopped closes it, rather than waking it.
    if (r.type === 'system' && r.subtype === 'compact_boundary' && r.compactMetadata && r.compactMetadata.trigger === 'manual' && !s.turnEnded) {
      endTurn(at);
      continue;
    }

    if (r.type === 'system' && (r.subtype === 'stop_hook_summary' || r.subtype === 'turn_duration') && !s.turnEnded) {
      endTurn(at);
    }
  }

  // A report-back turn that ends without a next-step box leaves the earlier question standing.
  let wrapUp = s.wrapUp;
  if (!wrapUp && s.turnEnded && s.pendingAsk) wrapUp = { recap: '', ask: s.pendingAsk };

  return {
    turnEnded: s.turnEnded,
    interrupted: s.interrupted,
    turnStartAt: s.turnStartAt,
    endedAt: s.endedAt,
    lastAt: s.lastAt,
    pending: [...s.pending.values()].filter((p) => !SILENT_TOOLS.has(p.name)).map((p) => callInfo(p.name, p.input, p.at)),
    background: [...s.background.values()],
    wrapUp,
    plan: s.plan,
    lastPrompt: s.lastPrompt,
    promptByYou: s.promptByYou,
    apiError: s.apiError,
    wokeAt: s.wokeAt,
    finished: [...s.finished.keys()],
    finishedAt: Object.fromEntries(s.finished),
    queuedAt: s.queuedAt,
    turnFrom: s.turnFrom,
    cost: s.cost ? costOf(s.cost) : null,
    context: s.context,
  };
}

/**
 * What a reply's usage says the context held: input tokens plus the cache it read and wrote,
 * the sum Claude Code's own percentage is made of (output tokens are not in it). null when the
 * usage is missing or says nothing.
 */
function contextUsed(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
  if (!parts.some((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return parts.reduce((sum, v) => sum + amount(v), 0);
}

/**
 * The model's context window, as Claude Code's documentation gives it: 200k, or 1M for the models
 * with a native 1M window (Fable and Mythos, Sonnet 5 and later, Haiku 5.5 and later, Opus 4.7
 * and later) and for any model asked for with the [1m] suffix. An unknown model is taken as 200k,
 * as Claude Code does.
 */
function contextWindow(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('[1m]')) return 1e6;
  const native = [/claude-(?:fable|mythos)-/, /claude-sonnet-[5-9]/, /claude-haiku-(?:5-[5-9]|[6-9])/, /claude-opus-(?:4-(?:[7-9]|\d{2})|[5-9])/];
  return native.some((re) => re.test(m)) ? 1e6 : 2e5;
}

/**
 * The context of a session as a row shows it: tokens held, the window, and the percentage the
 * app itself shows (rounded, never above 100). null without a reply to read it from.
 * @param {{tokens: number, model: string}|null} context  from summarize()
 * @param {string} fallbackModel  the app's model for the session, for a reply that names none
 */
function contextOf(context, fallbackModel = '') {
  if (!context) return null;
  const window = contextWindow(context.model || fallbackModel);
  return { tokens: context.tokens, window, pct: Math.min(100, Math.round((context.tokens / window) * 100)) };
}

module.exports = { readTail, readTailWindow, summarize, describeTool, applyPlan, clip, costOf, contextUsed, contextWindow, contextOf, ASKING_TOOLS, LONG_TOOLS };
