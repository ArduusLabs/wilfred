const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarize, describeTool, readTail, applyPlan } = require('../src/sessions/transcript');
const { sessionStatus, compareRows, foldRuns, DEAD_TURN_MS, BACKGROUND_MAX_MS } = require('../src/sessions/status');

test('foldRuns: one row per scheduled routine, the run most recently active, with other waiting runs counted', () => {
  const run = (id, at, extra = {}) => ({ id, title: 'Daily brief', state: 'idle', detail: '', lastActivityAt: at, scheduledTaskId: 'daily', ...extra });
  const plain = { id: 'local_p', title: 'Plain', state: 'working', detail: '', lastActivityAt: 5, scheduledTaskId: '' };
  const a = run('local_a', 10, { state: 'needs-you', detail: 'Post it?' });
  const b = run('local_b', 30, { detail: 'Done.' });
  const c = run('local_c', 20, { state: 'failed' });
  const out = foldRuns([a, plain, b, c]);
  assert.deepEqual(out.map((r) => r.id), ['local_p', 'local_b']);
  assert.equal(out[1].detail, '2 other runs of this routine are waiting for you too.\nDone.');
  assert.equal(b.detail, 'Done.', 'the row itself is left alone');
  // One waiting run, and a kept row with no detail of its own.
  assert.equal(foldRuns([a, run('local_d', 40)])[0].detail, 'Another run of this routine is waiting for you too.');
  // Nothing waiting: the kept row passes through untouched. A tie keeps the first.
  assert.equal(foldRuns([b, run('local_e', 1)])[0], b);
  assert.equal(foldRuns([run('local_t1', 7), run('local_t2', 7)])[0].id, 'local_t1');
  // Another routine is a row of its own.
  assert.equal(foldRuns([a, run('local_f', 50, { scheduledTaskId: 'weekly' })]).length, 2);
  assert.deepEqual(foldRuns([]), []);
  // The row carries which routine it belongs to.
  assert.equal(sessionStatus(meta({ scheduledTaskId: 'daily' }), null, now()).scheduledTaskId, 'daily');
  assert.equal(sessionStatus(meta(), null, now()).scheduledTaskId, '');
});

// Builders for transcript records, in the shape Claude Code writes them.
let clock = Date.parse('2026-10-27T10:00:00Z');
const at = (sec = 1) => new Date((clock += sec * 1000)).toISOString();
const prompt = (text, extra = {}) => ({ type: 'user', timestamp: at(), message: { role: 'user', content: text }, ...extra });
const toolUse = (id, name, input = {}) => ({
  type: 'assistant', timestamp: at(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id, text = 'ok') => ({
  type: 'user', timestamp: at(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const reply = (text = 'done') => ({ type: 'assistant', timestamp: at(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const stopHook = () => ({ type: 'system', subtype: 'stop_hook_summary', timestamp: at() });

const meta = (extra = {}) => ({
  sessionId: 'local_11111111-2222-3333-4444-555555555555',
  title: 'Billing API',
  cwd: 'C:\\Users\\me\\source\\repos\\billing-api',
  lastActivityAt: clock,
  lastTurnEdgeAt: clock,
  lastFocusedAt: clock + 10_000,
  lastAssistantUuid: 'u1',
  ...extra,
});
const now = () => clock + 1000;

test('a running tool shows as working, with its description and the plan step', () => {
  const t = summarize([
    prompt('fix the gate'),
    toolUse('p1', 'mcp__ccd_turn__update_plan', { items: [{ content: 'Look', status: 'in_progress' }, { content: 'Fix', status: 'pending' }] }),
    result('p1'),
    toolUse('p2', 'mcp__ccd_turn__update_plan', { advance: true }),
    result('p2'),
    toolUse('b1', 'Bash', { command: 'pwsh tools/pre-push.ps1', description: 'Run the pre-push gate' }),
  ]);
  assert.equal(t.turnEnded, false);
  const row = sessionStatus(meta(), t, now());
  assert.equal(row.state, 'working');
  assert.equal(row.headline, 'Running: Run the pre-push gate');
  assert.deepEqual(row.step, { index: 2, total: 2, text: 'Fix' });
  assert.equal(row.quiet, false);
});

test('a Bash call silent past its own timeout needs you: probably a permission prompt', () => {
  const t = summarize([prompt('go'), toolUse('b1', 'Bash', { description: 'Delete the old branch' })]);
  // Within its default 2-minute timeout it is just running.
  const running = sessionStatus(meta(), t, t.lastAt + 170_000); // timeout plus grace not yet passed
  assert.equal(running.state, 'working');
  assert.equal(running.quiet, false);
  const row = sessionStatus(meta(), t, t.lastAt + 190_000);
  assert.equal(row.state, 'needs-you');
  assert.equal(row.headline, 'Running: Delete the old branch');
  assert.equal(row.since, t.lastAt);
  assert.equal(row.quiet, true);
  assert.match(row.detail, /No progress for 3 min\. It may be waiting for your permission/);
  // A longer timeout is respected, and bypass mode never prompts.
  const long = summarize([prompt('go'), toolUse('b2', 'Bash', { description: 'Long', timeout: 600000 })]);
  assert.equal(sessionStatus(meta(), long, long.lastAt + 300_000).quiet, false);
  assert.equal(sessionStatus(meta({ permissionMode: 'bypassPermissions' }), t, t.lastAt + 300_000).quiet, false);
});

test('a quick tool after a minute, or a connector after five, needs you; agents never do', () => {
  const edit = summarize([prompt('go'), toolUse('e', 'Edit', { file_path: 'a.js' })]);
  assert.equal(sessionStatus(meta(), edit, edit.lastAt + 30_000).quiet, false);
  assert.equal(sessionStatus(meta(), edit, edit.lastAt + 90_000).state, 'needs-you');
  // Connector tools (browser, Jira, scheduled tasks) get five minutes: most real permission waits are these.
  const browser = summarize([prompt('go'), toolUse('c', 'mcp__Claude_Browser__javascript_tool', {})]);
  assert.equal(sessionStatus(meta(), browser, browser.lastAt + 4 * 60_000).state, 'working');
  const held = sessionStatus(meta(), browser, browser.lastAt + 6 * 60_000);
  assert.equal(held.state, 'needs-you');
  assert.equal(held.headline, 'browser: javascript tool');
  for (const name of ['Agent', 'Task', 'Workflow', 'Skill', 'Monitor']) {
    const t = summarize([prompt('go'), toolUse('x', name, { description: 'long job' })]);
    const row = sessionStatus(meta(), t, t.lastAt + 20 * 60_000);
    assert.equal(row.state, 'working', name);
    assert.equal(row.quiet, false, name);
  }
});

test('a question, plan or permission prompt waiting for hours still needs you', () => {
  const hours = (n) => n * 3600_000;
  const ask = summarize([prompt('x'), toolUse('q', 'AskUserQuestion', { questions: [{ question: 'Ship it?' }] })]);
  const row = sessionStatus(meta(), ask, ask.lastAt + hours(15));
  assert.equal(row.state, 'needs-you');
  assert.equal(row.headline, 'Ship it?');
  const plan = summarize([prompt('x'), toolUse('p', 'ExitPlanMode', {})]);
  assert.equal(sessionStatus(meta(), plan, plan.lastAt + hours(2)).headline, 'Plan ready for your approval');
  const perm = summarize([prompt('x'), toolUse('s', 'mcp__scheduled-tasks__update_scheduled_task', {})]);
  const p = sessionStatus(meta(), perm, perm.lastAt + hours(1));
  assert.equal(p.state, 'needs-you');
  assert.match(p.detail, /No progress for 60 min/);
});

test('a foreground agent writing to its own subagent file keeps the session alive', () => {
  const t = summarize([prompt('go'), toolUse('a', 'Agent', { description: 'Review' })]);
  const later = t.lastAt + DEAD_TURN_MS + 60_000;
  // With no sign of life from the agent either, the turn probably died with the app.
  assert.equal(sessionStatus(meta(), t, later).headline, 'Stopped mid-turn, no activity since');
  const row = sessionStatus(meta(), t, later, { activityAt: later - 5_000 });
  assert.equal(row.state, 'working');
  assert.equal(row.headline, 'Agent: Review');
});

test('an unanswered question needs you and shows the question', () => {
  const t = summarize([
    prompt('which way?'),
    toolUse('q1', 'AskUserQuestion', { questions: [{ question: 'Patch the Tauri app or rebuild in Electron?' }] }),
  ]);
  const row = sessionStatus(meta(), t, now());
  assert.equal(row.state, 'needs-you');
  assert.equal(row.headline, 'Patch the Tauri app or rebuild in Electron?');
});

test('an answered question goes back to working', () => {
  const t = summarize([prompt('x'), toolUse('q1', 'AskUserQuestion', { questions: [{ question: 'A or B?' }] }), result('q1', 'A')]);
  const row = sessionStatus(meta(), t, now());
  assert.equal(row.state, 'working');
  assert.equal(row.headline, 'Thinking…');
});

test('a finished turn with a next-step question needs you; the sidebar status line is the detail', () => {
  const t = summarize([
    prompt('ship it'),
    toolUse('w1', 'mcp__ccd_turn__wrap_up', { recap: 'Gate passed. Nothing pushed yet.', ask: 'Push the branch?' }),
    result('w1'),
    reply(),
    stopHook(),
  ]);
  const row = sessionStatus(
    meta({ postTurnSummary: { status_category: 'review_ready', status_detail: 'gate green; ready to push', summarizes_uuid: 'u1' } }),
    t,
    now(),
  );
  assert.equal(row.state, 'needs-you');
  assert.equal(row.headline, 'Push the branch?');
  assert.equal(row.detail, 'Gate passed. Nothing pushed yet.');
});

test('a finished turn you have not looked at is new; once focused it is idle', () => {
  const t = summarize([prompt('go'), reply(), stopHook()]);
  const pts = { status_category: 'review_ready', status_detail: 'diagram redrawn', summarizes_uuid: 'u1' };
  const unseen = sessionStatus(meta({ postTurnSummary: pts, lastFocusedAt: clock - 60_000 }), t, now());
  assert.equal(unseen.state, 'new');
  assert.equal(unseen.headline, 'diagram redrawn');
  const seen = sessionStatus(meta({ postTurnSummary: pts }), t, now());
  assert.equal(seen.state, 'idle');
});

test('a stale sidebar summary (for an older reply) is not shown', () => {
  const t = summarize([prompt('go'), toolUse('w', 'mcp__ccd_turn__wrap_up', { recap: 'Fresh recap. More.' }), result('w'), reply()]);
  const row = sessionStatus(
    meta({ postTurnSummary: { status_category: 'failed', status_detail: 'old failure', summarizes_uuid: 'older' } }),
    t,
    now(),
  );
  assert.equal(row.state, 'idle');
  assert.equal(row.headline, 'Fresh recap.');
});

test('failed and need_input summaries map to their states', () => {
  const t = summarize([prompt('go'), reply()]);
  const failed = sessionStatus(meta({ postTurnSummary: { status_category: 'failed', status_detail: 'build broke', summarizes_uuid: 'u1' } }), t, now());
  assert.equal(failed.state, 'failed');
  assert.equal(failed.headline, 'build broke');
  const blocked = sessionStatus(
    meta({ postTurnSummary: { status_category: 'need_input', status_detail: 'x', needs_action: 'Approve the PR', summarizes_uuid: 'u1' } }),
    t,
    now(),
  );
  assert.equal(blocked.state, 'needs-you');
  assert.equal(blocked.headline, 'Approve the PR');
});

test('output that merely mentions a background task does not create one', () => {
  const t = summarize([
    prompt('read the test'),
    toolUse('r', 'Read', { file_path: 'sessions.test.js' }),
    result('r', "result('m1', 'Command running in background with ID: bx9.')"),
    toolUse('b', 'Bash', { description: 'grep it' }),
    result('b', 'Command running in background with ID: bx7k2m9q1.'), // a foreground Bash printing another session's log
    reply(),
  ]);
  assert.deepEqual(t.background, []);
  assert.equal(sessionStatus(meta({ lastFocusedAt: 0 }), t, now()).state, 'new');
});

test('background work expires by the clock, even when the session has gone quiet', () => {
  const t = summarize([
    prompt('go'),
    toolUse('m', 'Bash', { description: 'Long watch', run_in_background: true }),
    result('m', 'Command running in background with ID: w1'),
    reply(),
  ]);
  assert.equal(sessionStatus(meta(), t, t.lastAt + 60_000).state, 'working');
  assert.equal(sessionStatus(meta(), t, t.lastAt + BACKGROUND_MAX_MS + 1000).state, 'idle');
});

test('task notifications wake a session without becoming "You asked"', () => {
  const t = summarize([
    prompt('build it'),
    reply(),
    prompt('<task-notification>\n<task-id>bdv5</task-id>\n<status>completed</status>', { origin: { kind: 'task-notification' } }),
    toolUse('b', 'Bash', { description: 'Next step' }),
  ]);
  assert.equal(t.turnEnded, false);
  assert.equal(t.lastPrompt, 'A background task reported back');
  assert.equal(t.promptByYou, false);
  // The reply is about the task that reported back, not your earlier prompt.
  assert.equal(sessionStatus(meta(), t, now()).detail, 'A background task reported back');
});

test('a compaction summary neither starts a turn nor moves time backwards', () => {
  const working = [prompt('go'), toolUse('b', 'Bash', { description: 'Build' })];
  const compact = {
    type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
    timestamp: '2026-10-26T22:59:00Z', message: { content: 'This session is being continued' },
  };
  const t = summarize([...working, compact]);
  assert.equal(t.turnEnded, false);
  assert.equal(t.lastAt, Date.parse(working[1].timestamp));
  // An older timestamp on an ordinary record doesn't move time backwards either.
  const late = summarize([...working, { type: 'system', subtype: 'informational', timestamp: '2026-10-26T10:00:00Z' }]);
  assert.equal(late.lastAt, Date.parse(working[1].timestamp));
});

test('a turn started by a wake-up drops the previous turn question', () => {
  const t = summarize([
    prompt('go'),
    toolUse('w', 'mcp__ccd_turn__wrap_up', { recap: 'Old.', ask: 'Old question?' }),
    result('w'),
    reply(),
    toolUse('b', 'Bash', { description: 'Scheduled work' }), // no prompt: a scheduled wake-up
  ]);
  assert.equal(t.wrapUp, null);
  assert.equal(sessionStatus(meta(), t, now()).state, 'working');
});

test('prompt text loses the markup the app wraps around commands', () => {
  const t = summarize([prompt('<command-name>/code-review</command-name> <command-args>high</command-args>')]);
  assert.equal(t.lastPrompt, '/code-review high');
});

test('messaging a finished agent resumes it in the background until it reports back', () => {
  const resumed = (id) => JSON.stringify({ success: true, message: `Resuming agent ${id.slice(0, 7)}`, resumedAgentId: id });
  const records = [
    prompt('round 3'),
    toolUse('s1', 'SendMessage', { to: 'a1b2c3d4e5f6a7b8c', summary: 'Round 3: confirm runbook fixes' }),
    result('s1', [{ type: 'text', text: resumed('a1b2c3d4e5f6a7b8c') }]),
    toolUse('s2', 'SendMessage', { to: 'x', summary: 'Ping' }),
    result('s2', JSON.stringify({ success: true, message: 'Message queued' })), // a running agent: nothing new
    toolUse('s3', 'SendMessage', { to: 'y', summary: 'Bad' }),
    result('s3', JSON.stringify({ success: true, resumedAgentId: '../x' })),
    reply(),
  ];
  let row = sessionStatus(meta(), summarize(records), now());
  assert.equal(row.state, 'working');
  assert.equal(row.headline, 'In background: Agent: Round 3: confirm runbook fixes');
  records.push({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), content: '<task-notification>\n<task-id>a1b2c3d4e5f6a7b8c</task-id>\n<status>completed</status>' });
  const done = summarize(records);
  // Right after it reports back: reading the result; a minute later with no reply: idle.
  assert.equal(sessionStatus(meta(), done, now()).headline, 'Reading what came back…');
  assert.equal(sessionStatus(meta(), done, done.wokeAt + 61_000).state, 'idle');
});

test('background work keeps an idle session working until its completion arrives', () => {
  const records = [
    prompt('review it'),
    toolUse('a1', 'Agent', { description: 'Review the app' }),
    result('a1', 'Async agent launched successfully.\nagentId: abc123 (internal ID)'),
    toolUse('m1', 'Bash', { description: 'Watch the build', run_in_background: true }),
    result('m1', 'Command running in background with ID: bx9. Output is being written to: x'),
    reply(),
    stopHook(),
  ];
  let row = sessionStatus(meta(), summarize(records), now());
  assert.equal(row.state, 'working');
  assert.equal(row.background, true);
  assert.equal(row.headline, 'In background: Watch the build (+1 more)');

  records.push({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), content: '<task-notification>\n<task-id>bx9</task-id>\n<status>completed</status>' });
  records.push(prompt('<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>'));
  records.push(reply('both done'));
  row = sessionStatus(meta({ lastFocusedAt: 0 }), summarize(records), now());
  assert.equal(row.state, 'new');
});

test('an interrupted turn is idle, not working', () => {
  const t = summarize([prompt('go'), toolUse('b', 'Bash', { description: 'x' }), prompt('[Request interrupted by user for tool use]')]);
  assert.equal(t.turnEnded, true);
  assert.equal(t.interrupted, true);
  const row = sessionStatus(meta(), t, now());
  assert.equal(row.state, 'idle');
  assert.equal(row.headline, 'Stopped by you');
});

test('a message sent mid-turn does not end the turn', () => {
  const t = summarize([prompt('go'), toolUse('b', 'Bash', { description: 'Build' }), prompt('also check the docs'), result('b')]);
  assert.equal(t.turnEnded, false);
  assert.equal(sessionStatus(meta(), t, now()).state, 'working');
});

test('a turn with nothing pending and no activity for long is no longer called working', () => {
  const t = summarize([prompt('go'), toolUse('b', 'Bash', { description: 'x' }), result('b')]);
  assert.equal(sessionStatus(meta(), t, t.lastAt + 60_000).headline, 'Thinking…');
  const row = sessionStatus(meta(), t, t.lastAt + DEAD_TURN_MS + 1000);
  assert.equal(row.state, 'idle');
  assert.equal(row.headline, 'Stopped mid-turn, no activity since');
});

test('a standalone /compact (or /model) does not open a turn', () => {
  const t = summarize([
    prompt('fix it'),
    toolUse('w', 'mcp__ccd_turn__wrap_up', { recap: 'Fixed.', ask: 'Push it?' }),
    result('w'),
    reply(),
    prompt('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
    prompt('<local-command-stdout>Compacted </local-command-stdout>'),
    prompt('<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>'),
  ]);
  assert.equal(t.turnEnded, true);
  const row = sessionStatus(meta({ lastTurnEdgeAt: t.endedAt }), t, now());
  assert.equal(row.state, 'needs-you');
  assert.equal(row.headline, 'Push it?');
});

test('a slash command the model answers (a skill) still starts a turn, named after the command', () => {
  const t = summarize([
    prompt('<command-name>/code-review</command-name> <command-args>high</command-args>'),
    toolUse('b', 'Bash', { description: 'Diff the branch' }),
  ]);
  assert.equal(t.turnEnded, false);
  const row = sessionStatus(meta(), t, now());
  assert.equal(row.headline, 'Running: Diff the branch');
  assert.equal(row.detail, 'You asked: /code-review high');
});

test('a task notification the model never answers does not open a turn', () => {
  const t = summarize([
    prompt('review'),
    reply(),
    prompt('<task-notification>\n<task-id>a2d1</task-id>\n<status>completed</status>', { origin: { kind: 'task-notification' } }),
  ]);
  assert.equal(t.turnEnded, true);
  // A reply normally follows within a minute, so it reads as working until then; after that, new.
  const m = meta({ lastFocusedAt: 0, lastTurnEdgeAt: t.endedAt });
  assert.equal(sessionStatus(m, t, t.wokeAt + 5000).state, 'working');
  assert.equal(sessionStatus(m, t, t.wokeAt + 5000).headline, 'Reading what came back…');
  assert.equal(sessionStatus(m, t, t.wokeAt + 61_000).state, 'new');
});

test('TaskStop clears a background task, which writes no completion of its own', () => {
  const records = [
    prompt('watch the disk'),
    toolUse('m', 'Monitor', { description: 'Disk watcher' }),
    result('m', 'Monitor started (task b4tq8w2nz, timeout 1800000ms).'),
    toolUse('s', 'TaskStop', { task_id: 'b4tq8w2nz' }),
    result('s', 'Stopped'),
    reply(),
  ];
  assert.deepEqual(summarize(records).background, []);
  // A failed stop leaves it running.
  records[4] = { ...result('s', 'No such task'), message: { content: [{ type: 'tool_result', tool_use_id: 's', content: 'No such task', is_error: true }] } };
  assert.equal(summarize(records).background.length, 1);
  // KillShell names it shell_id.
  const k = summarize([
    prompt('x'),
    toolUse('b', 'Bash', { description: 'Serve', run_in_background: true }),
    result('b', 'Command running in background with ID: sh1'),
    toolUse('k', 'KillShell', { shell_id: 'sh1' }),
    result('k', 'killed'),
    reply(),
  ]);
  assert.deepEqual(k.background, []);
});

test('a scheduled task run is named, not shown as something you asked', () => {
  const t = summarize([
    prompt('<scheduled-task name="weekly-dependency-check" file="C:\\Users\\me\\.claude\\scheduled-tasks\\weekly-dependency-check\\SKILL.md">\nRun the check.\n</scheduled-task>'),
    toolUse('b', 'Bash', { description: 'Check capture' }),
  ]);
  assert.equal(t.lastPrompt, 'Scheduled task: weekly-dependency-check');
  assert.equal(sessionStatus(meta(), t, now()).detail, 'Scheduled task: weekly-dependency-check');
  // Long tags are stripped from ordinary prompts too.
  const long = summarize([prompt(`<ide_opened_file path="${'x'.repeat(80)}">see this</ide_opened_file> please`)]);
  assert.equal(long.lastPrompt, 'see this please');
});

test('subagent (sidechain) records do not change the main session state', () => {
  const t = summarize([prompt('go'), reply(), { ...toolUse('s', 'Bash', { description: 'inside agent' }), isSidechain: true }]);
  assert.equal(t.turnEnded, true);
});

test('tool descriptions never show raw commands', () => {
  assert.equal(describeTool('Bash', { command: 'echo secret' }), 'Running a command');
  assert.equal(describeTool('Edit', { file_path: 'C:\\repo\\src\\main.js' }), 'Editing main.js');
  assert.equal(describeTool('mcp__atlassian__getJiraIssue', {}), 'atlassian: getJiraIssue');
  assert.equal(describeTool('WebFetch', { url: 'https://example.com/a?b' }), 'Reading example.com');
  assert.equal(describeTool('ExitPlanMode', {}), 'Plan ready for your approval');
});

test('plan updates: advance, done and start', () => {
  let p = applyPlan(null, { items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' }] });
  p = applyPlan(p, { advance: true });
  assert.deepEqual(p.map((i) => i.status), ['completed', 'in_progress', 'pending']);
  p = applyPlan(p, { done: [2], start: 3 });
  assert.deepEqual(p.map((i) => i.status), ['completed', 'completed', 'in_progress']);
});

test('rows sort by urgency, then by latest activity', () => {
  const rows = [
    { state: 'idle', lastActivityAt: 9 },
    { state: 'working', lastActivityAt: 1 },
    { state: 'needs-you', lastActivityAt: 2 },
    { state: 'working', lastActivityAt: 5 },
  ].sort(compareRows);
  assert.deepEqual(rows.map((r) => `${r.state}:${r.lastActivityAt}`), ['needs-you:2', 'working:5', 'working:1', 'idle:9']);
});

test('starred sessions sort first within their state, never above a more urgent one', () => {
  const rows = [
    { state: 'working', lastActivityAt: 9 },
    { state: 'working', lastActivityAt: 1, starred: true },
    { state: 'idle', lastActivityAt: 8, starred: true },
    { state: 'needs-you', lastActivityAt: 2 },
    { state: 'working', lastActivityAt: 3, starred: true },
  ].sort(compareRows);
  assert.deepEqual(rows.map((r) => `${r.state}:${r.lastActivityAt}${r.starred ? '*' : ''}`), ['needs-you:2', 'working:3*', 'working:1*', 'working:9', 'idle:8*']);
});

test('the row says what the session runs on, where it works, its parent and its usage', () => {
  const cost = { usd: 10.03, tokens: 30417012, linesAdded: 281, linesRemoved: 1, models: ['claude-opus-5-5'] };
  const row = sessionStatus(meta({
    model: 'claude-opus-5-5', effort: 'max', permissionMode: 'auto', branch: 'claude/foo-1a2b', worktreePath: 'C:\\Users\\me\\wt',
    completedTurns: 496, isStarred: true, spawnedFrom: { sessionId: 'local_p', title: 'Prep the cutover' },
  }), { ...summarize([prompt('go'), reply(), stopHook()]), cost }, now());
  assert.deepEqual(
    [row.model, row.effort, row.permissionMode, row.branch, row.folder, row.parentId, row.parentTitle, row.completedTurns, row.starred],
    ['claude-opus-5-5', 'max', 'auto', 'claude/foo-1a2b', 'C:\\Users\\me\\wt', 'local_p', 'Prep the cutover', 496, true],
  );
  assert.equal(row.cost, cost);
  assert.equal(row.context, null, 'no reply with usage in this summary');
  const withContext = sessionStatus(meta({ model: 'claude-opus-4-6' }), { ...summarize([prompt('go'), reply(), stopHook()]), context: { tokens: 150000, model: '' } }, now());
  assert.deepEqual(withContext.context, { tokens: 150000, window: 200000, pct: 75 });
  // Without a worktree the folder is the session's own; without anything, every field has its empty value.
  assert.equal(sessionStatus(meta(), null, now()).folder, 'C:\\Users\\me\\source\\repos\\billing-api');
  const bare = sessionStatus({ sessionId: 'local_x' }, null, now());
  assert.deepEqual(
    [bare.model, bare.effort, bare.permissionMode, bare.branch, bare.folder, bare.parentId, bare.parentTitle, bare.completedTurns, bare.cost],
    ['', '', '', '', '', '', '', 0, null],
  );
  // A summary from before usage was read (or without any) has no cost.
  assert.equal(sessionStatus(meta(), { ...summarize([prompt('go'), reply(), stopHook()]), cost: undefined }, now()).cost, null);
  // A parent named without a title still nests the row.
  assert.deepEqual([sessionStatus(meta({ spawnedFrom: { sessionId: 'local_p', title: '' } }), null, now())].map((r) => [r.parentId, r.parentTitle]), [['local_p', '']]);
});

test('readTail reads only the end of a big file and skips a half-written last line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-tail-'));
  const file = path.join(dir, 't.jsonl');
  const filler = JSON.stringify({ type: 'progress', pad: 'x'.repeat(1000) });
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(filler); // ~2 MB of noise before the turn
  lines.push(JSON.stringify(prompt('latest prompt')), JSON.stringify(toolUse('b', 'Bash', { description: 'Now' })));
  fs.writeFileSync(file, lines.join('\n') + '\n{"type":"assistant","mess');
  const records = readTail(file, fs.statSync(file).size);
  assert.ok(records.length < 600, `read ${records.length} records`);
  const t = summarize(records);
  assert.equal(t.lastPrompt, 'latest prompt');
  assert.equal(t.pending[0].label, 'Running: Now');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a busy background agent does not hide a quick tool stuck on a permission prompt', () => {
  const t = summarize([prompt('go'), toolUse('e', 'Edit', { file_path: 'a.js' })]);
  const later = t.lastAt + 3 * 60_000;
  const row = sessionStatus(meta(), t, later, { activityAt: later - 1000 }); // an agent wrote a second ago
  assert.equal(row.state, 'needs-you');
  assert.equal(row.since, t.lastAt);
});

test('a new prompt does not inherit the previous turn plan step', () => {
  const t = summarize([
    prompt('build'),
    toolUse('p', 'mcp__ccd_turn__update_plan', { items: [{ content: 'Old step', status: 'in_progress' }, { content: 'b', status: 'pending' }] }),
    result('p'),
    prompt('[Request interrupted by user]'),
    prompt('something else'),
    toolUse('b', 'Bash', { description: 'New work' }),
  ]);
  assert.equal(t.plan, null);
  assert.equal(sessionStatus(meta(), t, now()).step, null);
});

test('prompt text keeps your own angle brackets', () => {
  assert.equal(summarize([prompt('why is count < 5 when limit > 3?')]).lastPrompt, 'why is count < 5 when limit > 3?');
  assert.equal(summarize([prompt('fix List<string> parsing')]).lastPrompt, 'fix List<string> parsing');
  assert.equal(summarize([prompt('<system-reminder>x</system-reminder>look')]).lastPrompt, 'look');
});

test('a next-step box with no question outranks the app summary saying the session needs you', () => {
  const pts = { status_category: 'blocked', status_detail: 'design session started', needs_action: 'pick an avatar in the design session', summarizes_uuid: 'u1' };
  const boxed = summarize([prompt('go'), toolUse('w', 'mcp__ccd_turn__wrap_up', { recap: 'Started the design session.' }), result('w'), reply()]);
  const row = sessionStatus(meta({ postTurnSummary: pts, lastFocusedAt: 0 }), boxed, now());
  assert.equal(row.state, 'new');
  assert.equal(row.headline, 'design session started');
  // Without a next-step box the summary still decides: plain-text asks (reconnect the VPN) stay visible.
  const plain = summarize([prompt('go'), reply('Please reconnect the VPN.')]);
  const asked = sessionStatus(meta({ postTurnSummary: { ...pts, needs_action: 'reconnect VPN' } }), plain, now());
  assert.equal(asked.state, 'needs-you');
  assert.equal(asked.headline, 'reconnect VPN');
});


test('an API error ends the turn as failed, saying what went wrong', () => {
  const err = (error) => ({ type: 'assistant', isApiErrorMessage: true, error, timestamp: at(), message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error' }] } });
  for (const [kind, text] of [['rate_limit', 'Stopped: rate limited by the API'], ['authentication_failed', 'Stopped: signed out, sign in again'], ['overloaded_error', 'Stopped: the API is overloaded'], ['server_error', 'Stopped: API error'], [undefined, 'Stopped: API error']]) {
    const t = summarize([prompt('go'), toolUse('b', 'Bash', { description: 'x' }), result('b'), err(kind)]);
    assert.equal(t.turnEnded, true);
    const row = sessionStatus(meta({ lastFocusedAt: 0 }), t, now());
    assert.equal(row.state, 'failed', String(kind));
    assert.equal(row.headline, text);
  }
  // Prompting again after the error starts a fresh turn without it.
  const again = summarize([prompt('go'), err('rate_limit'), prompt('try again'), toolUse('b', 'Bash', { description: 'Retry' })]);
  assert.equal(sessionStatus(meta(), again, now()).state, 'working');
  // An error that is followed by a normal reply is not the turn's outcome.
  const recovered = summarize([prompt('go'), err('server_error'), reply('done after all')]);
  assert.equal(recovered.apiError, null);
});

test('one notice that stops several background tasks ends all of them', () => {
  const launch = (id, task) => [toolUse(id, 'Monitor', { description: `watch ${task}` }), result(id, `Monitor started (task ${task}, timeout 1800000ms).`)];
  const records = [prompt('watch'), ...launch('m1', 'ta1'), ...launch('m2', 'tb2'), ...launch('m3', 'tc3'), reply()];
  assert.equal(summarize(records).background.length, 3);
  records.push({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), content: '<task-notification>\n<task-id>ta1</task-id>\n<task-id>tb2</task-id>\n<task-id>tc3</task-id>\n<status>stopped</status>\n</task-notification>' });
  assert.deepEqual(summarize(records).background, []);
});

test('a Monitor that times out is no longer counted as running', () => {
  const records = [prompt('watch'), toolUse('m', 'Monitor', { description: 'CI' }), result('m', 'Monitor started (task bea08slqi, timeout 3600000ms).'), reply()];
  assert.equal(summarize(records).background.length, 1);
  // An ordinary event from it changes nothing...
  records.push({ type: 'queue-operation', timestamp: at(), content: '<task-notification>\n<task-id>bea08slqi</task-id>\n<event>build 42 passed</event>\n</task-notification>' });
  assert.equal(summarize(records).background.length, 1);
  // ...its time-out ends it.
  records.push({ type: 'queue-operation', timestamp: at(), content: '<task-notification>\n<task-id>bea08slqi</task-id>\n<summary>CI</summary>\n<event>[Monitor timed out — re-arm if needed.]</event>\n</task-notification>' });
  assert.deepEqual(summarize(records).background, []);
});

test('a reply still streaming is not shown as finished', () => {
  const thinking = { type: 'assistant', timestamp: at(), message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '…' }] } };
  const mid = summarize([prompt('go'), thinking]);
  assert.equal(mid.turnEnded, false);
  assert.equal(summarize([prompt('go'), thinking, reply('here it is')]).turnEnded, true);
  // If no text block comes, the stop-hook record ends the turn.
  assert.equal(summarize([prompt('go'), thinking, stopHook()]).turnEnded, true);
});

test('a message from another session is named as such, not as your prompt', () => {
  const t = summarize([
    prompt('start the design session'),
    reply(),
    prompt('[Subagent hand-back] report', { isMeta: true, origin: { kind: 'peer' } }),
    toolUse('c', 'Bash', { description: 'Check its branch' }),
  ]);
  assert.equal(t.turnEnded, false);
  assert.equal(sessionStatus(meta(), t, now()).detail, 'Another session sent a message');
});

test('a manual /compact on a turn that had stopped closes it instead of waking it', () => {
  const dead = [prompt('go'), toolUse('b', 'Bash', { description: 'x' }), result('b')];
  const compact = { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' }, timestamp: at() };
  const t = summarize([...dead, compact]);
  assert.equal(t.turnEnded, true);
  // An automatic compaction mid-turn is just part of the turn.
  const auto = summarize([...dead, { ...compact, compactMetadata: { trigger: 'auto' } }]);
  assert.equal(auto.turnEnded, false);
});

test('waiting on a background task is quiet by design, up to its own timeout', () => {
  const t = summarize([prompt('go'), toolUse('w', 'TaskOutput', { task_id: 'b1', block: true, timeout: 300000 })]);
  assert.equal(sessionStatus(meta(), t, t.lastAt + 200_000).state, 'working');
  assert.equal(sessionStatus(meta(), t, t.lastAt + 380_000).state, 'needs-you');
  const noWait = summarize([prompt('go'), toolUse('w', 'TaskOutput', { task_id: 'b1', block: false })]);
  assert.equal(sessionStatus(meta(), noWait, noWait.lastAt + 90_000).state, 'needs-you');
  const dflt = summarize([prompt('go'), toolUse('w', 'TaskOutput', { task_id: 'b1' })]);
  assert.equal(sessionStatus(meta(), dflt, dflt.lastAt + 500_000).state, 'working');
});


test('an overloaded API (529) is named, and the app resume placeholder keeps a failed turn failed', () => {
  const err529 = { type: 'assistant', isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 529, timestamp: at(), message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error' }] } };
  const t = summarize([prompt('go'), err529]);
  assert.equal(sessionStatus(meta(), t, now()).headline, 'Stopped: the API is overloaded');
  const resumed = summarize([
    prompt('go'), err529,
    prompt('Continue from where you left off.', { isMeta: true }),
    { type: 'assistant', timestamp: at(), message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'No response requested.' }] } },
  ]);
  assert.equal(sessionStatus(meta(), resumed, now()).state, 'failed');
});
