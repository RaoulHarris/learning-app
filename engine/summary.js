// A row per subject for a home screen: what the top table of `learn status`
// shows (learn/cli.py overview).

import { candidates } from './choose.js';
import { DEFAULT_LENGTH } from './schedule.js';
import { recall } from './strength.js';

/** One subject's row. ``candidate`` is its entry from choose.candidates. */
export function subjectSummary(data, candidate, now) {
  const { subject: subj, scheduled: items, state } = data;
  const members = new Set(state.units.flatMap((u) => subj.group(u)));
  const pts = [...items.values()].filter((it) => members.has(it.unit));
  const mems = pts.filter((it) => state.seen(it.id)).map((it) => state.mem(it.id));
  const c = candidate || null;
  return {
    slug: subj.slug,
    title: subj.title,
    unit_name: subj.unit_name,
    units_in: state.units.length, // units introduced
    units_total: subj.allUnits(items).length,
    points: pts.length, // points in the units introduced
    unseen: pts.length - mems.length,
    below: mems.filter((m) => recall(m, now) < subj.model.target).length, // seen, predicted below target
    review_strength: c ? c.strength : null, // mean predicted recall a review round would get now
    review_points: c && c.strength !== null ? c.points : null, // and its length
    why_not: c ? c.why_not : null, // why it cannot be chosen for review
    weight: c ? c.weight : null,
  };
}

/** Every subject's row, in the order given, and the subject a review round
 * would take now. Options as choose.candidates. */
export function homeSummary({ subjects, reviews = {}, length = DEFAULT_LENGTH, day, now }) {
  const ranked = candidates({ subjects, reviews, length, day, now });
  const bySlug = new Map(ranked.map((c) => [c.slug, c]));
  const rows = subjects.map((d) => subjectSummary(d, bySlug.get(d.subject.slug), now));
  const best = ranked.length && ranked[0].why_not === null ? ranked[0] : null;
  return { rows, chosen: best ? best.slug : null, ranked };
}
