// The log and the state replayed from it (learn/store.py).
//
// Two kinds of log line: {"type": "round", ...} when a round starts and
// {"type": "answer", ...} per answer. The state is rebuilt by replaying the
// whole log; nothing else is stored.
//
// Each writer keeps its own file: log.jsonl (the laptop's Python) and
// logs/<device>.jsonl (each browser running the app); replay reads them
// merged by time (mergeLogs). A round started by the Python is numbered (7:
// folder r0007, questions r0007-q01); one started in the app is named after
// its device ("k7mq2x-3": folder k7mq2x-3, questions k7mq2x-3-q01).

import { BAD, DEFAULT_MODEL, DUNNO, LUCKY, RIGHT, SCORED, WRONG, recall, update } from './strength.js';
import { dayOf, epoch } from './time.js';
import { compare, pad } from './util.js';

/** The entries of a log.jsonl text: one JSON object per non-blank line,
 * lines split at line feeds only. */
export function readLog(text) {
  const out = [];
  const lines = (text || '').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (exc) {
      throw new Error(`log line ${n + 1}: not JSON (${exc.message})`);
    }
  }
  return out;
}

const LINE_BREAKERS = /[\u0085\u2028\u2029]/g;

/** One log line, byte for byte as the Python writes it (store.log_line):
 * json.dumps with ", " and ": " separators and non-ASCII kept, with U+0085,
 * U+2028 and U+2029 escaped so that an entry always stays on one line. */
export function logLine(entry) {
  const value = (v) => {
    if (Array.isArray(v)) return '[' + v.map(value).join(', ') + ']';
    if (v !== null && typeof v === 'object') {
      return '{' + Object.entries(v).filter(([, x]) => x !== undefined)
        .map(([k, x]) => value(k) + ': ' + value(x)).join(', ') + '}';
    }
    return JSON.stringify(v ?? null).replace(LINE_BREAKERS, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  };
  return value(entry);
}

/** Several logs (lists of entries) as one, in time order. Each log keeps its
 * own order; across logs the earlier instant comes first, and at the same
 * instant the log listed first. An entry without a time keeps its place after
 * the one before it in its own log. */
export function mergeLogs(logs) {
  const keys = logs.map((entries) => {
    let key = -Infinity;
    return entries.map((e) => {
      if (e.ts) key = epoch(e.ts);
      return key;
    });
  });
  const at = logs.map(() => 0);
  const out = [];
  for (;;) {
    let best = -1;
    for (let n = 0; n < logs.length; n++) {
      if (at[n] < logs[n].length && (best < 0 || keys[n][at[n]] < keys[best][at[best]])) best = n;
    }
    if (best < 0) return out;
    out.push(logs[best][at[best]]);
    at[best] += 1;
  }
}

/** A round's name: r0007 for one numbered by the Python, the app's own name
 * ("k7mq2x-3") for one started in the app. Its folder and its questions'
 * ids are made from it. */
export function roundName(number) {
  return typeof number === 'number' ? `r${pad(number, 4)}` : String(number);
}

/** The id of question ``n`` (0-based) of a round. */
export function qid(number, n) {
  return `${roundName(number)}-q${pad(n + 1, 2)}`;
}

/** The units a round line lists as introduced: "units", or (RL's early
 * lines) "chapters" with integers. Units are always strings. */
export function roundUnits(entry) {
  return (entry.units ?? entry.chapters ?? []).map(String);
}

export class State {
  constructor() {
    this.round = 0; // the last round numbered by the Python (app rounds are named, and leave it alone)
    this.units = []; // introduced units, in the order they came in
    this.memory = new Map(); // item -> Memory
    this.seen_on = new Map(); // item -> the last day it was asked (first time, not a repeat)
    this.carry = new Set(); // items owed a fresh question
    this.history = new Map(); // item -> its answer entries
    this.reviews = []; // [predicted recall, right, ts] for every scored answer after a point's first
    this.rounds = new Map(); // round number -> its round line
    this.answered = new Map(); // round number -> Set of qids answered first time
    this.last_ts = null; // when anything was last logged
  }

  mem(item) {
    return this.memory.get(item) ?? null;
  }

  seen(item) {
    return this.memory.has(item);
  }
}

/**
 * Replay a log. A first answer moves memory (unless the question was bad)
 * and marks the point asked that day; a repeat (the same question again after
 * a miss) is never scored. A point is owed a fresh question after a repeat
 * answered right or flagged bad, or a first answer that was lucky or bad;
 * a scored first answer settles what it owed.
 */
export function replay(entries, model = DEFAULT_MODEL) {
  const state = new State();
  for (const entry of entries) {
    if (entry.ts) state.last_ts = entry.ts;
    if (entry.type === 'round') {
      if (Number.isInteger(entry.round)) state.round = Math.max(state.round, entry.round);
      state.rounds.set(entry.round, entry);
      for (const unit of roundUnits(entry)) if (!state.units.includes(unit)) state.units.push(unit);
    } else if (entry.type === 'answer') {
      const { item, outcome } = entry;
      if (!state.history.has(item)) state.history.set(item, []);
      state.history.get(item).push(entry);
      if (entry.repeat) {
        if (outcome === RIGHT || outcome === BAD) state.carry.add(item);
        continue;
      }
      if (!state.answered.has(entry.round)) state.answered.set(entry.round, new Set());
      state.answered.get(entry.round).add(entry.qid);
      state.seen_on.set(item, dayOf(entry.ts));
      if (SCORED.includes(outcome)) {
        const now = epoch(entry.ts);
        if (state.memory.has(item)) state.reviews.push([recall(state.memory.get(item), now), outcome === RIGHT, entry.ts]);
        state.memory.set(item, update(state.mem(item), outcome, now, model));
        state.carry.delete(item);
      }
      if (outcome === BAD) state.carry.add(item);
    }
  }
  return state;
}

/** Outcomes after which a question comes back later in the round: it keeps
 * coming back until answered right (not by luck). The user, 2026-11-24. */
export const AGAIN = [WRONG, DUNNO, LUCKY];

/** The qids of round ``number`` whose repeat is still to come: the latest
 * entry for the question in the round (first answer or repeat) is wrong,
 * don't know or lucky. In the order of their first answers (by time; in the
 * same second, by question number). */
export function pendingRepeats(state, number) {
  const first = new Map();
  const latest = new Map();
  for (const entries of state.history.values()) {
    for (const e of entries) {
      if (e.round !== number) continue;
      latest.set(e.qid, e);
      if (!e.repeat && !first.has(e.qid)) first.set(e.qid, e);
    }
  }
  const pending = [...latest].filter(([, e]) => AGAIN.includes(e.outcome)).map(([q]) => q);
  const answered = (q) => [epoch((first.get(q) ?? latest.get(q)).ts), Number(q.slice(q.lastIndexOf('q') + 1))];
  return pending.sort((a, b) => compare(answered(a), answered(b)));
}

/** inventory.json parsed: id -> Item, in file order. An item names its unit
 * in "unit" or (RL) "chapter"; units are strings. Importance defaults to 2. */
export function loadInventory(data) {
  const rawItems = Array.isArray(data) ? data : data.items;
  const items = new Map();
  rawItems.forEach((it, n) => {
    for (const key of ['id', 'kind', 'title']) {
      if (it[key] === undefined) throw new Error(`inventory item ${n + 1} has no ${key}`);
    }
    items.set(it.id, Object.freeze({
      id: it.id,
      unit: String(it.unit ?? it.chapter),
      section: String(it.section ?? ''),
      kind: it.kind,
      title: it.title,
      importance: it.importance ?? 2,
      raw: it,
      order: n,
    }));
  });
  return items;
}
