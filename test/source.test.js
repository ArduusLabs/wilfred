const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionSource, defaultSessionDirs, cleanMeta } = require('../src/sessions/source');

const CLI = '0a1b2c3d-1111-4222-8333-944455556666';
const CLI2 = '0a1b2c3d-2222-4333-8444-955566667777';

// A Claude-Data tree and a ~/.claude/projects tree, laid out like the real ones.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wilfred-src-'));
  const sessions = path.join(dir, 'Claude-Data', 'claude_abc', 'claude-code-sessions', 'acct', 'org');
  const projects = path.join(dir, 'projects');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(projects, 'C--repo'), { recursive: true });
  const now = Date.now();
  const writeMeta = (name, meta) => fs.writeFileSync(path.join(sessions, name), JSON.stringify(meta));
  const writeTranscript = (cli, records) =>
    fs.writeFileSync(path.join(projects, 'C--repo', `${cli}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, sessions, projects, now, writeMeta, writeTranscript, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ts = (ms) => new Date(ms).toISOString();

test('defaultSessionDirs finds every account/org folder under Claude-Data', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.dir, 'Claude-Data', 'claude_abc', 'claude-code-sessions', 'acct', 'org2'));
  fs.writeFileSync(path.join(f.dir, 'Claude-Data', 'claude_abc', 'claude-code-sessions', 'acct', 'not-a-dir.json'), '{}');
  const old = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = f.dir;
  try {
    assert.deepEqual(defaultSessionDirs(process.env, 'win32').map((d) => path.basename(d)).sort(), ['org', 'org2']);
    process.env.LOCALAPPDATA = path.join(f.dir, 'missing');
    assert.deepEqual(defaultSessionDirs(process.env, 'win32'), []);
  } finally {
    if (old === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = old;
    f.cleanup();
  }
});

test('read builds a row per recent, unarchived session, with live activity from its transcript', () => {
  const f = fixture();
  const n = f.now;
  f.writeMeta('local_aaa.json', {
    sessionId: 'local_aaa', cliSessionId: CLI, title: 'Busy one', cwd: 'C:\\repo', lastActivityAt: n - 1000, lastTurnEdgeAt: n - 60_000, lastFocusedAt: n,
  });
  f.writeTranscript(CLI, [
    { type: 'user', timestamp: ts(n - 5000), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(n - 4000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { description: 'Build it' } }] } },
  ]);
  f.writeMeta('local_bbb.json', { sessionId: 'local_bbb', cliSessionId: CLI2, title: 'No transcript', lastActivityAt: n - 2000, lastTurnEdgeAt: n - 2000, lastFocusedAt: 0 });
  f.writeMeta('local_arch.json', { sessionId: 'local_arch', title: 'Archived', isArchived: true, lastActivityAt: n });
  f.writeMeta('local_stale.json', { sessionId: 'local_stale', title: 'Stale activity', lastActivityAt: n - 48 * 3600e3 });
  f.writeMeta('local_noid.json', { title: 'No id', lastActivityAt: n });
  f.writeMeta('other.json', { sessionId: 'local_ignored', lastActivityAt: n });
  f.writeMeta('local_bad.json', {});
  fs.writeFileSync(path.join(f.sessions, 'local_bad.json'), '{ broken');
  // An old file by mtime is skipped without being opened.
  f.writeMeta('local_old.json', { sessionId: 'local_old', title: 'Old', lastActivityAt: n });
  const old = new Date(n - 48 * 3600e3);
  fs.utimesSync(path.join(f.sessions, 'local_old.json'), old, old);

  const src = new SessionSource({ sessionDirs: [f.sessions, path.join(f.dir, 'missing')], projectsDir: f.projects, windowMs: 12 * 3600e3, onRows: () => {} });
  const rows = src.read();
  assert.deepEqual(rows.map((r) => [r.title, r.state]), [['Busy one', 'working'], ['No transcript', 'new']]);
  assert.equal(rows[0].headline, 'Running: Build it');
  assert.equal(rows[0].project, 'repo');
  f.cleanup();
});

test('caches: unchanged files are not re-read, a half-written file falls back to the last good copy', () => {
  const f = fixture();
  const n = f.now;
  const metaFile = path.join(f.sessions, 'local_aaa.json');
  f.writeMeta('local_aaa.json', { sessionId: 'local_aaa', cliSessionId: CLI, title: 'First', lastActivityAt: n, lastTurnEdgeAt: n, lastFocusedAt: n });
  f.writeTranscript(CLI, [{ type: 'user', timestamp: ts(n), message: { content: 'go' } }]);
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {} });
  assert.equal(src.read()[0].title, 'First');

  const reads = [];
  const realRead = fs.readFileSync;
  fs.readFileSync = (...a) => { reads.push(String(a[0])); return realRead(...a); };
  try {
    src.read();
  } finally {
    fs.readFileSync = realRead;
  }
  assert.deepEqual(reads, [], 'nothing re-read when nothing changed');

  fs.writeFileSync(metaFile, '{"sessionId": "local_aaa", "tit'); // the app is mid-write
  assert.equal(src.read()[0].title, 'First');

  // The transcript path is remembered, and found again after it moves.
  assert.ok(src.transcriptPath.get(CLI));
  fs.mkdirSync(path.join(f.projects, 'C--moved'));
  fs.renameSync(path.join(f.projects, 'C--repo', `${CLI}.jsonl`), path.join(f.projects, 'C--moved', `${CLI}.jsonl`));
  fs.writeFileSync(metaFile, JSON.stringify({ sessionId: 'local_aaa', cliSessionId: CLI, title: 'Second', lastActivityAt: n, lastTurnEdgeAt: n, lastFocusedAt: n }));
  const row = src.read()[0];
  assert.equal(row.title, 'Second');
  assert.equal(row.state, 'working');
  assert.match(src.transcriptPath.get(CLI), /C--moved/);

  // A session file that disappears leaves the cache.
  fs.rmSync(metaFile);
  assert.deepEqual(src.read(), []);
  assert.equal(src.metaCache.size, 0);
  f.cleanup();
});

test('a broken first read of a session file yields no row rather than a crash', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.sessions, 'local_x.json'), 'nope');
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {} });
  assert.deepEqual(src.read(), []);
  f.cleanup();
});

test('findTranscript rejects ids that are not uuids', () => {
  const f = fixture();
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {} });
  assert.equal(src.findTranscript('../../etc/passwd'), null);
  assert.equal(src.findTranscript(undefined), null);
  assert.equal(src.findTranscript(CLI), null);
  f.cleanup();
});

test('transcript read errors are reported and the last good summary is kept', () => {
  const f = fixture();
  const n = f.now;
  f.writeTranscript(CLI, [{ type: 'user', timestamp: ts(n), message: { content: 'go' } }]);
  const errors = [];
  let clock = n;
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {}, onError: (e) => errors.push(e.message), now: () => clock });
  const meta = { cliSessionId: CLI };
  const good = src.transcript(meta);
  assert.equal(good.turnEnded, false);
  // The file grows but is locked while we read it.
  const file = src.transcriptPath.get(CLI);
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: ts(n + 1), message: { stop_reason: 'end_turn', content: [] } }) + '\n');
  const realOpen = fs.openSync;
  fs.openSync = () => { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; };
  try {
    assert.equal(src.transcript(meta), good);
  } finally {
    fs.openSync = realOpen;
  }
  assert.deepEqual(errors, ['EBUSY: resource busy or locked']);
  // Not retried (or re-reported) on every tick...
  assert.equal(src.transcript(meta), good);
  assert.equal(errors.length, 1);
  // ...but a little later, and once readable again the new state shows.
  clock += 11_000;
  assert.equal(src.transcript(meta).turnEnded, true);
  // Something other than a file in its place: ignored.
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(src.transcript(meta), null);
  // Gone entirely: no summary.
  fs.rmSync(file, { recursive: true });
  assert.equal(src.transcript(meta), null);
  f.cleanup();
});

test('tick pushes rows only when something visible changed, and reports errors', () => {
  const f = fixture();
  let clock = f.now;
  f.writeMeta('local_aaa.json', { sessionId: 'local_aaa', title: 'One', lastActivityAt: clock, lastTurnEdgeAt: clock, lastFocusedAt: clock });
  const pushed = [];
  const errors = [];
  const src = new SessionSource({
    sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, now: () => clock,
    onRows: (rows) => pushed.push(rows.map((r) => r.title)), onError: (e) => errors.push(e),
  });
  src.tick();
  src.tick();
  assert.deepEqual(pushed, [['One']]);
  f.writeMeta('local_bbb.json', { sessionId: 'local_bbb', title: 'Two', lastActivityAt: clock + 1, lastTurnEdgeAt: clock, lastFocusedAt: clock });
  src.tick();
  assert.deepEqual(pushed[1].sort(), ['One', 'Two']);

  src.read = () => { throw new Error('boom'); };
  src.tick();
  assert.equal(errors[0].message, 'boom');
  f.cleanup();
});

test('start polls until stop', (t) => {
  // Mocked timers: a busy machine must not change how often the source polled.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  let reads = 0;
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {}, pollMs: 20 });
  src.read = () => { reads++; return []; };
  src.start();
  assert.equal(reads, 1, 'reads once at start');
  t.mock.timers.tick(60);
  assert.equal(reads, 4, 'then once per poll interval');
  src.stop();
  t.mock.timers.tick(60);
  assert.equal(reads, 4, 'nothing after stop');
  f.cleanup();
});

test('default options: real paths and a working clock', () => {
  const src = new SessionSource({ windowMs: 1, onRows: () => {} });
  assert.equal(src.sessionDirs, null);
  assert.match(src.projectsDir, /[\\/]\.claude[\\/]projects$/);
  assert.ok(Math.abs(src.now() - Date.now()) < 1000);
  src.onError(new Error('ignored by default'));
  assert.ok(Array.isArray(src.read()));
});

test('a missing transcript is searched for again only every 30 s', () => {
  const f = fixture();
  let clock = f.now;
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {}, now: () => clock });
  let listings = 0;
  const realReaddir = fs.readdirSync;
  fs.readdirSync = (...a) => { if (String(a[0]) === f.projects) listings++; return realReaddir(...a); };
  try {
    assert.equal(src.findTranscript(CLI), null);
    assert.equal(src.findTranscript(CLI), null);
    assert.equal(listings, 1);
    // A clock set back still allows a fresh search instead of waiting out the rewind.
    clock -= 3600_000;
    assert.equal(src.findTranscript(CLI), null);
    assert.equal(listings, 2);
    clock += 3600_000;
    f.writeTranscript(CLI, [{ type: 'user', timestamp: ts(clock), message: { content: 'go' } }]);
    clock += 31_000;
    assert.match(src.findTranscript(CLI), /\.jsonl$/);
    assert.equal(listings, 3);
    assert.equal(src.missedAt.has(CLI), false);
  } finally {
    fs.readdirSync = realReaddir;
  }
  // Misses for sessions no longer in view are forgotten.
  src.missedAt.set(CLI2, clock);
  src.read();
  assert.equal(src.missedAt.has(CLI2), false);
  f.cleanup();
});

test('two runs of one scheduled routine give one row: the one most recently active, noting the other waits', () => {
  const f = fixture();
  const run = (name, id, activeAt, extra = {}) => f.writeMeta(name, { sessionId: id, title: 'Daily brief', scheduledTaskId: 'daily', lastActivityAt: activeAt, lastTurnEdgeAt: activeAt, createdAt: activeAt - 60e3, ...extra });
  // The older run, continued by you a moment ago; the newer run asked its question and waits.
  run('local_r1.json', 'local_r1', f.now - 1000, { lastFocusedAt: f.now });
  run('local_r2.json', 'local_r2', f.now - 20e3, { postTurnSummary: { status_category: 'blocked', needs_action: 'Post it?', summarizes_uuid: 'u' }, lastAssistantUuid: 'u', lastFocusedAt: 0 });
  f.writeMeta('local_other.json', { sessionId: 'local_other', title: 'Other', lastActivityAt: f.now - 500, lastTurnEdgeAt: f.now - 500, lastFocusedAt: f.now });
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {} });
  const rows = src.read();
  assert.deepEqual(rows.map((r) => r.id).sort(), ['local_other', 'local_r1']);
  const kept = rows.find((r) => r.id === 'local_r1');
  assert.equal(kept.scheduledTaskId, 'daily');
  assert.match(kept.detail, /^Another run of this routine is waiting for you too\./);
  f.cleanup();
});

test('a session listed in two account folders gives one row, from its most recent file', () => {
  const f = fixture();
  const other = path.join(f.dir, 'Claude-Data', 'claude_abc', 'claude-code-sessions', 'acct2', 'org');
  fs.mkdirSync(other, { recursive: true });
  f.writeMeta('local_dup.json', { sessionId: 'local_dup', title: 'Older copy', lastActivityAt: f.now - 5000, lastTurnEdgeAt: f.now, lastFocusedAt: f.now });
  fs.writeFileSync(path.join(other, 'local_dup.json'), JSON.stringify({ sessionId: 'local_dup', title: 'Newer copy', lastActivityAt: f.now - 1000, lastTurnEdgeAt: f.now, lastFocusedAt: f.now }));
  const src = new SessionSource({ sessionDirs: [f.sessions, other], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {} });
  assert.deepEqual(src.read().map((r) => r.title), ['Newer copy']);
  const reversed = new SessionSource({ sessionDirs: [other, f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {} });
  assert.deepEqual(reversed.read().map((r) => r.title), ['Newer copy']);
  f.cleanup();
});

test('cleanMeta reads what the session runs on, its turns and the session that started it, type-checked', () => {
  const m = cleanMeta({
    sessionId: 'local_a', model: 'claude-opus-5-5', effort: 'max', branch: 'claude/foo-1a2b', worktreePath: 'C:\\Users\\me\\wt',
    completedTurns: 496, isStarred: true, spawnedFrom: { sessionId: 'local_p', taskId: 't1', title: 'Prep the cutover', name: 'x' },
  }, 1);
  assert.equal(m.model, 'claude-opus-5-5');
  assert.equal(m.effort, 'max');
  assert.equal(m.branch, 'claude/foo-1a2b');
  assert.equal(m.worktreePath, 'C:\\Users\\me\\wt');
  assert.equal(m.completedTurns, 496);
  assert.equal(m.isStarred, true);
  // Only what the board uses of the parent is kept.
  assert.deepEqual(m.spawnedFrom, { sessionId: 'local_p', title: 'Prep the cutover' });
  const junk = cleanMeta({
    sessionId: 'local_a', model: 5, effort: {}, branch: null, worktreePath: [], completedTurns: '496', isStarred: 'yes', spawnedFrom: 'local_p',
  }, 1);
  assert.deepEqual([junk.model, junk.effort, junk.branch, junk.worktreePath, junk.completedTurns], [undefined, undefined, undefined, undefined, undefined]);
  assert.equal(junk.isStarred, false, 'a star is only a real true');
  assert.equal(junk.spawnedFrom, null);
  // A parent without a usable id or title is no parent.
  for (const spawnedFrom of [[], { title: 'x' }, { sessionId: '', title: 'x' }, { sessionId: 'local_p' }, { sessionId: 'local_p', title: 5 }]) {
    assert.equal(cleanMeta({ sessionId: 'local_a', spawnedFrom }, 1).spawnedFrom, null, JSON.stringify(spawnedFrom));
  }
  assert.equal(cleanMeta({ sessionId: 'local_a', completedTurns: NaN }, 1).completedTurns, undefined);
});

test('usage read before a long turn still shows once the window no longer holds it', () => {
  const f = fixture();
  const n = f.now;
  const cost = (usd) => ({ type: 'cost-state', totalCostUSD: usd, totalLinesAdded: 3, totalLinesRemoved: 1, modelUsage: { m: { inputTokens: 10, outputTokens: 5 } } });
  // The usage record, then enough output that the next turn's window starts after it.
  f.writeTranscript(CLI, [
    cost(2.5),
    { type: 'progress', pad: 'p'.repeat(700 * 1024) },
    { type: 'user', timestamp: ts(n - 3000), message: { content: 'go' } },
    { type: 'assistant', timestamp: ts(n - 2000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]);
  const src = new SessionSource({ sessionDirs: [f.sessions], projectsDir: f.projects, windowMs: 3600e3, onRows: () => {}, now: () => n });
  const meta = { cliSessionId: CLI };
  assert.equal(src.transcript(meta).cost.usd, 2.5);
  const file = src.transcriptPath.get(CLI);
  const append = (records) => fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  append([{ type: 'user', timestamp: ts(n - 1000), message: { content: 'again' } }]);
  const grown = src.transcript(meta);
  assert.equal(grown.lastPrompt, 'again');
  assert.deepEqual(grown.cost, { usd: 2.5, tokens: 15, linesAdded: 3, linesRemoved: 1, models: ['m'] }, 'carried from the last read');
  // A newer record in the window wins over the carried one.
  append([cost(4)]);
  assert.equal(src.transcript(meta).cost.usd, 4);
  f.cleanup();
});
