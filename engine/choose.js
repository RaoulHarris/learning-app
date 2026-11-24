// Choosing the subject for a review round when none is named
// (learn/choose.py): every choosable subject (weight above 0, active, not
// past its until day, something introduced) is planned as a review round and
// scored by strength (mean predicted recall over its slots); the largest
// weight * (1 - strength) wins. Introducing a unit is never chosen.

import { makeRng } from './random.js';
import { DEFAULT_LENGTH, REVIEW, plan, strength as roundStrength } from './schedule.js';
import { ACTIVE, reviewWeight } from './subject.js';
import { today } from './time.js';
import { compare } from './util.js';

function candidate(subject, strength, points, whyNot = null, weight = 1) {
  const gap = strength === null || whyNot ? -1 : weight * (1 - strength);
  return { slug: subject.slug, subject, strength, points, why_not: whyNot, weight, gap };
}

/** Every subject, scored, best first; the unchoosable last, with a reason.
 * ``subjects`` are subjectData() bundles; ``reviews`` is parseReviews().
 * Without ``day``, today on this device's clock. */
export function candidates({ subjects, reviews = {}, length = DEFAULT_LENGTH, day, now }) {
  day = day ?? today();
  const out = [];
  for (const data of subjects) {
    const subj = data.subject;
    const weight = reviewWeight(subj, reviews);
    if (weight === 0) {
      out.push(candidate(subj, null, 0, 'weight 0', 0));
      continue;
    }
    if (!subj.choosable(day)) {
      out.push(candidate(subj, null, 0, subj.status !== ACTIVE ? subj.status : `ended ${subj.until}`));
      continue;
    }
    if (!data.state.units.length) {
      out.push(candidate(subj, null, 0, 'nothing introduced'));
      continue;
    }
    // The order of the slots does not matter here, so any seed will do.
    const { slots } = plan({
      items: data.scheduled, state: data.state, kind: REVIEW, length,
      rng: makeRng(0), day, now, group: (u) => subj.group(u),
    });
    if (!slots.length) {
      out.push(candidate(subj, null, 0, 'nothing left to ask today'));
      continue;
    }
    out.push(candidate(subj, roundStrength(slots, length), slots.length, null, weight));
  }
  out.sort((a, b) => compare([a.why_not !== null, -a.gap, a.slug], [b.why_not !== null, -b.gap, b.slug]));
  return out;
}

/** {subject: the one a review round would take, or null; ranked}. */
export function choose(opts) {
  const ranked = candidates(opts);
  const best = ranked.length && ranked[0].why_not === null ? ranked[0] : null;
  return { subject: best ? best.subject : null, ranked };
}
