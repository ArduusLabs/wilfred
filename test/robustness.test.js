// Malformed input, odd files, clocks and caches: the cases a long day on a real machine produces.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionSource, cleanMeta } = require('../src/sessions/source');
const { summarize, readTailWindow, describeTool, applyPlan } = require('../src/sessions/transcript');
const { sessionStatus } = require('../src/sessions/status');

const CLI = '0a1b2c3d-3333-4444-8555-966677778888';
const ts = (ms) => new Date(ms).toISOString();

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wilfred-rob-'));
  const sessions = path.join(dir, 'sessions');
  const projects = path.join(dir, 'projects');
  const proj = path.join(projects, 'C--repo');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const transcript = path.join(proj, `${CLI}.jsonl`);
  return {
    dir, sessions, projects, proj, transcript,
    meta: (name, body) => fs.writeFileSync(path.join(sessions, name), typeof body === 'string' ? body : JSON.stringify(body)),
    lines: (records) => fs.writeFileSync(transcript, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('cleanMeta keeps well-typed fields and drops the rest', () => {
  assert.equal(cleanMeta(null, 1), null);
  assert.equal(cleanMeta([], 1), null);
  assert.equal(cleanMeta('x', 1), null);
  assert.equal(cleanMeta({ title: 'no id' }, 1), null);
  const m = cleanMeta({
    sessionId: 'local_a', title: {}, cwd: 5, lastActivityAt: 'yesterday', lastTurnEdgeAt: 'x', lastFocusedAt: Infinity,
    isArchived: 'yes', postTurnSummary: [], extra: 'kept',
  }, 777);
  assert.equal(m.title, undefined);
  assert.equal(m.cwd, undefined);
  assert.equal(m.lastActivityAt, 777); // falls back to the file's time
  assert.equal(m.lastTurnEdgeAt, undefined);
  assert.equal(m.lastFocusedAt, undefined);
  assert.equal(m.isArchived, false);
  assert.equal(m.postTurnSummary, null);
  assert.equal(m.extra, 'kept');
  assert.equal(cleanMeta({ sessionId: 'local_a', postTurnSummary: null }, 1).postTurnSummary, null);
  assert.equal(cleanMeta({ sessionId: 'local_a', postTurnSummary: 'done' }, 1).postTurnSummary, null);
  assert.deepEqual(cleanMeta({ sessionId: 'local_a', postTurnSummary: { status_category: 'completed' } }, 1).postTurnSummary,
    { status_category: 'completed', status_detail: undefined, needs_action: undefined, summarizes_uuid: undefined });
  // A row from junk-typed metadata renders sensibly rather than "[object Object]" or "NaNh".
  const row = sessionStatus(m, null, 1000);
  assert.equal(row.title, 'Untitled session');
  assert.ok(Number.isFinite(row.since));
});

test('a session file containing null, an array or a BOM never freezes the board', () => {
  const f = fixture();
  const n = Date.now();
  f.meta('local_null.json', 'null');
  f.meta('local_arr.json', '[1,2]');
  f.meta('local_bom.json', '\uFEFF' + JSON.stringify({ sessionId: 'local_bom', title: 'With BOM', lastActivityAt: n }));
  f.meta('local_ok.json', { sessionId: 'local_ok', title: 'Fine', lastActivityAt: n });
  const errors = [];
  const pushed = [];
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: (r) => pushed.push(r), onError: (e) => errors.push(e) });
  src.tick();
  src.tick();
  assert.deepEqual(errors, []);
  assert.deepEqual(pushed[0].map((r) => r.title).sort(), ['Fine', 'With BOM']);
  f.cleanup();
});

test('malformed tool input from the model is ignored rather than breaking the summary', () => {
  const at = Date.parse('2026-10-29T10:00:00Z');
  const t = summarize([
    null,
    [1],
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at + 1), message: { stop_reason: 'tool_use', content: [null, 7, { type: 'tool_use', id: 'p', name: 'mcp__ccd_turn__update_plan', input: { items: [null, { content: 'Real step', status: 'in_progress' }] } }] } },
    { type: 'user', timestamp: ts(at + 2), message: { content: [null, { type: 'tool_result', tool_use_id: 'p', content: 'ok' }] } },
    { type: 'assistant', timestamp: ts(at + 3), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'p2', name: 'mcp__ccd_turn__update_plan', input: { done: 3, start: 'x' } }] } },
    { type: 'assistant', timestamp: ts(at + 4), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: 'not an object' }] } },
  ]);
  assert.equal(t.turnEnded, false);
  assert.deepEqual(t.plan, [{ content: 'Real step', status: 'in_progress' }]);
  assert.equal(t.pending.at(-1).label, 'Running a command');
  assert.deepEqual(applyPlan([{ content: 'a', status: 'pending' }], { done: 'all' }), [{ content: 'a', status: 'pending' }]);
});

test('file names come out right for Windows paths on any platform', () => {
  assert.equal(describeTool('Edit', { file_path: 'C:\\repo\\src\\main.js' }), 'Editing main.js');
  assert.equal(describeTool('Read', { file_path: '/Users/me/repo/notes.md' }), 'Reading notes.md');
  assert.equal(describeTool('Write', { file_path: 'C:\\repo\\dir\\\\' }), 'Writing dir');
});

test('readTailWindow strips a BOM and starts big when told the turn needs it', () => {
  const f = fixture();
  const pad = 'p'.repeat(1024);
  const lines = [JSON.stringify({ type: 'user', timestamp: ts(1), message: { content: 'turn start' } })];
  for (let i = 0; i < 1200; i++) lines.push(JSON.stringify({ type: 'progress', pad })); // ~1.2 MB after the prompt
  fs.writeFileSync(f.transcript, '\uFEFF' + lines.join('\n') + '\n');
  const size = fs.statSync(f.transcript).size;
  const grown = readTailWindow(f.transcript, size);
  assert.equal(grown.bytes, 2 * 1024 * 1024); // had to grow past 512 KB to find the prompt
  assert.equal(summarize(grown.records).lastPrompt, 'turn start');
  const direct = readTailWindow(f.transcript, size, grown.bytes);
  assert.equal(direct.bytes, grown.bytes);
  assert.equal(direct.records.length, grown.records.length);
  // A tiny file is read whole, BOM and all, without losing its first record.
  fs.writeFileSync(f.transcript, '\uFEFF' + lines[0] + '\n');
  assert.equal(summarize(readTailWindow(f.transcript, fs.statSync(f.transcript).size).records).lastPrompt, 'turn start');
  // Never more than the cap, whatever is asked for.
  assert.ok(readTailWindow(f.transcript, fs.statSync(f.transcript).size, 1e9).bytes <= 4 * 1024 * 1024);
  f.cleanup();
});

test('a growing transcript is read from the window that last held its turn', () => {
  const f = fixture();
  const n = Date.now();
  f.meta('local_a.json', { sessionId: 'local_a', cliSessionId: CLI, lastActivityAt: n });
  const pad = 'p'.repeat(1024);
  const recs = [{ type: 'user', timestamp: ts(n), message: { content: 'long turn' } }];
  for (let i = 0; i < 1200; i++) recs.push(JSON.stringify({ type: 'progress', pad }));
  f.lines(recs);
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {} });
  src.read();
  // The next window is the turn's own size plus a little room: about 1.2 MB + 64 KB, not 2 MB.
  const first = src.tailCache.get(f.transcript).window;
  assert.ok(first > 1.2 * 1024 * 1024 && first < 1.4 * 1024 * 1024, `window ${first}`);
  fs.appendFileSync(f.transcript, JSON.stringify({ type: 'progress', pad }) + '\n');
  src.read();
  const entry = src.tailCache.get(f.transcript);
  assert.ok(entry.window > first && entry.window < first + 2048, `window ${entry.window}`);
  assert.equal(entry.summary.lastPrompt, 'long turn');
  // A file that shrank (rewritten) starts over from the default window.
  f.lines([{ type: 'user', timestamp: ts(n), message: { content: 'fresh' } }]);
  src.read();
  assert.equal(src.tailCache.get(f.transcript).summary.lastPrompt, 'fresh');
  f.cleanup();
});

test('caches notice a change in size or in time alone, and forget sessions that leave', () => {
  const f = fixture();
  const n = Date.now();
  const metaFile = path.join(f.sessions, 'local_a.json');
  f.meta('local_a.json', { sessionId: 'local_a', cliSessionId: CLI, title: 'One', lastActivityAt: n });
  f.lines([{ type: 'user', timestamp: ts(n), message: { content: 'first' } }]);
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {} });
  assert.equal(src.read()[0].title, 'One');
  // Same size, new contents, new time: re-read.
  const t1 = new Date(n + 5000);
  f.meta('local_a.json', { sessionId: 'local_a', cliSessionId: CLI, title: 'Two', lastActivityAt: n });
  fs.utimesSync(metaFile, t1, t1);
  assert.equal(src.read()[0].title, 'Two');
  // Same time, different size: re-read.
  const before = fs.statSync(metaFile).mtime;
  f.meta('local_a.json', { sessionId: 'local_a', cliSessionId: CLI, title: 'Three!', lastActivityAt: n });
  fs.utimesSync(metaFile, before, before);
  assert.equal(src.read()[0].title, 'Three!');
  // Transcript rewritten in place with the same size but a new time.
  f.lines([{ type: 'user', timestamp: ts(n), message: { content: 'secnd' } }]);
  const t2 = new Date(n + 9000);
  fs.utimesSync(f.transcript, t2, t2);
  src.read();
  assert.equal(src.tailCache.get(f.transcript).summary.lastPrompt, 'secnd');
  // The session leaves the board: every cache lets go of it.
  fs.rmSync(metaFile);
  src.read();
  assert.equal(src.metaCache.size, 0);
  assert.equal(src.tailCache.size, 0);
  assert.equal(src.transcriptPath.size, 0);
  assert.equal(src.subagents.size, 0);
  f.cleanup();
});

test('subagent files are only checked while a turn is open, and only the recent few each tick', () => {
  const f = fixture();
  const n = Date.now();
  f.meta('local_a.json', { sessionId: 'local_a', cliSessionId: CLI, lastActivityAt: n });
  f.lines([{ type: 'user', timestamp: ts(n), message: { content: 'go' } }, { type: 'assistant', timestamp: ts(n), message: { stop_reason: 'end_turn', content: [] } }]);
  const sub = path.join(f.proj, CLI, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(sub, `agent-${i}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(sub, 'notes.txt'), 'x');
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {} });
  const realStat = fs.statSync;
  let subStats = 0;
  fs.statSync = (p, ...rest) => { if (String(p).includes(`${path.sep}subagents${path.sep}`)) subStats++; return realStat(p, ...rest); };
  try {
    src.read();
    assert.equal(subStats, 0, 'ended turn: no subagent checks');
    f.lines([{ type: 'user', timestamp: ts(n), message: { content: 'again' } }, { type: 'assistant', timestamp: ts(n), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: {} }] } }]);
    src.read();
    assert.equal(subStats, 20, 'first look lists and checks them all');
    subStats = 0;
    src.read();
    assert.equal(subStats, 5, 'then only the most recently active few');
  } finally {
    fs.statSync = realStat;
  }
  // The folder disappearing is handled.
  fs.rmSync(path.join(f.proj, CLI), { recursive: true });
  assert.equal(src.subagentActivity(CLI), 0);
  assert.equal(src.subagentActivity('ffffffff-0000-4000-8000-000000000000'), 0);
  f.cleanup();
});

test('CLAUDE_CONFIG_DIR moves where transcripts are looked for', () => {
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'alt-claude');
  try {
    const src = new SessionSource({ windowMs: 1, onRows: () => {} });
    assert.equal(src.projectsDir, path.join(os.tmpdir(), 'alt-claude', 'projects'));
  } finally {
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = old;
  }
});

test('time asleep is not counted as a tool being stuck', () => {
  const at = Date.parse('2026-10-29T10:00:00Z');
  const t = summarize([
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.md' } }] } },
  ]);
  const meta = { sessionId: 'local_x', lastFocusedAt: at };
  // Asleep from 10 s after the tool started until 20 min later.
  const sleep = { from: at + 10_000, to: at + 20 * 60_000 };
  assert.equal(sessionStatus(meta, t, sleep.to + 5000).state, 'needs-you'); // no sleep known: flagged
  assert.equal(sessionStatus(meta, t, sleep.to + 5000, { sleeps: [sleep] }).state, 'working'); // 15 s awake + 10 s before
  assert.equal(sessionStatus(meta, t, sleep.to + 90_000, { sleeps: [sleep] }).state, 'needs-you'); // quiet long enough awake
  // A tool already held up before the sleep stays flagged right after waking.
  const late = { from: at + 5 * 60_000, to: at + 25 * 60_000 };
  assert.equal(sessionStatus(meta, t, late.to + 2000, { sleeps: [late] }).state, 'needs-you');
  // A sleep that ended before the tool started changes nothing.
  assert.equal(sessionStatus(meta, t, at + 90_000, { sleeps: [{ from: at - 60_000, to: at - 1000 }] }).state, 'needs-you');
  // With no time information at all, nothing is called stuck.
  const bare = summarize([{ type: 'user', message: { content: 'go' } }, { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: {} }] } }]);
  assert.equal(sessionStatus({ sessionId: 'local_x' }, bare, at).state, 'working');
});

test('a just-ended turn counts as seen if you focused it within two seconds before', () => {
  const at = 1_000_000;
  const t = summarize([{ type: 'user', message: { content: 'go' } }, { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }]);
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: at, lastFocusedAt: at - 1500 }, t, at).state, 'idle');
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: at, lastFocusedAt: at - 2500 }, t, at).state, 'new');
});

test('stop really stops polling', async () => {
  let ticks = 0;
  const src = new SessionSource({ sessionDirs: [], windowMs: 1, onRows: () => {}, pollMs: 5 });
  src.read = () => { ticks++; return []; };
  src.start();
  src.stop();
  const after = ticks;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ticks, after);
});


test('waking the computer does not bring a dead turn back to life', () => {
  const at = Date.parse('2026-10-29T08:00:00Z');
  const t = summarize([
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }] } },
    { type: 'user', timestamp: ts(at + 2000), message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] } },
  ]);
  const now = at + 179 * 60_000;
  const sleep = { from: now - 10 * 60_000, to: now - 2 * 60_000 };
  const row = sessionStatus({ sessionId: 'local_x' }, t, now, { sleeps: [sleep] });
  assert.equal(row.state, 'idle');
  assert.equal(row.headline, 'Stopped mid-turn, no activity since');
  assert.equal(row.since, at + 2000); // when it went quiet, not an earlier turn's end
  // A long sleep in the middle of a short silence keeps it alive.
  const short = { from: at + 5000, to: at + 3 * 3600_000 };
  assert.equal(sessionStatus({ sessionId: 'local_x' }, t, short.to + 60_000, { sleeps: [short] }).state, 'working');
});

test('a tool call without a proper name still shows, and never stops the board', () => {
  const at = Date.parse('2026-10-29T08:00:00Z');
  const t = summarize([
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', input: {} }, { type: 'tool_use', id: 'y', name: 42 }] } },
  ]);
  assert.deepEqual(t.pending.map((p) => p.name), ['', '']);
  const row = sessionStatus({ sessionId: 'local_x' }, t, at + 10 * 60_000);
  assert.equal(row.state, 'needs-you');
  assert.equal(row.headline, 'Working');
});

test('one session that throws costs its own row only, and reading is always reset', () => {
  const f = fixture();
  const n = Date.now();
  f.meta('local_a.json', { sessionId: 'local_a', title: 'Fine', lastActivityAt: n });
  f.meta('local_b.json', { sessionId: 'local_b', cliSessionId: CLI, title: 'Breaks', lastActivityAt: n });
  f.lines([{ type: 'user', timestamp: ts(n), message: { content: 'go' } }]);
  const errors = [];
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {}, onError: (e) => errors.push(e.message) });
  src.subagentActivity = () => { throw new Error('unexpected'); };
  assert.deepEqual(src.read().map((r) => r.title), ['Fine']);
  assert.deepEqual(errors, ['unexpected']);
  assert.equal(src.reading, false);
  // Even an error outside any one session leaves the flags reset.
  src.scan = () => { throw new Error('disk gone'); };
  assert.throws(() => src.read(), /disk gone/);
  assert.equal(src.reading, false);
  assert.equal(src.projectList, null);
  f.cleanup();
});

test('"You asked" never shows text the app added around your prompt', () => {
  const t = summarize([
    { type: 'user', message: { content: '<system-reminder>\nThe user named a session.\n<side-sessions-event>Session B finished</side-sessions-event>\n</system-reminder>\nplease check the PR' } },
  ]);
  assert.equal(t.lastPrompt, 'please check the PR');
  // A prompt that is only an added block keeps your previous request.
  const only = summarize([
    { type: 'user', message: { content: 'fix the build' } },
    { type: 'user', message: { content: '<system-reminder>Only a reminder</system-reminder>' } },
  ]);
  assert.equal(only.lastPrompt, 'fix the build');
});

test('the read window shrinks back once a new turn starts near the end', () => {
  const f = fixture();
  const n = Date.now();
  f.meta('local_a.json', { sessionId: 'local_a', cliSessionId: CLI, lastActivityAt: n });
  const pad = 'p'.repeat(1024);
  const recs = [{ type: 'user', timestamp: ts(n), message: { content: 'long turn' } }];
  for (let i = 0; i < 3000; i++) recs.push(JSON.stringify({ type: 'progress', pad })); // ~3 MB turn
  f.lines(recs);
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {} });
  src.read();
  assert.ok(src.tailCache.get(f.transcript).window > 3 * 1024 * 1024);
  fs.appendFileSync(f.transcript, [JSON.stringify({ type: 'assistant', timestamp: ts(n), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }), JSON.stringify({ type: 'user', timestamp: ts(n), message: { content: 'short one' } })].join('\n') + '\n');
  src.read();
  const entry = src.tailCache.get(f.transcript);
  assert.equal(entry.summary.lastPrompt, 'short one');
  assert.ok(entry.window < 100 * 1024, `window ${entry.window}`);
  f.cleanup();
});

test('a quiet subagent that starts writing again is noticed within the re-list interval', () => {
  const f = fixture();
  let clock = Date.now();
  f.meta('local_a.json', { sessionId: 'local_a', cliSessionId: CLI, lastActivityAt: clock });
  f.lines([{ type: 'user', timestamp: ts(clock), message: { content: 'go' } }, { type: 'assistant', timestamp: ts(clock), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: {} }] } }]);
  const sub = path.join(f.proj, CLI, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const base = clock - 600_000;
  for (let i = 0; i < 7; i++) {
    const file = path.join(sub, `agent-${i}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    const t = new Date(base + (i === 0 ? 0 : 60_000 + i * 1000)); // agent-0 is the oldest
    fs.utimesSync(file, t, t);
  }
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {}, now: () => clock });
  src.read();
  src.transcriptPath.set(CLI, f.transcript);
  const before = src.subagentActivity(CLI);
  // agent-0 writes again; the folder itself doesn't change, and agent-0 isn't among the top five.
  const later = new Date(clock + 5000);
  fs.utimesSync(path.join(sub, 'agent-0.jsonl'), later, later);
  assert.equal(src.subagentActivity(CLI), before);
  clock += 31_000;
  assert.equal(Math.round(src.subagentActivity(CLI)), Math.round(later.getTime()));
  f.cleanup();
});

test('only well-typed fields of the app summary are used', () => {
  const m = cleanMeta({ sessionId: 'local_a', postTurnSummary: { status_category: 'completed', status_detail: { x: 1 }, needs_action: 7, summarizes_uuid: 'u' } }, 1);
  assert.deepEqual(m.postTurnSummary, { status_category: 'completed', status_detail: undefined, needs_action: undefined, summarizes_uuid: 'u' });
  const row = sessionStatus({ ...m, lastAssistantUuid: 'u', lastFocusedAt: 5, lastTurnEdgeAt: 1 }, null, 10);
  assert.equal(row.headline, 'Finished');
});

test('the tail reader skips blank lines, non-record JSON, and a window that falls inside one huge line', () => {
  const f = fixture();
  const prompt = JSON.stringify({ type: 'user', message: { content: 'hello' } });
  fs.writeFileSync(f.transcript, ['', 'null', '[1,2]', '5', '   ', prompt, ''].join('\n'));
  const small = readTailWindow(f.transcript, fs.statSync(f.transcript).size);
  assert.deepEqual(small.records.map((r) => r.type), ['user']);
  assert.ok(small.turnBytes > 0 && small.turnBytes < 100);
  // A single 5 MB line with no line break anywhere in the 4 MB window: nothing whole to read.
  fs.writeFileSync(f.transcript, JSON.stringify({ type: 'progress', pad: 'x'.repeat(5 * 1024 * 1024) }));
  const huge = readTailWindow(f.transcript, fs.statSync(f.transcript).size);
  assert.deepEqual(huge.records, []);
  assert.equal(huge.turnBytes, huge.bytes); // no turn start seen: the whole window
  f.cleanup();
});

test('background work started long ago is found on a fresh start and kept until it ends', () => {
  const f = fixture();
  const n = Date.now();
  f.meta('local_a.json', { sessionId: 'local_a', cliSessionId: CLI, title: 'A', lastActivityAt: n, lastTurnEdgeAt: n, lastFocusedAt: n });
  const pad = 'p'.repeat(1024);
  const recs = [
    { type: 'user', timestamp: ts(n - 9000), message: { content: 'start the agent' } },
    { type: 'assistant', timestamp: ts(n - 8000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'Long review' } }] } },
    { type: 'user', timestamp: ts(n - 7000), message: { content: [{ type: 'tool_result', tool_use_id: 'ag', content: 'Async agent launched successfully.\nagentId: agentLONG1' }] } },
    { type: 'assistant', timestamp: ts(n - 6000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'running' }] } },
  ];
  // Then 600 KB of other turns, pushing the launch out of the default 512 KB window.
  for (let i = 0; i < 600; i++) recs.push(JSON.stringify({ type: 'progress', pad }));
  recs.push({ type: 'user', timestamp: ts(n - 2000), message: { content: 'meanwhile, another thing' } });
  recs.push({ type: 'assistant', timestamp: ts(n - 1000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
  f.lines(recs);
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {}, now: () => n + 30_000 });
  let row = src.read()[0];
  assert.equal(row.state, 'working');
  assert.equal(row.headline, 'In background: Agent: Long review');
  // Later reads use a small window that no longer holds the launch; the agent is carried forward.
  fs.appendFileSync(f.transcript, [
    { type: 'user', timestamp: ts(n), message: { content: 'one more' } },
    { type: 'assistant', timestamp: ts(n), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'mo', name: 'Monitor', input: { description: 'CI' } }] } },
    { type: 'user', timestamp: ts(n), message: { content: [{ type: 'tool_result', tool_use_id: 'mo', content: 'Monitor started (task mon9, timeout 1800000ms).' }] } },
    { type: 'assistant', timestamp: ts(n + 1), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  row = src.read()[0];
  assert.ok(src.tailCache.get(f.transcript).window < 200 * 1024);
  // The old agent (carried forward) and the new Monitor (in the window) both count.
  assert.equal(row.headline, 'In background: Watching: CI (+1 more)');
  // Their completion ends both.
  fs.appendFileSync(f.transcript, JSON.stringify({ type: 'queue-operation', timestamp: ts(n + 2), content: '<task-notification>\n<task-id>agentLONG1</task-id>\n<task-id>mon9</task-id>\n<status>completed</status>' }) + '\n');
  row = src.read()[0];
  // Straight to reading the result (no flash of "finished"), not back to background work.
  assert.equal(row.headline, 'Reading what came back…');
  f.cleanup();
});

test('turn boundaries: the app starting a turn, a report-back, and the moment before the app catches up', () => {
  const at = Date.parse('2026-10-29T10:00:00Z');
  const ended = summarize([
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: ts(at + 3900) }, // real turns always have it
  ]);
  // You just replied: the app moved its edge before your message reached the transcript.
  const replied = { sessionId: 'local_x', lastTurnEdgeAt: at + 60_000, latestUserFrameAt: at + 60_000, lastFocusedAt: at + 60_000 };
  const starting = sessionStatus(replied, ended, at + 61_000);
  assert.equal(starting.state, 'working');
  assert.equal(starting.headline, 'Starting…');
  assert.equal(sessionStatus(replied, ended, at + 75_000).state, 'idle');
  // The turn just ended; the app still has the old edge: a brief "Wrapping up…", not "finished".
  const stale = { sessionId: 'local_x', lastTurnEdgeAt: at - 3600_000, lastFocusedAt: at - 3600_000 };
  const wrapping = sessionStatus(stale, ended, at + 3000);
  assert.equal(wrapping.state, 'working');
  assert.equal(wrapping.headline, 'Wrapping up…');
  // Once the grace passes, "seen" is measured against when the turn really ended: new.
  assert.equal(sessionStatus(stale, ended, at + 15_000).state, 'new');
});

test('round 3: the app stamping its edge after a turn ends is not a new turn', () => {
  const at = Date.parse('2026-10-29T12:00:00Z');
  // Real timing: end_turn, the app's edge ~3 s later, the stop-hook record just after it.
  const t = summarize([
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: ts(at + 4200) },
  ]);
  const m = { sessionId: 'local_x', lastTurnEdgeAt: at + 4000, lastFocusedAt: 0 };
  for (const dt of [4500, 6000, 9000]) assert.equal(sessionStatus(m, t, at + dt).state, 'new', `+${dt}`);
  // You really did just send a message: the turn-start stamp is past everything in the transcript.
  const sent = { sessionId: 'local_x', lastTurnEdgeAt: at + 30_000, latestUserFrameAt: at + 30_000, lastFocusedAt: at + 30_000 };
  assert.equal(sessionStatus(sent, t, at + 31_000).headline, 'Starting…');
  // The stop-hook record often lands minutes late; before it does, the turn-end edge is newer
  // than anything in the transcript. That must not read as a new turn either.
  const noHookYet = summarize([
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
  ]);
  const ending = { sessionId: 'local_x', lastTurnEdgeAt: at + 4000, latestUserFrameAt: at - 500, lastFocusedAt: 0 };
  for (const dt of [4500, 8000]) assert.equal(sessionStatus(ending, noHookYet, at + dt).state, 'new', `no hook +${dt}`);
  // A session the app marks as having no transcript isn't "starting".
  assert.equal(sessionStatus({ sessionId: 'local_y', createdAt: at, transcriptUnavailable: true }, null, at + 5000).headline, 'Finished');
});

test('round 3: a Monitor that expires is no longer running', () => {
  const t = summarize([
    { type: 'user', message: { content: 'watch CI' } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'm', name: 'Monitor', input: { description: 'CI build' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'm', content: 'Monitor started (task mexp1, timeout 600000ms).' }] } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'watching' }] } },
    { type: 'queue-operation', content: '<task-notification>\n<task-id>mexp1</task-id>\n<event>[Monitor expired after 10m with 3 events]</event>\n</task-notification>' },
  ]);
  assert.deepEqual(t.background, []);
});

test('round 3: a brand-new session reads as starting, and its transcript is found as soon as it appears', () => {
  const f = fixture();
  let clock = Date.now();
  f.meta('local_new.json', { sessionId: 'local_new', cliSessionId: CLI, title: 'Fresh', createdAt: clock, lastActivityAt: clock });
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {}, now: () => clock });
  let row = src.read()[0];
  assert.equal(row.state, 'working');
  assert.equal(row.headline, 'Starting…');
  clock += 3000;
  f.lines([
    { type: 'user', timestamp: ts(clock - 500), message: { content: 'run the tests' } },
    { type: 'assistant', timestamp: ts(clock), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { description: 'npm test' } }] } },
  ]);
  clock += 1500; // the very next tick, not 30 s later
  row = src.read()[0];
  assert.equal(row.headline, 'Running: npm test');
  // An older session with no transcript (run elsewhere) just reads as finished.
  assert.equal(sessionStatus({ sessionId: 'local_o', createdAt: clock - 3600_000 }, null, clock).headline, 'Finished');
  assert.equal(sessionStatus({ sessionId: 'local_o' }, null, clock).headline, 'Finished');
  f.cleanup();
});

test('round 3: stopping a turn does not hide work still running in the background', () => {
  const at = Date.parse('2026-10-29T12:00:00Z');
  const base = [
    { type: 'user', timestamp: ts(at), message: { content: 'serve it' } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { description: 'Dev server', run_in_background: true } }] } },
    { type: 'user', timestamp: ts(at + 2000), message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'Command running in background with ID: srv1' }] } },
    { type: 'assistant', timestamp: ts(at + 3000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { description: 'Long check' } }] } },
  ];
  const interrupted = summarize([...base, { type: 'user', timestamp: ts(at + 4000), message: { content: '[Request interrupted by user for tool use]' } }]);
  const row = sessionStatus({ sessionId: 'local_x' }, interrupted, at + 5 * 60_000);
  assert.equal(row.state, 'working');
  assert.equal(row.headline, 'In background: Dev server');
  assert.equal(row.detail, 'Stopped by you; this is still running.');
  // A turn that died with background work out: the work is still shown.
  const dead = summarize([...base, { type: 'user', timestamp: ts(at + 4000), message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: 'ok' }] } }]);
  const d = sessionStatus({ sessionId: 'local_x' }, dead, at + 60 * 60_000);
  assert.equal(d.state, 'working');
  assert.equal(d.detail, 'Stopped mid-turn; this is still running.');
});

test('round 3: several sleeps in one turn are all left out of its silence', () => {
  const at = Date.parse('2026-10-29T08:00:00Z');
  const t = summarize([
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: { description: 'Review' } }] } },
  ]);
  const now = at + 120 * 60_000;
  const sleeps = [{ from: at + 5 * 60_000, to: at + 60 * 60_000 }, { from: at + 65 * 60_000, to: at + 110 * 60_000 }];
  // 120 min in total, 100 of them asleep: 20 min of silence, so still alive.
  assert.equal(sessionStatus({ sessionId: 'local_x' }, t, now, { sleeps }).state, 'working');
  assert.equal(sessionStatus({ sessionId: 'local_x' }, t, now, { sleeps: [sleeps[1]] }).state, 'idle');
});

test('round 3: a report-back in the middle of a turn keeps your request as its subject', () => {
  const t = summarize([
    { type: 'user', message: { content: 'refactor the parser' } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { description: 'x' } }] } },
    { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification>\n<task-id>q</task-id>\n<status>completed</status>' } },
  ]);
  assert.equal(t.lastPrompt, 'refactor the parser');
  assert.equal(t.promptByYou, true);
});

test('round 3: the resume placeholder closes a turn the app quit in the middle of', () => {
  const t = summarize([
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { description: 'orphan' } }] } },
    { type: 'user', isMeta: true, message: { content: 'Continue from where you left off.' } },
    { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'No response requested.' }] } },
    { type: 'user', message: { content: 'next thing' } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.md' } }] } },
  ]);
  assert.deepEqual(t.pending.map((p) => p.label), ['Reading a.md']); // the orphan is gone
});

test('live round: a question in the transcript is shown at once, not held behind "Wrapping up…"', () => {
  const at = Date.parse('2026-10-29T12:00:00Z');
  const t = summarize([
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at + 500), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'w', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Done.', ask: 'Merge it?' } }] } },
    { type: 'user', timestamp: ts(at + 600), message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
  ]);
  const stale = { sessionId: 'local_x', lastTurnEdgeAt: at - 600_000, lastFocusedAt: 0 };
  const row = sessionStatus(stale, t, at + 2000);
  assert.equal(row.state, 'needs-you');
  assert.equal(row.headline, 'Merge it?');
});

test('live round: the last background task finishing goes straight to reading the result', () => {
  const at = Date.parse('2026-10-29T12:00:00Z');
  const records = [
    { type: 'user', timestamp: ts(at), message: { content: 'build' } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { description: 'Build', run_in_background: true } }] } },
    { type: 'user', timestamp: ts(at + 2000), message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'Command running in background with ID: bq1' }] } },
    { type: 'assistant', timestamp: ts(at + 3000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'started' }] } },
    // The completion is queued (and written) before its user record lands.
    { type: 'queue-operation', operation: 'enqueue', timestamp: ts(at + 60_000), content: '<task-notification>\n<task-id>bq1</task-id>\n<status>completed</status>' },
  ];
  const t = summarize(records);
  const row = sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: at + 3000, lastFocusedAt: 0 }, t, at + 61_000);
  assert.equal(row.state, 'working');
  assert.equal(row.headline, 'Reading what came back…');
  // A notice for a task that wasn't being tracked doesn't count as a report-back.
  const other = summarize([...records.slice(0, 4), { type: 'queue-operation', timestamp: ts(at + 60_000), content: '<task-notification>\n<task-id>zz9</task-id>\n<status>completed</status>' }]);
  assert.ok(Number.isNaN(other.wokeAt));
});

test('round 4: the app stamps the turn edge at creation, and a new session still reads as starting', () => {
  const at = Date.parse('2026-10-29T13:00:00Z');
  const created = { sessionId: 'local_z', createdAt: at, lastActivityAt: at, lastTurnEdgeAt: at };
  assert.equal(sessionStatus(created, null, at + 5000).headline, 'Starting…');
  // An edge well after creation means turns have happened: no longer new.
  assert.equal(sessionStatus({ ...created, lastTurnEdgeAt: at + 20_000 }, null, at + 30_000).headline, 'Finished');
});

test('round 4: a scheduled task fired into an existing session is named as such', () => {
  const t = summarize([
    { type: 'user', message: { content: 'earlier request' } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<scheduled-task name="daily-prs" file="C:\\x\\SKILL.md">\nList PRs\n</scheduled-task>' } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { description: 'List PRs' } }] } },
  ]);
  assert.equal(t.turnEnded, false);
  assert.equal(t.lastPrompt, 'Scheduled task: daily-prs');
  assert.equal(t.promptByYou, false);
});

test('round 4: a slow reply after a report-back stays "reading" while the app says it has started', () => {
  const at = Date.parse('2026-10-29T13:00:00Z');
  const t = summarize([
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: ts(at + 3000) },
    { type: 'user', origin: { kind: 'task-notification' }, timestamp: ts(at + 60_000), message: { content: '<task-notification>\n<task-id>q1</task-id>\n<status>completed</status>' } },
  ]);
  const replying = { sessionId: 'local_x', lastTurnEdgeAt: at + 61_500, lastFocusedAt: at + 61_500 };
  assert.equal(sessionStatus(replying, t, at + 60_000 + 90_000).headline, 'Reading what came back…'); // 90 s on
  assert.equal(sessionStatus(replying, t, at + 60_000 + 16 * 60_000).state, 'idle'); // past the cap
  const noReply = { sessionId: 'local_x', lastTurnEdgeAt: at + 2900, lastFocusedAt: at + 2900 };
  assert.equal(sessionStatus(noReply, t, at + 60_000 + 90_000).state, 'idle'); // nothing started
});

test('round 4: a question still waiting survives a report-back turn that ends without one', () => {
  const t1 = Date.parse('2026-10-29T12:00:00Z');
  const t = summarize([
    { type: 'user', timestamp: ts(t1), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(t1 + 1000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'w', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Built.', ask: 'Deploy it?' } }] } },
    { type: 'user', timestamp: ts(t1 + 2000), message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] } },
    { type: 'assistant', timestamp: ts(t1 + 3000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', origin: { kind: 'task-notification' }, timestamp: ts(t1 + 60_000), message: { content: '<task-notification>\n<task-id>q2</task-id>\n<status>completed</status>' } },
    // The report-back gets its own turn, which ends without a next-step box.
    { type: 'assistant', timestamp: ts(t1 + 62_000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'noted the result' }] } },
  ]);
  assert.equal(t.turnStartAt, t1 + 62_000); // it really was a new turn
  assert.equal(t.wrapUp.ask, 'Deploy it?');
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: t1 + 65_000, lastFocusedAt: t1 + 65_000 }, t, t1 + 80_000).state, 'needs-you');
  // While that report-back turn is still running, the old question isn't the verdict yet.
  const t0 = Date.parse('2026-10-29T13:00:00Z');
  const running = summarize([
    { type: 'user', timestamp: ts(t0), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(t0 + 1000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'w', name: 'mcp__ccd_turn__wrap_up', input: { ask: 'Deploy it?' } }] } },
    { type: 'user', timestamp: ts(t0 + 2000), message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] } },
    { type: 'assistant', timestamp: ts(t0 + 3000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', origin: { kind: 'task-notification' }, timestamp: ts(t0 + 60_000), message: { content: '<task-notification>\n<task-id>q3</task-id>\n<status>completed</status>' } },
    { type: 'assistant', timestamp: ts(t0 + 62_000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'log.txt' } }] } },
  ]);
  assert.equal(running.turnEnded, false);
  assert.equal(running.wrapUp, null);
  // Once you reply, the question is answered and no longer carried.
  const answered = summarize([
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'w', name: 'mcp__ccd_turn__wrap_up', input: { ask: 'Deploy it?' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', message: { content: 'yes, deploy' } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'deployed' }] } },
  ]);
  assert.equal(answered.wrapUp, null);
});

test('round 4: a task carried from before the window that ends reports back at once', () => {
  const f = fixture();
  const n = Date.now();
  f.meta('local_a.json', { sessionId: 'local_a', cliSessionId: CLI, title: 'A', lastActivityAt: n, lastTurnEdgeAt: n - 4000, lastFocusedAt: n });
  const pad = 'p'.repeat(1024);
  const recs = [
    { type: 'user', timestamp: ts(n - 9000), message: { content: 'start it' } },
    { type: 'assistant', timestamp: ts(n - 8000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'Old agent' } }] } },
    { type: 'user', timestamp: ts(n - 7000), message: { content: [{ type: 'tool_result', tool_use_id: 'ag', content: 'Async agent launched successfully.\nagentId: oldAG1' }] } },
    { type: 'assistant', timestamp: ts(n - 6000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'running' }] } },
  ];
  for (let i = 0; i < 700; i++) recs.push(JSON.stringify({ type: 'progress', pad }));
  recs.push({ type: 'user', timestamp: ts(n - 5000), message: { content: 'other' } });
  recs.push({ type: 'assistant', timestamp: ts(n - 4500), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } });
  f.lines(recs);
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {}, now: () => n + 1000 });
  assert.equal(src.read()[0].headline, 'In background: Agent: Old agent');
  fs.appendFileSync(f.transcript, JSON.stringify({ type: 'queue-operation', timestamp: ts(n), content: '<task-notification>\n<task-id>oldAG1</task-id>\n<status>completed</status>' }) + '\n');
  assert.equal(src.read()[0].headline, 'Reading what came back…');
  f.cleanup();
});

test('a permission prompt is flagged the moment the app raises it', () => {
  // The real case: createJiraIssue recorded at 09:14:42.331, the app's edge moved at .350.
  const at = Date.parse('2026-10-30T09:14:42.331Z');
  const records = [
    { type: 'user', timestamp: ts(at - 48_000), message: { content: 'raise the ticket' } },
    { type: 'assistant', timestamp: ts(at - 19_000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { description: 'Check' } }] } },
    { type: 'user', timestamp: ts(at - 18_000), message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] } },
    { type: 'assistant', timestamp: ts(at), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'j', name: 'mcp__atlassian__createJiraIssue', input: {} }] } },
  ];
  const t = summarize(records);
  const meta = { sessionId: 'local_x', lastTurnEdgeAt: at + 19, permissionMode: 'acceptEdits' };
  const row = sessionStatus(meta, t, at + 2000); // two seconds in, not five minutes
  assert.equal(row.state, 'needs-you');
  assert.equal(row.headline, 'Permission needed: atlassian: createJiraIssue');
  assert.equal(row.since, at + 19);
  // Once answered, the tool runs and its result lands: working again.
  const answered = summarize([...records, { type: 'user', timestamp: ts(at + 9000), message: { content: [{ type: 'tool_result', tool_use_id: 'j', content: 'created' }] } }]);
  assert.equal(sessionStatus(meta, answered, at + 9500).state, 'working');
});

test('the prompt signal is not fooled by turn starts, sent messages, or bypass mode', () => {
  const at = Date.parse('2026-10-30T09:00:00Z');
  const base = [
    { type: 'user', timestamp: ts(at), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(at + 30_000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.md' } }] } },
  ];
  const t = summarize(base);
  // The edge from the turn's start, long before the tool: just working.
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: at + 50 }, t, at + 31_000).state, 'working');
  // An edge too long after the tool started (more than a few seconds): not this tool's prompt.
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: at + 40_000 }, t, at + 41_000).state, 'working');
  // You sent a message while it ran: the edge moved, and the transcript queued the message.
  const sent = summarize([...base, { type: 'queue-operation', operation: 'enqueue', timestamp: ts(at + 30_500), content: 'also check b.md' }]);
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: at + 30_600 }, sent, at + 31_000).state, 'working');
  const viaAttachment = summarize([...base, { type: 'attachment', timestamp: ts(at + 30_500), attachment: { type: 'queued_command', prompt: 'also b.md' } }]);
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: at + 30_600 }, viaAttachment, at + 31_000).state, 'working');
  // Something newer is already in the transcript than the edge: the tool moved on.
  const moved = summarize([...base, { type: 'system', subtype: 'informational', timestamp: ts(at + 32_000) }]);
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: at + 30_100 }, moved, at + 33_000).state, 'working');
  // Bypass mode never prompts; and no edge at all says nothing.
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: at + 30_100, permissionMode: 'bypassPermissions' }, t, at + 31_000).state, 'working');
  assert.equal(sessionStatus({ sessionId: 'local_x' }, t, at + 31_000).state, 'working');
  // A question is a question, not a permission prompt.
  const asking = summarize([{ type: 'user', timestamp: ts(at), message: { content: 'go' } }, { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ question: 'Which?' }] } }] } }]);
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: at + 1020 }, asking, at + 2000).headline, 'Which?');
});

test('a relayed notice: an ask the summary lifts from it belongs to the other session', () => {
  const at = Date.parse('2026-10-30T09:30:00Z');
  const records = [
    { type: 'user', timestamp: ts(at), message: { content: 'prep the cutover' } },
    { type: 'assistant', timestamp: ts(at + 1000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: ts(at + 4000) },
    // The app relays another session's report: nothing but its own added blocks.
    { type: 'user', timestamp: ts(at + 60_000), message: { content: '<system-reminder>\n<side-sessions-event>Session B: commit refused, run the ship script there</side-sessions-event>\n</system-reminder>' } },
    { type: 'assistant', uuid: 'a2', timestamp: ts(at + 62_000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'B needs the ship script run.' }] } },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: ts(at + 65_000) },
  ];
  const t = summarize(records);
  assert.equal(t.turnFrom, 'report');
  const pts = { status_category: 'blocked', status_detail: 'built; no PR yet', needs_action: 'run the ship script in that session', summarizes_uuid: 'a2' };
  const meta = { sessionId: 'local_x', lastAssistantUuid: 'a2', lastTurnEdgeAt: at + 64_000, lastFocusedAt: at - 1000, postTurnSummary: pts };
  const row = sessionStatus(meta, t, at + 120_000);
  assert.notEqual(row.state, 'needs-you');
  assert.equal(row.detail, 'Passed on: run the ship script in that session');
  // The same ask from a turn you started is still yours.
  const yours = summarize([...records.slice(0, 3), { type: 'user', timestamp: ts(at + 60_000), message: { content: 'ship it' } }, ...records.slice(4)]);
  assert.equal(yours.turnFrom, 'you');
  assert.equal(sessionStatus(meta, yours, at + 120_000).state, 'needs-you');
  // A relayed turn with no ask in the summary keeps its own detail.
  const quiet = sessionStatus({ ...meta, postTurnSummary: { ...pts, needs_action: undefined, status_category: 'done' } }, t, at + 120_000);
  assert.notEqual(quiet.detail, 'Passed on: undefined');
});
