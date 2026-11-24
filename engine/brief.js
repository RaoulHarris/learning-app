// A round's brief, as far as serving a round needs it (learn/brief.py), and
// filling its slots from written questions (learn/cli.py cmd_plan).
//
// Left out: the suggestions only a question writer uses ("tests", drawn at
// random in the Python, "diagram" and "past_questions", which read old
// rounds' question files), and the writing notes and source paths. Numbers
// are not rounded (the Python rounds predicted_recall to 3 places and
// half_life_days to 1 for the writer to read).

import { copyForRound } from './ahead.js';
import { SELECT, SINGLE } from './questions.js';

/** Half-life (days) from which the options stay hidden until the learner
 * has tried to recall the answer. */
export const RECALL_FIRST_AT = 4;
/** Half-lives (days) at which questions step up to applied, then transfer. */
export const APPLIED_AT = 4;
export const TRANSFER_AT = 21;

/** direct (new, or half-life under 4 days), applied (under 21), transfer. */
export function levelFor(slot) {
  if (slot.half_life === null || slot.half_life < APPLIED_AT) return 'direct';
  if (slot.half_life < TRANSFER_AT) return 'applied';
  return 'transfer';
}

/** A list point is always asked as select all that apply. */
export function formatFor(item) {
  return item.kind === 'list' ? SELECT : SINGLE;
}

/** The brief for planned ``slots`` and ``meta`` (from schedule.plan);
 * ``items`` are the scheduled points. */
export function buildBrief({ subject, slots, meta, items, number }) {
  const out = slots.map((slot, k) => {
    const it = slot.item;
    const raw = it.raw;
    const hl = slot.half_life;
    return {
      slot: k + 1,
      item: it.id,
      reason: slot.reason,
      fresh_angle: slot.reason === 'carry',
      format: formatFor(it),
      level: levelFor(slot),
      recall_first: hl !== null && hl >= RECALL_FIRST_AT,
      predicted_recall: hl !== null ? slot.recall : null,
      half_life_days: hl,
      unit: it.unit,
      section: it.section,
      kind: it.kind,
      title: it.title,
      importance: it.importance,
      statement: raw.statement ?? null,
      formula: raw.formula ?? null,
      explanation: raw.explanation ?? null,
      pitfalls: raw.pitfalls ?? [],
      calc_ideas: raw.calc_ideas ?? [],
      near_misses: raw.near_misses ?? [],
      diagram_ideas: raw.figure?.maskable ?? [],
      prerequisites: (raw.depends_on ?? []).filter((d) => items.has(d))
        .map((d) => ({ id: d, title: items.get(d).title, statement: items.get(d).raw.statement ?? null })),
      related: raw.related ?? [],
    };
  });
  return {
    round: number,
    subject: subject.slug,
    subject_title: subject.title,
    unit_name: subject.unit_name,
    math: subject.math,
    ...meta,
    slots: out,
  };
}

/** Fill each slot from the pool, as `learn plan` does: a copy of the picked
 * question (with ``source``), or {slot, item, todo: true} when there is none.
 * Returns {slots (each with ``prefilled``: the qid or null), questions}. */
export function fillRound(briefSlots, pool) {
  const slots = [];
  const questions = [];
  for (const s of briefSlots) {
    const w = pool.pick(s.item, s.level);
    slots.push({ ...s, prefilled: w ? w.qid : null });
    questions.push(w ? copyForRound(w, s.slot) : { slot: s.slot, item: s.item, todo: true });
  }
  return { slots, questions };
}
