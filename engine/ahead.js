// Questions written ahead and which can still be asked (learn/ahead.py).
//
// A written question has a permanent id, stored in it as `id`: tNNNN-qMM (a
// top-up batch) or rNNNN-qMM (written for a round). One marked `removed` is
// never asked. Its use is read from the log only:
//   fresh   never answered: asked first;
//   spent   answered right first time: never again;
//   retired flagged bad: never again;
//   missed  answered, never right first time: may come back when the point
//           has no fresh question, unless a note was left on it.
// A question also records the statement it was written against; if the
// point's statement or formula has changed since, it is held back. A
// question on a list point is used only if it is select all that apply.

import { isSelect } from './questions.js';
import { sha1Hex } from './sha1.js';
import { qid } from './store.js';
import { epoch } from './time.js';
import { minBy, pad } from './util.js';

export const FRESH = 'fresh';
export const SPENT = 'spent';
export const RETIRED = 'retired';
export const MISSED = 'missed';
export const LEVELS = ['direct', 'applied', 'transfer'];

/** The first 12 hex digits of SHA-1 over statement + "\n" + formula. */
export function hashText(statement, formula) {
  return sha1Hex((statement || '') + '\n' + (formula || '')).slice(0, 12);
}

/** The first 12 hex digits of SHA-1 over a file's text, line ends made LF:
 * what topups/ready.json records for each batch that passed `learn check`
 * (ahead.file_hash). A batch is ready only while its questions file still
 * hashes to that. */
export function fileHash(text) {
  return sha1Hex(text.replace(/\r\n/g, '\n')).slice(0, 12);
}

/** What a question was written against: the point's statement and formula. */
export function statementHash(item) {
  return hashText(item.raw.statement, item.raw.formula);
}

/**
 * Every question that could be asked again: those of top-up batches that
 * passed `learn check --topups`, then those written for rounds that were
 * served (their own, not copies taken from elsewhere).
 *
 * ``topups``: [{number, brief, questions, ready}] (questions null if not yet
 * written). ``rounds``: [{number, brief, questions}] (null when a file is
 * missing). ``state``: the replayed log, which says which rounds were served.
 * A Written is {qid, item, question, level, statement_hash, order}.
 */
export function writtenQuestions({ topups = [], rounds = [], state }) {
  const out = [];
  for (const b of [...topups].sort((x, y) => x.number - y.number)) {
    if (!b.brief || !b.questions || !b.ready) continue;
    const slots = new Map(b.brief.slots.map((s) => [s.item, s]));
    b.questions.questions.forEach((q) => {
      if (q.removed) return;
      const slot = slots.get(q.item) ?? {};
      out.push({
        qid: q.id,
        item: q.item,
        question: q,
        level: slot.level ?? null,
        statement_hash: slot.statement_hash ?? null,
        order: [0, b.number],
      });
    });
  }
  for (const r of [...rounds].sort((x, y) => x.number - y.number)) {
    if (!state.rounds.has(r.number)) continue; // not served yet (a pending round)
    const slots = r.brief?.slots ?? [];
    (r.questions?.questions ?? []).forEach((q, k) => {
      if (q.source || q.todo || q.item === undefined) return; // a copy, or not written
      // The brief's slot says what the question was written against.
      const slot = slots[k]?.item === q.item ? slots[k] : null;
      out.push({
        // Served before ids were stored: its id is its position, which never changed.
        qid: q.id || qid(r.number, k),
        item: q.item,
        question: q,
        level: slot?.level ?? null,
        statement_hash: slot ? hashText(slot.statement, slot.formula) : null,
        order: [1, r.number],
      });
    });
  }
  return out;
}

/** What the log says about each written question, by its permanent id
 * (``source`` for a copy, else the qid). */
export function uses(entries) {
  const out = new Map();
  for (const e of entries) {
    if (e.type !== 'answer') continue;
    const key = e.source || e.qid;
    let u = out.get(key);
    if (!u) {
      u = { answered: false, right: false, bad: false, noted: false, last_ts: '', first_ts: '' };
      out.set(key, u);
    }
    u.answered = true;
    if (e.outcome === 'bad') u.bad = true;
    if (e.outcome === 'right' && !e.repeat) u.right = true;
    if (e.note) u.noted = true;
    if (e.ts && (!u.last_ts || epoch(e.ts) > epoch(u.last_ts))) u.last_ts = e.ts; // the latest instant
    if (e.ts && (!u.first_ts || epoch(e.ts) < epoch(u.first_ts))) u.first_ts = e.ts; // the earliest
  }
  return out;
}

export function status(use) {
  if (!use || !use.answered) return FRESH;
  if (use.bad) return RETIRED;
  if (use.right) return SPENT;
  return MISSED;
}

/** Since this instant every question on a list point shows the whole list. A
 * missed list question first asked before it may show only some members, so it
 * never comes back as a fallback: the point waits for a fresh question. */
export const WHOLE_LISTS_SINCE = '2026-11-24T19:22:25+00:00';

export function beforeWholeLists(item, use) {
  return item.kind === 'list' && Boolean(use.first_ts) && epoch(use.first_ts) < epoch(WHOLE_LISTS_SINCE);
}

/** Whether a question still fits its point: written for the current
 * statement, and select all if the point is a list. */
export function usable(w, item) {
  if (w.statement_hash !== null && w.statement_hash !== statementHash(item)) return false;
  if (item.kind === 'list' && !isSelect(w.question)) return false;
  return true;
}

/** The written questions of one subject, ready to pick from. ``items`` are
 * the scheduled points; ``entries`` the subject's log; ``topups`` and
 * ``rounds`` as for writtenQuestions. */
export class Pool {
  constructor({ items, state, entries, topups = [], rounds = [] }) {
    this.items = items;
    this.use = uses(entries);
    this.by_item = new Map();
    this.held_back = []; // fresh questions written for a statement since edited
    for (const w of writtenQuestions({ topups, rounds, state })) {
      const item = items.get(w.item);
      if (!item) continue;
      if (!usable(w, item)) {
        if (status(this.use.get(w.qid)) === FRESH) this.held_back.push(w);
        continue;
      }
      if (!this.by_item.has(w.item)) this.by_item.set(w.item, []);
      this.by_item.get(w.item).push(w);
    }
  }

  fresh(itemId) {
    return (this.by_item.get(itemId) ?? []).filter((w) => status(this.use.get(w.qid)) === FRESH);
  }

  missed(itemId) {
    return (this.by_item.get(itemId) ?? [])
      .filter((w) => status(this.use.get(w.qid)) === MISSED && !this.use.get(w.qid).noted
        && !beforeWholeLists(this.items.get(itemId), this.use.get(w.qid)));
  }

  /** A fresh question first (one written for ``level`` if there is one, else
   * the oldest written); else a missed one, the longest since asked; else null. */
  pick(itemId, level = null) {
    const fresh = this.fresh(itemId);
    if (fresh.length) return minBy(fresh, (w) => [w.level !== (level ?? null), ...w.order]);
    const missed = this.missed(itemId);
    if (missed.length) {
      return minBy(missed, (w) => (this.use.get(w.qid).last_ts ? epoch(this.use.get(w.qid).last_ts) : -Infinity));
    }
    return null;
  }
}

/** A full copy of a written question for a round's questions file. */
export function copyForRound(w, slot) {
  const q = { ...structuredClone(w.question), slot, source: w.qid };
  delete q.id; // a copy is known by its source
  return q;
}
