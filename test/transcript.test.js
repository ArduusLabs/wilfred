// Edge cases of the transcript parser that the scenario tests in sessions.test.js don't reach.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarize, describeTool, readTail, applyPlan, clip, costOf } = require('../src/sessions/transcript');

let clock = Date.parse('2026-10-27T09:00:00Z');
const at = () => new Date((clock += 1000)).toISOString();
const user = (content, extra = {}) => ({ type: 'user', timestamp: at(), message: { content }, ...extra });
const assistant = (content, stop = 'tool_use') => ({ type: 'assistant', timestamp: at(), message: { stop_reason: stop, content } });
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const res = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });

test('describeTool covers every tool family', () => {
  const cases = [
    ['Bash', { description: 'Build' }, 'Running: Build'],
    ['PowerShell', {}, 'Running a command'],
    ['Read', { file_path: 'C:\\a\\b\\notes.md' }, 'Reading notes.md'],
    ['Read', {}, 'Reading a file'],
    ['MultiEdit', { file_path: '/x/y.ts' }, 'Editing y.ts'],
    ['Write', { file_path: '/x/dir/' }, 'Writing dir'],
    ['NotebookEdit', { notebook_path: 'n.ipynb' }, 'Editing n.ipynb'],
    ['Grep', { pattern: 'TODO' }, 'Searching for TODO'],
    ['Glob', { pattern: '**/*.js' }, 'Searching for **/*.js'],
    ['Agent', { description: 'Review it' }, 'Agent: Review it'],
    ['Task', { subagent_type: 'Explore' }, 'Agent: Explore'],
    ['Agent', {}, 'Agent: working'],
    ['WebSearch', { query: 'electron zoom' }, 'Searching the web: electron zoom'],
    ['WebFetch', { url: 'not a url' }, 'Reading a web page'],
    ['Skill', { skill: 'code-review' }, 'Using skill code-review'],
    ['Skill', {}, 'Using a skill'],
    ['Workflow', {}, 'Running a workflow'],
    ['Monitor', { description: 'CI run' }, 'Watching: CI run'],
    ['AskUserQuestion', {}, 'Has a question for you'],
    ['AskUserQuestion', { questions: [] }, 'Has a question for you'],
    ['mcp__9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a__batch', {}, 'connector: batch'],
    ['mcp__claude-in-chrome__read_page', {}, 'browser: read page'],
    ['mcp__Claude_Browser__navigate', {}, 'browser: navigate'],
    ['SomethingNew', {}, 'SomethingNew'],
    [undefined, undefined, 'Working'],
  ];
  for (const [name, input, want] of cases) assert.equal(describeTool(name, input), want, `${name}`);
});

test('clip squeezes whitespace and cuts long text with an ellipsis', () => {
  assert.equal(clip('  a \n\n b  '), 'a b');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip(null), '');
});

test('applyPlan ignores progress updates before any plan exists, and odd step numbers', () => {
  assert.equal(applyPlan(null, { advance: true }), null);
  let p = applyPlan(null, { items: [{ content: 'a', status: 'in_progress' }, { status: 'pending' }] });
  assert.deepEqual(p[1], { content: '', status: 'pending' });
  p = applyPlan(p, { done: [9], start: 9 });
  assert.deepEqual(p.map((i) => i.status), ['in_progress', 'pending']);
  p = applyPlan(p, { advance: true });
  p = applyPlan(p, { advance: true }); // past the end: last step completes, nothing new starts
  assert.deepEqual(p.map((i) => i.status), ['completed', 'completed']);
});

test('prompts given as content blocks are read; meta records and odd content are ignored', () => {
  const t = summarize([
    user([{ type: 'text', text: 'first part' }, { type: 'image' }, { type: 'text', text: 'second' }]),
    user('<system-reminder>…', { isMeta: true }),
    { type: 'assistant', timestamp: at(), message: { stop_reason: 'tool_use', content: 'not an array' } },
    { type: 'user', timestamp: at() }, // no message at all
  ]);
  assert.equal(t.lastPrompt, 'first part second');
  assert.equal(t.turnEnded, false);
});

test('a tail that starts mid-turn (no prompt in view) counts as working from the first reply', () => {
  const t = summarize([assistant([use('b', 'Bash', { description: 'x' })])]);
  assert.equal(t.turnEnded, false);
  assert.equal(t.turnStartAt, clock);
  assert.equal(t.pending.length, 1);
});

test('stop_sequence, max_tokens and a turn_duration record all end a turn', () => {
  assert.equal(summarize([user('a'), assistant([], 'stop_sequence')]).turnEnded, true);
  assert.equal(summarize([user('a'), assistant([], 'max_tokens')]).turnEnded, true);
  const t = summarize([user('a'), assistant([use('b', 'Bash')]), { type: 'system', subtype: 'turn_duration', timestamp: at() }]);
  assert.equal(t.turnEnded, true);
  assert.equal(t.pending.length, 0);
  // A stop-hook record after the turn already ended doesn't move its end time.
  const records = [user('a'), assistant([], 'end_turn'), { type: 'system', subtype: 'stop_hook_summary', timestamp: at() }];
  const again = summarize(records);
  assert.equal(again.turnEnded, true);
  assert.equal(again.endedAt, Date.parse(records[1].timestamp));
});

test('records without timestamps do not move the clock', () => {
  const t = summarize([user('a'), { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }]);
  assert.equal(t.turnEnded, true);
  assert.equal(t.lastAt, clock);
});

test('tool results given as content blocks still start background work; results of unknown calls are ignored', () => {
  const t = summarize([
    user('go'),
    assistant([use('a1', 'Agent', { description: 'Write docs' })]),
    user([res('a1', [{ type: 'text', text: 'Async agent launched successfully.\nagentId: zz9' }, { type: 'image' }])]),
    user([res('nope', 'Command running in background with ID: ghost')]),
    user([res('x', { weird: true })]),
    assistant([], 'end_turn'),
  ]);
  assert.deepEqual(t.background.map((b) => b.label), ['Agent: Write docs']);
});

test('background work finishes through a queued attachment, and very old work is dropped', () => {
  const launch = [
    user('go'),
    assistant([use('m', 'Monitor', { description: 'deploy' })]),
    user([res('m', 'Monitor started (task mon1, timeout 1800000ms).')]),
    assistant([], 'end_turn'),
  ];
  assert.equal(summarize(launch).background.length, 1);
  const done = summarize([
    ...launch,
    { type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', prompt: '<task-notification><task-id>mon1</task-id><status>killed</status>' } },
  ]);
  assert.equal(done.background.length, 0);
  const stillOpen = summarize([...launch, { type: 'attachment', timestamp: at(), attachment: {} }, { type: 'queue-operation', operation: 'remove' }]);
  assert.equal(stillOpen.background.length, 1);
  // An interim notification (no final status) keeps it open.
  const interim = summarize([...launch, user('<task-notification><task-id>mon1</task-id><status>running</status>')]);
  assert.equal(interim.background.length, 1);
  assert.equal(interim.background[0].label, 'Watching: deploy');
});

test('readTail widens its window until it finds the prompt that started the turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wilfred-tail-'));
  const file = path.join(dir, 't.jsonl');
  const big = JSON.stringify(assistant([use('r', 'Read', { pad: 'y'.repeat(600 * 1024) })]));
  fs.writeFileSync(file, [JSON.stringify(user('the turn started here')), big, JSON.stringify(user([res('r', 'ok')]))].join('\n') + '\n');
  const t = summarize(readTail(file, fs.statSync(file).size));
  assert.equal(t.lastPrompt, 'the turn started here');
  assert.equal(t.turnEnded, false);

  // With no prompt anywhere it stops at the start of the file (or the 4 MB cap).
  fs.writeFileSync(file, JSON.stringify(assistant([use('b', 'Bash')])) + '\n');
  assert.equal(readTail(file, fs.statSync(file).size).length, 1);
  const huge = path.join(dir, 'h.jsonl');
  const line = JSON.stringify({ type: 'progress', pad: 'z'.repeat(64 * 1024) }) + '\n';
  fs.writeFileSync(huge, line.repeat(100)); // ~6.5 MB, no prompt
  const records = readTail(huge, fs.statSync(huge).size);
  assert.ok(records.length > 0 && records.length <= 64, `read ${records.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A cost-state record as Claude Code writes it: cumulative for the CLI session, with no timestamp.
const costState = (usd, extra = {}) => ({
  type: 'cost-state', totalCostUSD: usd, totalLinesAdded: 281, totalLinesRemoved: 1, totalDuration: 5000,
  modelUsage: { 'claude-opus-5-5': { inputTokens: 2377, outputTokens: 100513, thinkingTokens: 23036, cacheReadInputTokens: 30065123, cacheCreationInputTokens: 249999, costUSD: usd } },
  hasUnknownModelCost: false, ...extra,
});

test('summarize: cost comes from the latest cost-state record, and is null without one', () => {
  assert.equal(summarize([user('a'), assistant([], 'end_turn')]).cost, null);
  const t = summarize([user('a'), costState(4), assistant([], 'end_turn'), costState(10.03)]);
  // Thinking tokens are part of the output already, so they are not added again.
  assert.deepEqual(t.cost, { usd: 10.03, tokens: 2377 + 100513 + 30065123 + 249999, linesAdded: 281, linesRemoved: 1, models: ['claude-opus-5-5'] });
  // It says nothing about the turn: no time, no new turn, no end.
  const records = [user('a'), assistant([use('b', 'Bash')]), costState(1)];
  const working = summarize(records);
  assert.equal(working.turnEnded, false);
  assert.equal(working.lastAt, Date.parse(records[1].timestamp));
  assert.equal(working.cost.usd, 1);
});

test('costOf: a malformed record gives the parts it has, never a throw', () => {
  assert.deepEqual(costOf({}), { usd: 0, tokens: 0, linesAdded: 0, linesRemoved: 0, models: [] });
  assert.deepEqual(costOf({ totalCostUSD: NaN, totalLinesAdded: '5', totalLinesRemoved: Infinity, modelUsage: [{ inputTokens: 9 }] }),
    { usd: 0, tokens: 0, linesAdded: 0, linesRemoved: 0, models: [] });
  assert.deepEqual(costOf({ totalCostUSD: 2, modelUsage: 'lots' }).usd, 2);
  // Models without usage, or with odd counts, add only their real numbers.
  const c = costOf({ modelUsage: { a: null, b: 'x', c: { inputTokens: 5, outputTokens: NaN, cacheReadInputTokens: '7', cacheCreationInputTokens: 1 } } });
  assert.equal(c.tokens, 6);
  assert.deepEqual(c.models, ['a', 'b', 'c']);
});

test('costOf: a negative count is nothing', () => {
  const c = costOf({ totalCostUSD: -1, totalLinesAdded: 4, totalLinesRemoved: -5, modelUsage: { m: { inputTokens: -100, outputTokens: 7 } } });
  assert.deepEqual(c, { usd: 0, tokens: 7, linesAdded: 4, linesRemoved: 0, models: ['m'] });
});

test('the context: the latest reply\'s input and cache tokens, over the model\'s window', () => {
  const { contextUsed, contextWindow, contextOf } = require('../src/sessions/transcript');
  assert.equal(contextUsed({ input_tokens: 32, cache_creation_input_tokens: 4759, cache_read_input_tokens: 332447, output_tokens: 4688 }), 337238);
  assert.equal(contextUsed({ input_tokens: 10 }), 10, 'missing parts count as nothing');
  assert.equal(contextUsed({ input_tokens: -5, cache_read_input_tokens: 'x' }), 0, 'odd parts count as nothing');
  for (const none of [null, undefined, 'usage', {}, { output_tokens: 9 }]) assert.equal(contextUsed(none), null, String(none));
  // The window, per Claude Code's documentation.
  const million = ['claude-fable-5-1', 'claude-mythos-5-1', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-6', 'claude-opus-4-7', 'claude-opus-4-10', 'claude-opus-5-5', 'claude-opus-4-6[1m]', 'us.anthropic.claude-sonnet-5-5-v1', 'CLAUDE-SONNET-4-6[1M]'];
  for (const m of million) assert.equal(contextWindow(m), 1e6, m);
  const standard = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-1', 'claude-3-5-sonnet-20241022', '', undefined, 'gpt-9'];
  for (const m of standard) assert.equal(contextWindow(m), 2e5, String(m));
  // The row's reading: the reply's model wins over the app's; the app's stands in; never above 100.
  assert.deepEqual(contextOf({ tokens: 337238, model: 'claude-fable-5-1' }, 'claude-opus-4-6'), { tokens: 337238, window: 1e6, pct: 34 });
  assert.deepEqual(contextOf({ tokens: 150000, model: '' }, 'claude-opus-4-6'), { tokens: 150000, window: 2e5, pct: 75 });
  assert.deepEqual(contextOf({ tokens: 250000, model: '' }), { tokens: 250000, window: 2e5, pct: 100 });
  assert.equal(contextOf(null, 'claude-opus-4-6'), null);
  // In a transcript: the latest main-conversation reply with usage wins; side chains and replies without usage don't count.
  const withUsage = (model, usage, extra = {}) => ({ type: 'assistant', timestamp: at(), message: { model, usage, stop_reason: 'end_turn', content: [] }, ...extra });
  const t = summarize([
    user('a'), withUsage('claude-opus-4-6', { input_tokens: 100, cache_read_input_tokens: 900 }),
    user('b'), withUsage('claude-fable-5-1', { input_tokens: 5, cache_creation_input_tokens: 15, cache_read_input_tokens: 1980 }),
    withUsage('claude-haiku-5-5', { input_tokens: 999999 }, { isSidechain: true }),
    assistant([], 'end_turn'),
  ]);
  assert.deepEqual(t.context, { tokens: 2000, model: 'claude-fable-5-1' });
  assert.equal(summarize([user('a'), assistant([], 'end_turn')]).context, null);
  assert.equal(summarize([user('a'), withUsage(42, { input_tokens: 7 })]).context.model, '', 'a model that is not a name is no name');
});
