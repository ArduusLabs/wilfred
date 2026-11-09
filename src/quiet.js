// Keeping Wilfred quiet: snoozing one session, and do not disturb for all of them. Pure: it never
// touches the clock except through the injected `now`, so every case can be tested.

const MIN = 60 * 1000;
// A snoozed session that drops off the board keeps its snooze this long, in case it comes back.
const GONE_KEEP_MS = 24 * 60 * MIN;
// What current() says of a snooze that ended just now, on its own (not by unsnooze).
const WOKEN = 'woken';

/** What "until it changes" watches: the row's state and what it says. */
function rowKey(row) {
  return `${row.state}|${row.headline}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** A time as the local 24-hour clock shows it, HH:MM. */
function clock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

class Quiet {
  /** @param {{now?: () => number}} [opts] */
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.snoozes = new Map(); // id -> {until (0: until it changes), key, goneAt}
    this.keys = new Map(); // id -> rowKey of the row as last shown
    this.dndUntil = 0;
  }

  /**
   * Snoozes a session: for `minutes` when that is more than 0, else until its row changes from
   * how it looked when you snoozed it.
   */
  snooze(id, minutes) {
    const until = minutes > 0 ? this.now() + minutes * MIN : 0;
    // The row you snoozed is the one last shown; if it hasn't been shown yet, the next one is it.
    this.snoozes.set(id, { until, key: this.keys.get(id) ?? null, goneAt: 0 });
  }

  unsnooze(id) {
    this.snoozes.delete(id);
  }

  /** The session's snooze ({until}, 0 meaning until it changes), or null when it has none. */
  snoozeOf(id, now = this.now()) {
    const s = this.snoozes.get(id);
    if (!s || expired(s, now)) return null;
    return { until: s.until };
  }

  /** Do not disturb: for `minutes` when more than 0, off at 0, until turned off when null/undefined. */
  setDnd(minutes) {
    if (minutes === null || minutes === undefined) this.dndUntil = Infinity;
    else this.dndUntil = minutes > 0 ? this.now() + minutes * MIN : 0;
  }

  dnd(now = this.now()) {
    return now < this.dndUntil;
  }

  /** The line that says do not disturb is on, and until when; '' when it is off. */
  dndLabel(now = this.now()) {
    if (!this.dnd(now)) return '';
    if (this.dndUntil === Infinity) return 'Do not disturb until you turn it off';
    return `Do not disturb until ${clock(this.dndUntil)}`;
  }

  /**
   * The rows as the board should show them: a snoozed row keeps its real state in `stateWas` and is
   * shown idle, after the rest. Snoozes that ran out, or whose row changed, end here, and their row
   * is marked `woken` this once: the end of a snooze is a reminder, so it may notify again.
   */
  apply(rows, now = this.now()) {
    const shown = [];
    const snoozed = [];
    const present = new Set();
    for (const row of rows) {
      present.add(row.id);
      const s = this.current(row, now);
      if (s === WOKEN) {
        shown.push({ ...row, woken: true });
        continue;
      }
      if (!s) {
        shown.push(row);
        continue;
      }
      snoozed.push({ ...row, stateWas: row.state, state: 'idle', snoozed: true, snoozedUntil: s.until });
    }
    this.keys = new Map(rows.map((r) => [r.id, rowKey(r)]));
    this.forgetGone(present, now);
    return [...shown, ...snoozed];
  }

  /** The row's snooze if it still holds; WOKEN when it ran out or the row changed (and it ends). */
  current(row, now) {
    const s = this.snoozes.get(row.id);
    if (!s) return null;
    s.goneAt = 0;
    if (expired(s, now)) {
      this.snoozes.delete(row.id);
      return WOKEN;
    }
    if (s.until === 0) {
      const key = rowKey(row);
      if (s.key === null) s.key = key;
      if (s.key !== key) {
        this.snoozes.delete(row.id);
        return WOKEN;
      }
    }
    return s;
  }

  /** Snoozes of rows not on the board: timed ones still run out, any of them goes after a day away. */
  forgetGone(present, now) {
    for (const [id, s] of this.snoozes) {
      if (present.has(id)) continue;
      if (!s.goneAt) s.goneAt = now;
      if (expired(s, now) || now - s.goneAt >= GONE_KEEP_MS) this.snoozes.delete(id);
    }
  }
}

function expired(s, now) {
  return s.until > 0 && now >= s.until;
}

module.exports = { Quiet, rowKey, clock, GONE_KEEP_MS };
