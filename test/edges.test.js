// The remaining edge cases: missing fields, files that vanish mid-read, and the page-side loader.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { summarize } = require('../src/sessions/transcript');
const { sessionStatus } = require('../src/sessions/status');
const { SessionSource, defaultSessionDirs } = require('../src/sessions/source');

const NOW = Date.parse('2026-10-27T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('view.js registers itself on window when loaded by the page (no module system)', () => {
  const filename = path.join(__dirname, '..', 'src', 'renderer', 'view.js');
  const code = fs.readFileSync(filename, 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { filename });
  assert.equal(typeof sandbox.window.WilfredView.speech, 'function');
  // Without a window either, it falls back to the global object.
  const bare = {};
  vm.runInNewContext(code, bare, { filename });
  assert.equal(typeof bare.WilfredView.ago, 'function');
});

test('status copes with a session file missing every optional field', () => {
  const row = sessionStatus({ sessionId: 'local_x' }, null, NOW);
  assert.equal(row.title, 'Untitled session');
  assert.equal(row.project, '');
  assert.equal(row.since, NOW);
  assert.equal(row.lastActivityAt, 0);
  assert.equal(row.seen, true); // nothing has happened since you last looked, as far as we can tell
  assert.equal(row.state, 'idle');
  assert.equal(row.headline, 'Finished');
});

test('project name: worktree first, scratch folders hidden, otherwise the folder name', () => {
  const p = (meta) => sessionStatus({ sessionId: 'local_x', ...meta }, null, NOW).project;
  assert.equal(p({ worktreeName: 'wt-feature-login', cwd: 'C:\\repos\\billing-api' }), 'wt-feature-login');
  assert.equal(p({ cwd: 'C:\\Users\\me\\AppData\\Local\\Claude-Data\\x\\scratch-workspaces\\a\\b' }), '');
  assert.equal(p({ originCwd: '/home/me/repos/terraform/', cwd: '/elsewhere' }), 'terraform');
});

test('a working session with no plan step, no prompt and no summary', () => {
  const records = [
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'p', name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'a', status: 'completed' }] } }] }, timestamp: iso(NOW - 3000) },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'p', content: 'ok' }] }, timestamp: iso(NOW - 2000) },
  ];
  const t = summarize(records);
  const row = sessionStatus({ sessionId: 'local_x' }, t, NOW);
  assert.equal(row.state, 'working');
  assert.equal(row.headline, 'Thinking…');
  assert.equal(row.step, null); // nothing in progress
  assert.equal(row.detail, '');
});

test('a turn whose start has no timestamp keeps the session time', () => {
  const t = summarize([
    { type: 'user', message: { content: 'go' } }, // no timestamp
    { type: 'assistant', timestamp: iso(NOW - 1000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion' }] } },
  ]);
  assert.ok(Number.isNaN(t.turnStartAt));
  const row = sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: NOW - 50_000 }, t, NOW);
  assert.equal(row.state, 'needs-you');
  assert.equal(row.headline, 'Has a question for you');
  assert.equal(row.since, NOW - 1000);
  // A pending question without a time falls back to the turn's time.
  const noAt = { ...t, pending: [{ ...t.pending[0], at: NaN }] };
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: NOW - 50_000 }, noAt, NOW).since, NOW - 50_000);
});

test('an ended turn with no end time uses the app\'s turn edge', () => {
  const t = summarize([{ type: 'user', message: { content: 'go' }, timestamp: iso(NOW - 9000) }, { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }]);
  assert.ok(Number.isNaN(t.endedAt));
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: NOW - 7000, lastFocusedAt: NOW }, t, NOW).since, NOW - 7000);
});

test('a summary with no timed records, and a tool result of an unknown shape', () => {
  const row = sessionStatus({ sessionId: 'local_x', lastFocusedAt: NOW }, summarize([]), NOW);
  assert.equal(row.state, 'idle');
  const t = summarize([
    { type: 'user', message: { content: 'go' }, timestamp: iso(NOW - 3000) },
    { type: 'assistant', timestamp: iso(NOW - 2000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { run_in_background: true } }] } },
    { type: 'user', timestamp: iso(NOW - 1000), message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: { odd: true } }] } },
  ]);
  assert.deepEqual(t.background, []);
});

test('transcript parsing tolerates missing message bodies, inputs and null result blocks', () => {
  const t = summarize([
    { type: 'user', message: { content: 'go' }, timestamp: iso(NOW - 5000) },
    { type: 'assistant', timestamp: iso(NOW - 4000) }, // no message
    { type: 'assistant', timestamp: iso(NOW - 3000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'Agent' }] } }, // no input
    { type: 'user', timestamp: iso(NOW - 2000), message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [null, { type: 'text', text: 'Async agent launched successfully. agentId: nn1' }] }] } },
  ]);
  assert.deepEqual(t.background.map((b) => b.label), ['Agent: working']);
});

test('on Windows with no LOCALAPPDATA or APPDATA there is nowhere to look', () => {
  assert.deepEqual(defaultSessionDirs({}, 'win32', os.tmpdir()), []);
});

function withFlakyStat(match, fn) {
  const real = fs.statSync;
  fs.statSync = (p, ...rest) => {
    if (match(String(p))) {
      const e = new Error('ENOENT: gone');
      e.code = 'ENOENT';
      throw e;
    }
    return real(p, ...rest);
  };
  try {
    return fn();
  } finally {
    fs.statSync = real;
  }
}

test('files that vanish between listing and reading are skipped quietly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wilfred-edge-'));
  const root = path.join(dir, 'Claude-Data', 'inst', 'claude-code-sessions', 'acct');
  fs.mkdirSync(path.join(root, 'org'), { recursive: true });
  const old = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = dir;
  try {
    // An org folder that disappears while being checked.
    assert.deepEqual(withFlakyStat((p) => p.endsWith(`${path.sep}org`), () => defaultSessionDirs(process.env, 'win32')), []);
  } finally {
    if (old === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = old;
  }

  const sessions = path.join(root, 'org');
  const projects = path.join(dir, 'projects', 'C--repo');
  fs.mkdirSync(projects, { recursive: true });
  const cli = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(sessions, 'local_a.json'), JSON.stringify({ sessionId: 'local_a', cliSessionId: cli, title: 'A', lastActivityAt: Date.now() }));
  fs.writeFileSync(path.join(sessions, 'local_b.json'), JSON.stringify({ sessionId: 'local_b', title: 'B' })); // no lastActivityAt
  fs.writeFileSync(path.join(projects, `${cli}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'go' }, timestamp: new Date().toISOString() }) + '\n');
  const src = new SessionSource({ sessionDirs: [sessions], projectsDir: path.dirname(projects), windowMs: 3600e3, onRows: () => {} });

  // Session file gone after listing: no row, no crash.
  assert.deepEqual(withFlakyStat((p) => p.endsWith('local_a.json'), () => src.read()).map((r) => r.title), ['B']);
  // A session file with no activity time of its own is as fresh as the file.
  const rows = src.read();
  assert.deepEqual(rows.map((r) => r.title).sort(), ['A', 'B']);
  // Transcript gone between finding and reading it.
  src.tailCache.clear();
  assert.equal(withFlakyStat((p) => p.endsWith(`${cli}.jsonl`), () => src.transcript({ cliSessionId: cli })), null);

  // Subagent activity: only .jsonl files count, and a file vanishing mid-listing is skipped.
  assert.equal(src.subagentActivity('99999999-2222-3333-4444-555555555555'), 0);
  const sub = path.join(projects, cli, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), '{}\n');
  fs.writeFileSync(path.join(sub, 'agent-2.jsonl'), '{}\n');
  fs.writeFileSync(path.join(sub, 'notes.txt'), 'x');
  const t2 = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(sub, 'agent-2.jsonl'), t2, t2);
  assert.equal(Math.round(src.subagentActivity(cli)), Math.round(fs.statSync(path.join(sub, 'agent-2.jsonl')).mtimeMs));
  assert.equal(
    Math.round(withFlakyStat((p) => p.endsWith('agent-2.jsonl'), () => src.subagentActivity(cli))),
    Math.round(fs.statSync(path.join(sub, 'agent-1.jsonl')).mtimeMs),
  );

  // A first transcript read that fails has nothing to fall back on.
  const errors = [];
  const fresh = new SessionSource({ sessionDirs: [sessions], projectsDir: path.dirname(projects), windowMs: 3600e3, onRows: () => {}, onError: (e) => errors.push(e) });
  const realOpen = fs.openSync;
  fs.openSync = () => { throw new Error('EBUSY'); };
  try {
    assert.equal(fresh.transcript({ cliSessionId: cli }), null);
  } finally {
    fs.openSync = realOpen;
  }
  assert.equal(errors.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pending tool in a transcript without timestamps counts as held up since the turn began', () => {
  const t = summarize([
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'e', name: 'Edit', input: {} }] } },
  ]);
  assert.ok(Number.isNaN(t.lastAt));
  // With no timestamps, quiet time counts from the turn's start (here the app's turn edge), not 1970.
  assert.equal(sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: NOW - 9000 }, t, NOW).state, 'working');
  const row = sessionStatus({ sessionId: 'local_x', lastTurnEdgeAt: NOW - 9000 }, t, NOW + 120_000);
  assert.equal(row.state, 'needs-you');
  assert.equal(row.since, NOW - 9000);
  assert.match(row.detail, /^No progress for 2 min\./);
});
