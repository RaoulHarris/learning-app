// What a round did, for the end-of-round screen (learn/stats.py). It
// compares the memory when the round's session started with the state
// replayed after the round. Numbers are not rounded (the Python rounds them
// for its page: recalls to 2-3 places, half-lives and minutes to 1).

import { alone } from './schedule.js';
import { roundUnits } from './store.js';
import { RIGHT, SCORED, recall } from './strength.js';
import { epoch } from './time.js';
import { compare, median, sum } from './util.js';

/** Gaps between answers longer than this (seconds) count as breaks. */
export const BREAK = 180;
/** A point is "secure" from this half-life (days). */
export const SECURE_AT = 21;

const LAST = Number.MAX_SAFE_INTEGER;

/** Minutes spent answering: the gaps between consecutive stamps (epoch
 * seconds), breaks left out. */
export function activeMinutes(stamps) {
  const s = [...stamps].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] <= BREAK) gaps.push(s[i] - s[i - 1]);
  return sum(gaps) / 60;
}

/** Counts and recall over ``items`` with ``memory`` (Map item -> Memory). */
export function unitRow(items, memory, now) {
  const mems = items.filter((it) => memory.has(it.id)).map((it) => memory.get(it.id));
  const recalls = mems.map((m) => recall(m, now));
  return {
    points: items.length,
    seen: mems.length,
    unseen: items.length - mems.length,
    recall_all: items.length ? sum(recalls) / items.length : null, // unseen count as 0
    recall_seen: recalls.length ? sum(recalls) / recalls.length : null,
    median_half_life: mems.length ? median(mems.map((m) => m.half_life)) : null,
    secure: mems.filter((m) => m.half_life >= SECURE_AT).length,
  };
}

/**
 * The end-of-round figures. ``before`` (Map) is the memory when the round's
 * session started and ``started`` that moment; ``state`` is replayed after
 * the round; ``items`` is the whole inventory. ``unitOrder`` sorts the unit
 * rows (inventory order by default); ``inScope`` picks the points they count.
 */
export function roundStats({ number, brief, items, state, before, started, now, group = alone, unitOrder = null, inScope = null }) {
  const firsts = new Map();
  const stamps = [];
  for (const entries of state.history.values()) {
    for (const e of entries) {
      if (e.round !== number) continue;
      stamps.push(epoch(e.ts));
      if (!e.repeat && !firsts.has(e.item)) firsts.set(e.item, e);
    }
  }
  const meta = state.rounds.get(number);
  if (meta) stamps.push(epoch(meta.ts));

  const points = [];
  const factors = [];
  const calib = [];
  for (const [itemId, e] of firsts) {
    const it = items.get(itemId) ?? null;
    const b = before.get(itemId) ?? null;
    const a = state.memory.get(itemId) ?? null;
    if (b && SCORED.includes(e.outcome)) {
      calib.push([recall(b, epoch(e.ts)), e.outcome === RIGHT]);
      if (a) factors.push(a.half_life / b.half_life);
    }
    points.push({
      order: it ? it.order : LAST,
      row: {
        item: itemId,
        title: it ? it.title : itemId,
        unit: it ? it.unit : null,
        slot: Number(e.qid.slice(e.qid.lastIndexOf('q') + 1)),
        outcome: e.outcome,
        half_life_before: b ? b.half_life : null,
        half_life_after: a ? a.half_life : null,
        recall_before: b ? recall(b, started) : null,
      },
    });
  }
  points.sort((p, q) => compare([p.order, p.row.slot], [q.order, q.row.slot]));
  const rows = points.map((p) => p.row);

  // Every unit, introduced or not, then a total; counted over the points the
  // scheduler asks, so out-of-scope points don't count as unseen.
  const asked = [...items.values()].filter((it) => !inScope || inScope(it));
  const rowFor = (unit, pts) => {
    const was = unitRow(pts, before, started);
    return {
      unit,
      ...unitRow(pts, state.memory, now),
      before: {
        seen: was.seen,
        recall_all: was.recall_all,
        recall_seen: was.recall_seen,
        median_half_life: was.median_half_life,
        secure: was.secure,
      },
    };
  };
  const rank = new Map((unitOrder ?? []).map((u, n) => [u, n]));
  const first = new Map();
  for (const it of items.values()) if (!first.has(it.unit)) first.set(it.unit, it.order);
  const grouped = new Set();
  for (const unit of first.keys()) for (const u of group(unit)) if (u !== unit) grouped.add(u);
  const shown = new Set([...roundUnits(brief), ...[...first.keys()].filter((u) => !grouped.has(u))]);
  const key = (u) => [rank.get(u) ?? LAST, first.get(u) ?? LAST];
  const units = [...shown].sort((x, y) => compare(key(x), key(y))).map((unit) => {
    const members = new Set(group(unit));
    return rowFor(unit, asked.filter((it) => members.has(it.unit)));
  });
  const total = units.length > 1 ? rowFor(null, asked) : null;

  const scored = rows.filter((p) => SCORED.includes(p.outcome));
  const summary = {
    right_first: scored.filter((p) => p.outcome === RIGHT).length,
    scored: scored.length,
    new: rows.filter((p) => p.half_life_before === null).length,
    reviewed: rows.filter((p) => p.half_life_before !== null).length,
    median_half_life_factor: factors.length ? median(factors) : null,
    active_minutes: activeMinutes(stamps),
    calibration: calib.length ? {
      n: calib.length,
      predicted: sum(calib.map((c) => c[0])) / calib.length,
      actual: calib.filter((c) => c[1]).length / calib.length,
    } : null,
  };
  return { summary, units, total, points: rows };
}
