// One round being played (learn/server.py RoundApp), without the HTTP server.
//
// An answer is held, not logged, until the next question is asked for: that
// is what lets "lucky guess", "bad question", a note and undo amend it
// without the log ever holding an answer and a correction to it. A missed
// first answer (wrong or don't know), or a repeat marked lucky, brings the
// same question back REPEAT_GAP questions later (or at the end); a repeat is
// logged but never scored. A session resumed from a log that already holds
// some of the round's answers skips the questions answered and queues the
// repeats still to come after the next REPEAT_GAP - 1 questions.
//
// The session writes nothing itself: each log entry goes to ``onAppend``
// (and into ``session.log``), as the Python appends it to log.jsonl. Call
// commit() when the page is hidden or closed, as the Python server does when
// it stops, so that a held answer is not lost. Numbers in the payloads are
// not rounded (the Python rounds them for its page).

import { isRight, isSelect, optionText, optionWhy } from './questions.js';
import { makeRng } from './random.js';
import { roundStats } from './stats.js';
import { AGAIN, pendingRepeats, qid, replay } from './store.js';
import { BAD, DUNNO, LUCKY, RIGHT, SCORED, WRONG, recall, update } from './strength.js';
import { epoch, nowTs } from './time.js';

/** A missed question comes back this many questions later (or at the end). */
export const REPEAT_GAP = 4;

/** Nothing is waiting for that action (the server's 409). */
export class Stale extends Error {
  constructor(message) {
    super(message);
    this.name = 'Stale';
  }
}

/** A malformed answer (the server's 400). */
export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
  }
}

export class RoundSession {
  /**
   * ``subject``: a Subject; ``number``: the round's number; ``brief`` and
   * ``questions`` (a list, one per brief slot): the round; ``items``: the
   * whole inventory (Map); ``log``: the subject's log entries so far.
   * ``rng``: for the option order (default: unseeded); ``clock``: () => the
   * time as the log writes it (default: now, local time with offset);
   * ``onAppend``: (entries) => void, to keep what is logged.
   */
  constructor({ subject, number, brief, questions, items, log = [], rng, clock, onAppend }) {
    this.subject = subject;
    this.number = number;
    this.brief = brief;
    this.questions = questions;
    this.items = items;
    this.log = [...log];
    this.rng = rng || makeRng();
    this.clock = clock || (() => nowTs());
    this.onAppend = onAppend || (() => {});
    this.state = replay(this.log, subject.model);
    const done = this.state.answered.get(number) ?? new Set();
    const unanswered = [];
    for (let n = 0; n < questions.length; n++) if (!done.has(this.qid(n))) unanswered.push([n, false]);
    // Resuming: a repeat still to come is queued again after the next
    // REPEAT_GAP - 1 questions (or after the rest, if fewer).
    const index = new Map(questions.map((_, n) => [this.qid(n), n]));
    const repeats = pendingRepeats(this.state, number).filter((q) => index.has(q)).map((q) => [index.get(q), true]);
    this.queue = [...unanswered.slice(0, REPEAT_GAP - 1), ...repeats, ...unanswered.slice(REPEAT_GAP - 1)]; // [index, is a repeat]
    this.resumed = questions.length - unanswered.length;
    this.current = null; // the question on screen, and its answer while held
    this.tally = { right: 0, wrong: 0, dunno: 0, lucky: 0, bad: 0 };
    this.misses = [];
    this.finished = false;
    this.result = null;
    // The memory when this session started, for the end-of-round comparison.
    this.before = new Map(this.state.memory);
    this.started = epoch(this.clock());
  }

  qid(n) {
    return qid(this.number, n);
  }

  append(entries) {
    this.log.push(...entries);
    this.onAppend(entries);
  }

  reload() {
    this.state = replay(this.log, this.subject.model);
  }

  /** Log the round's start, once. */
  start() {
    if (this.state.rounds.has(this.number)) return;
    const units = this.brief.units.map(String);
    const members = new Set(units.flatMap((u) => this.subject.group(u)));
    let pool = 0;
    for (const it of this.items.values()) if (members.has(it.unit) && this.subject.inScope(it)) pool += 1;
    this.append([{
      type: 'round',
      round: this.number,
      kind: this.brief.kind,
      unit: this.brief.unit ?? null,
      units,
      length: this.questions.length,
      pool,
      ts: this.clock(),
    }]);
    this.reload();
  }

  /** Move on (the server's GET /api/next): log the held answer and show the
   * next question, or finish; once finished, the result again. */
  getNext() {
    if (this.finished) return this.result;
    return this.next();
  }

  /** What a freshly loaded page shows (GET /api/current): the question on
   * screen, with its reveal if answered, else the next. */
  getCurrent() {
    if (this.finished) return this.result;
    return this.current !== null ? this.questionPayload() : this.next();
  }

  next() {
    this.commit();
    if (this.current !== null) return this.questionPayload();
    if (!this.queue.length) return this.finish();
    const [index, repeat] = this.queue.shift();
    const q = this.questions[index];
    const order = q.options.map((_, k) => k);
    if (!q.fixed_order) this.rng.shuffle(order); // options are reshuffled, unless fixed
    this.current = { index, repeat, order, choice: null, outcome: null, note: null, ms: null };
    return this.questionPayload();
  }

  slot(index) {
    return this.brief.slots[index];
  }

  questionPayload() {
    const p = this.current;
    const q = this.questions[p.index];
    const payload = {
      done: false,
      qid: this.qid(p.index),
      number: p.index + 1,
      total: this.questions.length,
      answered: Object.values(this.tally).reduce((a, b) => a + b, 0) + this.resumed,
      left: this.queue.length + 1,
      repeat: p.repeat,
      round: this.number,
      kind: this.brief.kind,
      stem: q.stem,
      diagram: q.diagram ?? null,
      options: p.order.map((k) => optionText(q.options[k])),
      type: isSelect(q) ? 'select' : 'single',
      // Recall before recognition: options hidden first, but not on a repeat.
      recall_first: Boolean(this.slot(p.index).recall_first) && !p.repeat,
    };
    if (p.outcome !== null) payload.reveal = this.reveal();
    return payload;
  }

  /** ``shown`` indexes the options as shown: one index, the list of those
   * ticked for a select question, or null for "don't know". */
  answer(shown, ms = null) {
    const p = this.current;
    if (p === null) throw new Stale('no question is waiting for an answer');
    if (p.outcome !== null) return this.reveal();
    const q = this.questions[p.index];
    if (shown == null) {
      p.choice = null;
      p.outcome = DUNNO;
    } else {
      const picks = Array.isArray(shown) ? shown : [shown];
      if (isSelect(q) !== Array.isArray(shown)) {
        throw new BadRequest('a select question takes a list of choices; any other takes one');
      }
      if (!picks.every((k) => Number.isInteger(k) && k >= 0 && k < p.order.length)) {
        throw new BadRequest('choice out of range');
      }
      const chosen = [...new Set(picks.map((k) => p.order[k]))].sort((a, b) => a - b);
      p.choice = isSelect(q) ? chosen : chosen[0];
      p.outcome = isRight(q, p.choice) ? RIGHT : WRONG;
    }
    p.ms = ms ?? null;
    return this.reveal();
  }

  /** After the reveal: "lucky" marks a right answer as a lucky guess
   * ("unlucky" takes it back), "bad" flags the question ("unbad" takes it
   * back); ``note`` sets the note ("" clears it). */
  amend(outcome, note) {
    const p = this.current;
    if (p === null || p.outcome === null) throw new Stale('no answer is waiting to be amended');
    if (outcome === LUCKY && p.outcome === RIGHT) p.outcome = LUCKY;
    else if (outcome === 'unlucky' && p.outcome === LUCKY) p.outcome = RIGHT;
    else if (outcome === BAD) p.outcome = BAD;
    else if (outcome === 'unbad' && p.outcome === BAD) {
      const q = this.questions[p.index];
      p.outcome = p.choice === null ? DUNNO : (isRight(q, p.choice) ? RIGHT : WRONG);
    }
    if (note != null) p.note = note.trim() || null;
    return this.reveal();
  }

  /** Withdraw the held answer (a mis-key) and put the question back. */
  undo() {
    const p = this.current;
    if (p === null || p.outcome === null) throw new Stale('no answer is waiting to be undone');
    p.choice = p.outcome = p.note = p.ms = null;
    return this.questionPayload();
  }

  reveal() {
    const p = this.current;
    const q = this.questions[p.index];
    const slot = this.slot(p.index);
    const shownOf = (k) => p.order.indexOf(k);
    let shownAnswer;
    let shownChoice;
    if (isSelect(q)) {
      shownAnswer = q.answer.map(shownOf).sort((a, b) => a - b);
      shownChoice = p.choice === null ? null : p.choice.map(shownOf).sort((a, b) => a - b);
    } else {
      shownAnswer = shownOf(q.answer);
      shownChoice = p.choice === null ? null : shownOf(p.choice);
    }
    const before = this.state.mem(q.item);
    const now = epoch(this.clock());
    // What the half-life would become: only a scored first answer moves it.
    const after = SCORED.includes(p.outcome) && !p.repeat ? update(before, p.outcome, now, this.subject.model) : before;
    return {
      outcome: p.outcome,
      repeat: p.repeat,
      answer: shownAnswer,
      choice: shownChoice,
      why: p.order.map((k) => optionWhy(q.options[k])),
      explanation: q.explanation ?? null,
      note: p.note,
      point: this.items.has(q.item) ? {
        title: slot.title,
        unit: slot.unit ?? slot.chapter ?? null,
        section: slot.section,
        statement: slot.statement,
      } : null,
      recall_before: before ? recall(before, now) : null,
      half_life_before: before ? before.half_life : null,
      half_life_after: after ? after.half_life : null,
    };
  }

  /** Log the held answer, if any; after a missed first answer or a repeat
   * marked lucky, queue the same question again. */
  commit() {
    const p = this.current;
    if (p === null || p.outcome === null) return;
    const q = this.questions[p.index];
    const entry = {
      type: 'answer',
      round: this.number,
      qid: this.qid(p.index),
      item: q.item,
      outcome: p.outcome,
      choice: p.choice,
      answer: q.answer,
      repeat: p.repeat,
      ms: p.ms,
      note: p.note,
      ts: this.clock(),
    };
    if (q.source) entry.source = q.source; // the written question's permanent id
    this.append([structuredClone(entry)]);
    if (!p.repeat) {
      this.tally[p.outcome] += 1;
      if (AGAIN.includes(p.outcome)) { // lucky is a miss too
        this.misses.push({ title: this.slot(p.index).title, outcome: p.outcome });
      }
    }
    if (AGAIN.includes(p.outcome)) {
      // Not yet answered right (a miss, a don't know, or right only by luck):
      // the question comes back, first time or repeat, until it is.
      this.queue.splice(Math.min(REPEAT_GAP - 1, this.queue.length), 0, [p.index, true]);
    }
    this.current = null;
    this.reload();
  }

  finish() {
    this.commit();
    this.current = null;
    this.finished = true;
    const asked = new Set(this.questions.map((q) => q.item));
    this.result = {
      done: true,
      round: this.number,
      tally: { ...this.tally },
      resumed: this.resumed,
      misses: this.misses,
      carried: [...this.state.carry].filter((i) => asked.has(i)).length, // owed a fresh question
      left_unasked: this.queue.length,
      stats: roundStats({
        number: this.number,
        brief: this.brief,
        items: this.items,
        state: this.state,
        before: this.before,
        started: this.started,
        now: epoch(this.clock()),
        group: (u) => this.subject.group(u),
        inScope: (it) => this.subject.inScope(it),
      }),
    };
    return this.result;
  }

  /** End the round now; first questions not yet asked are left unasked. */
  endEarly() {
    this.commit();
    const unasked = this.queue.filter(([, repeat]) => !repeat);
    this.queue = [];
    const result = this.finish();
    result.left_unasked = unasked.length;
    return result;
  }
}
