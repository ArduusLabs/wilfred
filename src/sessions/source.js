// Watches the Claude desktop app's sessions and reports one status row per recent session.
//
// The app keeps a metadata file per session (title, last focus, last turn edge, the sidebar
// status line) under <app data>\claude-code-sessions\<account>\<org>\. On Windows (Store build)
// that is %LOCALAPPDATA%\Claude-Data\<install>\claude-code-sessions. Each session's live activity
// comes from its Claude Code transcript in ~/.claude/projects. Everything is read-only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTailWindow, summarize } = require('./transcript');
const { sessionStatus, compareRows, foldRuns } = require('./status');

const POLL_MS = 1500;
// A session with no local transcript (new, or run elsewhere) is looked up again this often.
const MISS_RETRY_MS = 30 * 1000;
const SESSIONS = 'claude-code-sessions';

/** Folders the Claude app may keep its data in, per platform. */
function appDataRoots(env, platform, home) {
  if (platform === 'win32') {
    return [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Claude-Data'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Claude'),
      env.APPDATA && path.join(env.APPDATA, 'Claude'),
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return [path.join(support, 'Claude'), path.join(support, 'Claude-Data')];
  }
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(config, 'Claude'), path.join(config, 'Claude-Data')];
}

/**
 * Every <account>/<org> folder of the app's session files. WILFRED_SESSIONS_DIR names the
 * claude-code-sessions folder directly; otherwise it is looked for in the app's data folder,
 * directly inside or one level down (the Windows Store build adds an install folder).
 */
function defaultSessionDirs(env = process.env, platform = process.platform, home = os.homedir()) {
  const bases = [];
  if (env.WILFRED_SESSIONS_DIR) {
    bases.push(env.WILFRED_SESSIONS_DIR);
  } else {
    for (const root of appDataRoots(env, platform, home)) {
      bases.push(path.join(root, SESSIONS));
      for (const install of safeList(root)) bases.push(path.join(root, install, SESSIONS));
    }
  }
  const dirs = [];
  for (const base of bases) {
    for (const account of safeList(base)) {
      for (const org of safeList(path.join(base, account))) {
        const d = path.join(base, account, org);
        if (isDir(d)) dirs.push(d);
      }
    }
  }
  return dirs;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Fields the board relies on, with their types checked, so one odd file can't break a row.
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : undefined);

/** The session that started a side session, when the file names one properly; else null. */
function spawnedFrom(v) {
  if (!isObject(v) || typeof v.sessionId !== 'string' || !v.sessionId || typeof v.title !== 'string') return null;
  return { sessionId: v.sessionId, title: v.title };
}

/** The app's session file as the board needs it, or null when it isn't a session file. */
function cleanMeta(raw, fileMtimeMs) {
  if (!isObject(raw)) return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  const pts = raw.postTurnSummary;
  return {
    ...raw,
    title: str(raw.title),
    cliSessionId: str(raw.cliSessionId),
    cwd: str(raw.cwd),
    originCwd: str(raw.originCwd),
    worktreeName: str(raw.worktreeName),
    permissionMode: str(raw.permissionMode),
    lastAssistantUuid: str(raw.lastAssistantUuid),
    scheduledTaskId: str(raw.scheduledTaskId),
    model: str(raw.model),
    effort: str(raw.effort),
    branch: str(raw.branch),
    worktreePath: str(raw.worktreePath),
    completedTurns: finite(raw.completedTurns),
    spawnedFrom: spawnedFrom(raw.spawnedFrom),
    isStarred: raw.isStarred === true,
    isArchived: raw.isArchived === true,
    // A session file without its own activity time is as fresh as the file itself.
    lastActivityAt: finite(raw.lastActivityAt) ?? fileMtimeMs,
    lastTurnEdgeAt: finite(raw.lastTurnEdgeAt),
    createdAt: finite(raw.createdAt),
    latestUserFrameAt: finite(raw.latestUserFrameAt),
    transcriptUnavailable: raw.transcriptUnavailable === true,
    lastFocusedAt: finite(raw.lastFocusedAt),
    postTurnSummary: isObject(pts)
      ? {
        status_category: str(pts.status_category),
        status_detail: str(pts.status_detail),
        needs_action: str(pts.needs_action),
        summarizes_uuid: str(pts.summarizes_uuid),
      }
      : null,
  };
}

// How many subagent files to re-check each tick when their folder hasn't changed, and how often
// to look at all of them anyway (one that went quiet may have started writing again).
const SUBAGENT_RECENT = 5;
const SUBAGENT_RELIST_MS = 30 * 1000;
// Room kept before the latest turn start when choosing the next read window.
const WINDOW_SLACK = 64 * 1024;
// For this long after a session is created, its missing transcript is looked for every tick.
const NEW_SESSION_LOOKUP_MS = 2 * 60 * 1000;
// How far back the first read of a transcript looks.
const MAX_FIRST_READ = 4 * 1024 * 1024;
// A transcript that failed to read (locked, malformed) is tried again this long after, not every tick.
const FAILED_RETRY_MS = 10 * 1000;

class SessionSource {
  /**
   * @param {{sessionDirs?: string[], projectsDir?: string, windowMs: number,
   *   onRows: (rows: object[]) => void, onError?: (e: Error) => void, now?: () => number,
   *   pollMs?: number, sleeps?: () => {from: number, to: number}[]}} opts
   *   sleeps: the computer's recent sleeps (time asleep isn't time a tool was quiet)
   */
  constructor({ sessionDirs, projectsDir, windowMs, onRows, onError = () => {}, now = Date.now, pollMs = POLL_MS, sleeps = () => [] }) {
    this.sessionDirs = sessionDirs || null;
    // Claude Code keeps its data in CLAUDE_CONFIG_DIR when that is set, else ~/.claude.
    this.projectsDir = projectsDir || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    this.windowMs = windowMs;
    this.onRows = onRows;
    this.onError = onError;
    this.now = now;
    this.pollMs = pollMs;
    this.sleeps = sleeps;
    this.metaCache = new Map(); // file -> {mtimeMs, size, meta}
    this.tailCache = new Map(); // transcript -> {size, mtimeMs, summary, window, failed}
    this.transcriptPath = new Map(); // cliSessionId -> path
    this.missedAt = new Map(); // cliSessionId -> when a search last found nothing
    this.subagents = new Map(); // subagents folder -> {dirMtimeMs, files: Map name -> mtimeMs}
    this.projectList = null; // the projects folder's entries, listed at most once per read
    this.reading = false;
    this.lastJson = '';
    this.timer = null;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    try {
      const rows = this.read();
      // Times in the rows move every tick; only push when something visible changed.
      const json = JSON.stringify(rows.map(({ lastActivityAt, ...r }) => r));
      if (json !== this.lastJson) {
        this.lastJson = json;
        this.onRows(rows);
      }
    } catch (e) {
      this.onError(e);
    }
  }

  read() {
    const now = this.now();
    const rows = [];
    const seenFiles = new Set();
    this.projectList = null;
    this.reading = true;
    try {
      this.scan(now, this.sleeps(), rows, seenFiles);
    } finally {
      this.reading = false;
      this.projectList = null;
    }
    for (const f of this.metaCache.keys()) if (!seenFiles.has(f)) this.metaCache.delete(f);
    // Forget transcripts of sessions no longer in view.
    const live = new Set([...this.metaCache.values()].map((m) => m.meta && m.meta.cliSessionId));
    for (const [id, p] of this.transcriptPath) {
      if (live.has(id)) continue;
      this.transcriptPath.delete(id);
      this.tailCache.delete(p);
      this.subagents.delete(this.subagentDir(p, id));
    }
    for (const id of this.missedAt.keys()) if (!live.has(id)) this.missedAt.delete(id);
    // The same session can appear in two account folders (a copied profile); keep its latest file.
    const byId = new Map();
    for (const r of rows) {
      const prev = byId.get(r.id);
      if (!prev || r.lastActivityAt > prev.lastActivityAt) byId.set(r.id, r);
    }
    // Runs of one scheduled routine fold into one row.
    return foldRuns([...byId.values()]).sort(compareRows);
  }

  /** One row per recent, unarchived session file, added to `rows`. */
  scan(now, sleeps, rows, seenFiles) {
    for (const dir of this.sessionDirs || defaultSessionDirs()) {
      for (const name of safeList(dir)) {
        if (!/^local_[A-Za-z0-9-]+\.json$/.test(name)) continue;
        const file = path.join(dir, name);
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        // The app touches the file on every activity, so mtime filters out old sessions cheaply.
        if (now - st.mtimeMs > this.windowMs) continue;
        seenFiles.add(file);
        const meta = this.meta(file, st);
        if (!meta || meta.isArchived) continue;
        if (now - meta.lastActivityAt > this.windowMs) continue;
        try {
          const t = this.transcript(meta);
          // Subagents write to their own files; while the main transcript waits on them, they show the work.
          const activityAt = t && !t.turnEnded ? this.subagentActivity(meta.cliSessionId) : 0;
          rows.push(sessionStatus(meta, t, now, { activityAt, sleeps }));
        } catch (e) {
          // Something unforeseen in one session costs that session's row, not the whole board.
          this.onError(e);
        }
      }
    }
  }

  meta(file, st) {
    const hit = this.metaCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.meta;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch {
      // Caught mid-write: use the last good copy, the next tick reads it again.
      return hit ? hit.meta : null;
    }
    const meta = cleanMeta(raw, st.mtimeMs);
    this.metaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  }

  /** The transcript's path, searched for again every tick while `eager` (a brand-new session). */
  findTranscript(cliSessionId, eager = false) {
    if (!cliSessionId || !/^[0-9a-f-]{36}$/i.test(cliSessionId)) return null;
    const known = this.transcriptPath.get(cliSessionId);
    if (known && fs.existsSync(known)) return known;
    const missed = this.missedAt.get(cliSessionId);
    const sinceMiss = missed === undefined ? Infinity : this.now() - missed;
    // A negative gap means the clock went back; look again rather than wait it out.
    if (!eager && sinceMiss >= 0 && sinceMiss < MISS_RETRY_MS) return null;
    // One listing serves every search within a read; a search on its own lists afresh.
    const list = this.projectList || safeList(this.projectsDir);
    if (this.reading) this.projectList = list;
    for (const d of list) {
      const p = path.join(this.projectsDir, d, `${cliSessionId}.jsonl`);
      if (fs.existsSync(p)) {
        this.transcriptPath.set(cliSessionId, p);
        this.missedAt.delete(cliSessionId);
        return p;
      }
    }
    this.missedAt.set(cliSessionId, this.now());
    return null;
  }

  subagentDir(transcriptPath, cliSessionId) {
    return path.join(path.dirname(transcriptPath), cliSessionId, 'subagents');
  }

  /**
   * Latest write time of the session's subagent transcripts (<project>/<id>/subagents/*.jsonl), or 0.
   * A long session can have hundreds; only the few most recently active are re-checked each tick,
   * and the folder is listed again only when files are added or removed.
   */
  subagentActivity(cliSessionId) {
    const main = this.transcriptPath.get(cliSessionId);
    if (!main) return 0;
    const dir = this.subagentDir(main, cliSessionId);
    let dirMtimeMs;
    try {
      dirMtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      this.subagents.delete(dir);
      return 0;
    }
    let entry = this.subagents.get(dir);
    let names;
    if (!entry || entry.dirMtimeMs !== dirMtimeMs) {
      entry = { dirMtimeMs, files: new Map(), listedAt: this.now() };
      this.subagents.set(dir, entry);
      names = safeList(dir).filter((n) => n.endsWith('.jsonl'));
    } else if (Math.abs(this.now() - entry.listedAt) >= SUBAGENT_RELIST_MS) {
      entry.listedAt = this.now();
      names = [...entry.files.keys()];
    } else {
      names = [...entry.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, SUBAGENT_RECENT).map(([n]) => n);
    }
    for (const name of names) {
      try {
        entry.files.set(name, fs.statSync(path.join(dir, name)).mtimeMs);
      } catch {
        entry.files.delete(name); // removed while listing
      }
    }
    let latest = 0;
    for (const m of entry.files.values()) latest = Math.max(latest, m);
    return latest;
  }

  transcript(meta) {
    // A new session's transcript appears seconds after its session file: keep looking every tick.
    const young = meta.createdAt !== undefined && Math.abs(this.now() - meta.createdAt) < NEW_SESSION_LOOKUP_MS;
    const file = this.findTranscript(meta.cliSessionId, young);
    if (!file) return null;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null; // deleted between finding and reading it
    }
    if (!st.isFile()) return null;
    const hit = this.tailCache.get(file);
    // Unchanged since a good read: nothing new. After a failed read, wait a little before retrying,
    // so a locked or malformed file isn't re-read (and re-reported) every tick.
    if (hit && !hit.failed && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.summary;
    if (hit && hit.failed && this.now() - hit.failedAt < FAILED_RETRY_MS && this.now() >= hit.failedAt) return hit.summary;
    try {
      // Start from the window that last held the whole turn, grown by what was appended since,
      // so a long turn is read once rather than in ever-larger passes. The first read of a file
      // looks as far back as allowed, to find background work started long before.
      const grown = hit && hit.window && st.size >= hit.size;
      const startBytes = grown ? hit.window + (st.size - hit.size) : hit ? undefined : MAX_FIRST_READ;
      const { records, turnBytes } = readTailWindow(file, st.size, startBytes);
      const summary = summarize(records);
      // Background work started before this window is still running unless the window says it ended.
      if (grown && hit.summary) {
        const ended = new Set(summary.finished);
        const known = new Set(summary.background.map((b) => b.id));
        const carried = hit.summary.background.filter((b) => !ended.has(b.id) && !known.has(b.id));
        // A task carried from before this window that ends here reports back like any other.
        for (const b of hit.summary.background) {
          const at = summary.finishedAt[b.id];
          if (at && summary.turnEnded && !(summary.wokeAt >= at)) summary.wokeAt = at;
        }
        summary.background = [...carried, ...summary.background];
        // Usage is written between turns, so a window holding one long turn may have none: the
        // last one seen still holds.
        if (!summary.cost) summary.cost = hit.summary.cost;
      }
      // Next time, read just the current turn (plus some room), so the window shrinks again
      // once a long turn is over.
      this.tailCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, summary, window: turnBytes + WINDOW_SLACK });
      return summary;
    } catch (e) {
      this.onError(e);
      const summary = hit ? hit.summary : null;
      this.tailCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, summary, window: hit ? hit.window : 0, failed: true, failedAt: this.now() });
      return summary;
    }
  }
}

module.exports = { SessionSource, defaultSessionDirs, appDataRoots, cleanMeta };
