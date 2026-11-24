// Choosing the points for a round (learn/schedule.py).
//
// No randomness in the choice: points owed a fresh question, then unseen
// points of the units drawn from in inventory order, then seen points by
// predicted recall, lowest first (ties: the more important, then the one
// asked longest ago). Any other point already asked today is left out. A
// review round is then shuffled with prerequisites placed first; an intro
// round keeps inventory order.

import { makeRng } from './random.js';
import { recall } from './strength.js';
import { compare, sum } from './util.js';

export const DEFAULT_LENGTH = 20;
export const INTRO = 'intro';
export const REVIEW = 'review';

/** The default unit grouping: each unit on its own. */
export function alone(unit) {
  return [String(unit)];
}

export function poolFor(items, units, group = alone) {
  const wanted = new Set(units.flatMap((u) => group(u)));
  return [...items.values()].filter((it) => wanted.has(it.unit));
}

/** The units an intro round brings in: one, a comma-separated string, or a list. */
export function introUnits(unit) {
  if (unit == null) return [];
  const parts = Array.isArray(unit) ? unit : String(unit).split(',');
  const out = [];
  for (const p of parts) {
    const u = String(p).trim();
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/** [units the round draws from, units introduced once it starts]. An intro
 * round may bring in several units, and may name one already in (a top-up:
 * then only its unseen points are asked). */
export function roundUnits(state, kind, unit) {
  if (kind === INTRO) {
    const fresh = introUnits(unit);
    if (!fresh.length) throw new Error('an intro round needs a unit');
    return [fresh, [...state.units, ...fresh.filter((u) => !state.units.includes(u))]];
  }
  if (!state.units.length) throw new Error('nothing introduced yet; start with an intro round');
  return [[...state.units], [...state.units]];
}

/**
 * Plan a round. ``items`` are the scheduled points; ``day`` (YYYY-MM-DD, or
 * "" to leave nothing out for being asked today) and ``now`` (epoch seconds)
 * are required: the engine never reads the clock. ``group`` is the subject's
 * unit grouping. Returns {slots, meta}; a slot is {item, reason (carry, new,
 * weakest), recall (0 if unseen), half_life (null if unseen)}.
 */
export function plan({ items, state, kind, unit = null, length = DEFAULT_LENGTH, rng, day, now, group = alone }) {
  if (typeof day !== 'string' || typeof now !== 'number') throw new Error('plan needs day (a string) and now (epoch seconds)');
  rng = rng || makeRng();
  const [drawFrom, introduced] = roundUnits(state, kind, unit);
  let pool = poolFor(items, drawFrom, group);
  if (kind === INTRO) {
    // A unit already in: only its points never asked.
    const old = new Set(drawFrom.filter((u) => state.units.includes(u)).flatMap((u) => group(u)));
    if (old.size) {
      pool = pool.filter((it) => !old.has(it.unit) || !state.seen(it.id));
      if (!pool.some((it) => old.has(it.unit))) {
        const names = drawFrom.filter((u) => state.units.includes(u)).join(', ');
        throw new Error(`${names} already introduced, with no unseen points`);
      }
    }
  }

  const slot = (it, reason) => {
    const mem = state.mem(it.id);
    return { item: it, reason, recall: recall(mem, now), half_life: mem ? mem.half_life : null };
  };
  const byOrder = (a, b) => a.order - b.order;
  const carried = pool.filter((it) => state.carry.has(it.id)).sort(byOrder);
  const rest = pool.filter((it) => !state.carry.has(it.id) && state.seen_on.get(it.id) !== day);
  const unseen = rest.filter((it) => !state.seen(it.id)).sort(byOrder);
  const weakest = rest
    .filter((it) => state.seen(it.id))
    .map((it) => ({ it, key: [recall(state.mem(it.id), now), -it.importance, state.mem(it.id).last] }))
    .sort((a, b) => compare(a.key, b.key))
    .map((x) => x.it);
  const chosen = [
    ...carried.map((it) => slot(it, 'carry')),
    ...unseen.map((it) => slot(it, 'new')),
    ...weakest.map((it) => slot(it, 'weakest')),
  ].slice(0, length);

  const ordered = order(chosen, kind, rng);
  const meta = {
    kind,
    unit: kind === INTRO ? drawFrom.join(',') : null,
    units: introduced,
    draws_from: drawFrom,
    length: ordered.length,
    pool: poolFor(items, introduced, group).length,
  };
  return { slots: ordered, meta };
}

/** Mean predicted recall of a round's points, what choosing a subject
 * compares: a point owed a fresh question counts as 0, and with ``length``,
 * slots the round cannot fill count as 1. */
export function strength(slots, length = null) {
  if (!slots.length) return null;
  const total = sum(slots.map((s) => (s.reason === 'carry' ? 0 : s.recall)));
  const n = Math.max(slots.length, length || 0);
  return (total + (n - slots.length)) / n;
}

/** Inventory order for an intro round; for a review, shuffled, then each
 * prerequisite found after its dependant moved to just before it (repeated
 * at most once per slot, as in the Python). */
export function order(slots, kind, rng) {
  if (kind === INTRO) return [...slots].sort((a, b) => a.item.order - b.item.order);
  slots = rng.shuffle([...slots]);
  let position = new Map(slots.map((s, n) => [s.item.id, n]));
  for (let pass = 0; pass < slots.length; pass++) {
    let moved = false;
    outer: for (let n = 0; n < slots.length; n++) {
      for (const dep of slots[n].item.raw.depends_on ?? []) {
        if (position.has(dep) && position.get(dep) > n) {
          const [prereq] = slots.splice(position.get(dep), 1);
          slots.splice(n, 0, prereq);
          position = new Map(slots.map((s, k) => [s.item.id, k]));
          moved = true;
          break outer;
        }
      }
    }
    if (!moved) break;
  }
  return slots;
}
