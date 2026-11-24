// The memory model (learn/strength.py): a half-life in days per answered
// point; predicted recall is 2 ** (-days since last answered / half-life).
//
// First answer right: half-life first_right (60 days); wrong: first_wrong (1).
// Later right: multiplied by 1 + growth * (1 - predicted recall), capped at
// max_half_life. Later wrong, don't know or lucky: down to relearn (1 day),
// or kept if already shorter. Never below min_half_life. Bad question: no
// effect. A subject may override any value in subject.json's "memory".

export const RIGHT = 'right';
export const WRONG = 'wrong';
export const DUNNO = 'dunno';
export const LUCKY = 'lucky';
export const BAD = 'bad';

export const OUTCOMES = [RIGHT, WRONG, DUNNO, LUCKY, BAD];
export const SCORED = [RIGHT, WRONG, DUNNO, LUCKY];

export const DAY = 86400;

export const DEFAULT_MODEL = Object.freeze({
  first_right: 60,
  first_wrong: 1,
  relearn: 1,
  growth: 3,
  min_half_life: 0.5,
  max_half_life: 365,
  target: 0.8, // the right-answer rate the schedule aims for
});

/** A subject's "memory" block over the defaults. */
export function modelFromConfig(config) {
  const cfg = config || {};
  const unknown = Object.keys(cfg).filter((k) => !(k in DEFAULT_MODEL)).sort();
  if (unknown.length) throw new Error(`unknown memory setting(s): ${unknown.join(', ')}`);
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`memory setting ${k} is not a number`);
  }
  return Object.freeze({ ...DEFAULT_MODEL, ...cfg });
}

/** half_life in days; last: epoch seconds of the last scored answer. */
export function memory(half_life, last, reviews = 1, lapses = 0, first_right = true) {
  return Object.freeze({ half_life, last, reviews, lapses, first_right });
}

/** Predicted chance of a right answer at ``now``; 0 for an unseen point. */
export function recall(mem, now) {
  if (!mem) return 0;
  const days = Math.max(0, now - mem.last) / DAY;
  return 2 ** (-days / mem.half_life);
}

/** Fold one scored answer in. BAD must not reach here. */
export function update(mem, outcome, now, model = DEFAULT_MODEL) {
  if (!SCORED.includes(outcome)) throw new Error(`'${outcome}' does not move memory`);
  const right = outcome === RIGHT;
  if (!mem) return memory(right ? model.first_right : model.first_wrong, now, 1, right ? 0 : 1, right);
  if (right) {
    const p = recall(mem, now);
    const halfLife = Math.min(model.max_half_life, mem.half_life * (1 + model.growth * (1 - p)));
    return memory(Math.max(model.min_half_life, halfLife), now, mem.reviews + 1, mem.lapses, mem.first_right);
  }
  const halfLife = Math.max(model.min_half_life, Math.min(mem.half_life, model.relearn));
  return memory(halfLife, now, mem.reviews + 1, mem.lapses + 1, mem.first_right);
}
