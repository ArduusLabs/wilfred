// Which notifications to raise as the board changes. Pure decisions: main turns each notice into
// the operating system's own notification (and shows none while do not disturb is on).

const { clip } = require('./sessions/transcript');

const MIN = 60 * 1000;
/** Off until you switch them on; then what you are told about, unless you change it in Settings. */
const DEFAULT_NOTIFY = { on: false, needs: true, failed: true, done: false, long: false, longMinutes: 20, text: true, sound: true };
/** A question or a result waits this long before it's told: answered or seen sooner, you were there. */
const GRACE_MS = 30 * 1000;
// More notices than this at once (a restart of the app, a burst of finishes) become one summary.
const MAX_SEPARATE = 3;
const BODY_MAX = 180;
const PLAIN = { needs: 'Needs you', failed: 'Failed', done: 'Done' };

class Notifier {
  /**
   * @param {typeof DEFAULT_NOTIFY} [opts]
   * @param {{now?: () => number}} [deps]
   */
  constructor(opts = DEFAULT_NOTIFY, { now = Date.now } = {}) {
    this.setOptions(opts);
    this.now = now;
    this.prev = null; // id -> state at the last observe; null until the first
    this.askedFor = new Map(); // id -> headline of the last needs notice
    this.longFor = new Map(); // id -> the `since` a long notice was raised for
    this.waiting = new Map(); // id -> {kind, headline, since}: a notice in its grace period
  }

  setOptions(opts) {
    this.opts = { ...DEFAULT_NOTIFY, ...opts };
  }

  /**
   * The notices for what changed since the last call. `rows` are the rows as shown (snoozed ones
   * never notify); `watch` is the session you are watching, which is always told about. Call it
   * every few seconds, not only on a change: a question is told once it has waited its grace.
   * @returns {{id: string, kind: string, title: string, body: string}[]}
   */
  observe(rows, now = this.now(), { watch = '' } = {}) {
    const prev = this.prev;
    this.prev = new Map(rows.map((r) => [r.id, r.state]));
    if (!prev) {
      // The board as it was when Wilfred started is not news; nor is work already running long. A
      // question already waiting counts as asked, so waking it by hand later doesn't raise it.
      for (const r of rows) {
        if (this.isLong(r, now)) this.longFor.set(r.id, r.since);
        if (r.state === 'needs-you') this.askedFor.set(r.id, r.headline);
      }
      return [];
    }
    const notices = [];
    for (const r of rows) {
      // A session new to the board (just started, or brought into view) starts its own baseline.
      if (!prev.has(r.id) && r.state === 'needs-you') this.askedFor.set(r.id, r.headline);
      if (r.snoozed || !prev.has(r.id)) {
        // Snoozing a question is seeing it: told or not, waking it by hand stays quiet.
        if (r.snoozed && r.stateWas === 'needs-you') this.askedFor.set(r.id, r.headline);
        this.waiting.delete(r.id);
        continue;
      }
      const kind = this.kindFor(r, prev.get(r.id), now, r.id === watch);
      if (kind) notices.push({ id: r.id, kind, title: r.title || 'Untitled session', body: this.body(kind, r, now) });
    }
    // A session gone from the board takes its waiting notice with it.
    for (const id of this.waiting.keys()) if (!this.prev.has(id)) this.waiting.delete(id);
    // Off, the bookkeeping still runs, so switching on later doesn't replay old news.
    if (!this.opts.on) return [];
    return notices.length > MAX_SEPARATE ? [summary(notices)] : notices;
  }

  /** What, if anything, to tell you about this row now. */
  kindFor(r, was, now, watched) {
    const o = this.opts;
    // A snooze that ran out is a reminder: the question it hid may be told again.
    if (r.woken) this.askedFor.delete(r.id);
    if (r.state !== was) {
      // Whatever was waiting to be told about the old state is moot.
      this.waiting.delete(r.id);
      if (r.state === 'needs-you' && (o.needs || watched) && this.askedFor.get(r.id) !== r.headline) return this.wait(r, 'needs', now);
      if (r.state === 'failed' && (o.failed || watched)) return 'failed';
      if (r.state === 'new' && (o.done || watched)) return this.wait(r, 'done', now);
    } else {
      const w = this.waiting.get(r.id);
      // A question that changed while waiting is a new one, and waits anew; one that held long
      // enough is told, if it is still wanted (a kind switched off meanwhile, or a session no
      // longer watched, is not).
      if (w && w.kind === 'needs' && r.headline !== w.headline) this.wait(r, 'needs', now);
      else if (w && now - w.since >= GRACE_MS) {
        this.waiting.delete(r.id);
        if (!((w.kind === 'needs' ? o.needs : o.done) || watched)) return '';
        if (w.kind === 'needs') this.askedFor.set(r.id, r.headline);
        return w.kind;
      }
    }
    if ((o.long || watched) && this.isLong(r, now) && this.longFor.get(r.id) !== r.since) {
      this.longFor.set(r.id, r.since);
      return 'long';
    }
    return '';
  }

  /** Holds a notice for the grace period; a later look tells it if the row is still so. */
  wait(r, kind, now) {
    this.waiting.set(r.id, { kind, headline: r.headline, since: now });
    return '';
  }

  isLong(r, now) {
    return r.state === 'working' && now - r.since >= this.opts.longMinutes * MIN;
  }

  body(kind, r, now) {
    if (kind === 'long') return `Working for ${Math.floor((now - r.since) / MIN)} min`;
    // A row with nothing to say still says what happened.
    return (this.opts.text && clip(r.headline, BODY_MAX)) || PLAIN[kind];
  }
}

/** One notice standing for many. */
function summary(notices) {
  const n = notices.length;
  const allNeed = notices.every((x) => x.kind === 'needs');
  return { id: '', kind: 'many', title: 'Wilfred', body: allNeed ? `${n} sessions need you` : `${n} sessions changed` };
}

module.exports = { Notifier, DEFAULT_NOTIFY, GRACE_MS };
