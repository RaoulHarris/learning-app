// The subjects as the engine sees them, from the files kept on this device
// (with this device's unpushed writes laid over them), and planning a round.
//
// The app can only ask questions already written (top-ups, or a missed one
// coming back), so it plans from the points that have one: a point without
// one waits for the next top-up, and the next weakest point takes its place.

import { Pool, fileHash } from '../engine/ahead.js';
import { buildBrief, fillRound } from '../engine/brief.js';
import { candidates } from '../engine/choose.js';
import { makeRng } from '../engine/random.js';
import { DEFAULT_LENGTH, INTRO, REVIEW, plan } from '../engine/schedule.js';
import { mergeLogs, readLog } from '../engine/store.js';
import { parseReviews, subjectData } from '../engine/subject.js';
import { nowEpoch, today } from '../engine/time.js';
import { ROOT, overlay, subjectFolders } from './sync.js';

function parse(text, fallback) {
  if (text === undefined || text === null) return fallback;
  return JSON.parse(text);
}

/** Every file's text, as this device sees it. */
export async function readFiles(local) {
  const files = new Map((await local.files.all()).map((f) => [f.path, f.text]));
  return overlay(files, await local.outbox.all());
}

/** One subject: the engine's bundle (subject, inventory, scheduled, entries,
 * state), its written questions (pool), the points that have one
 * (available), and its requests. */
export function loadSubject(folder, files) {
  const slug = folder.slice(ROOT.length + 1);
  const under = (prefix, suffix) => [...files.keys()]
    .filter((p) => p.startsWith(`${folder}/${prefix}`) && p.endsWith(suffix)).sort();
  const data = subjectData({
    slug,
    subjectJson: files.get(`${folder}/subject.json`),
    inventoryJson: files.get(`${folder}/inventory.json`) ?? '{"items": []}',
    log: files.get(`${folder}/log.jsonl`) ?? '',
    logs: under('logs/', '.jsonl').map((p) => files.get(p)),
  });
  const ready = parse(files.get(`${folder}/topups/ready.json`), {});
  const topups = Object.entries(ready).map(([name, hash]) => {
    const q = files.get(`${folder}/topups/${name}/questions.json`);
    return {
      number: Number(name.slice(1)),
      brief: parse(files.get(`${folder}/topups/${name}/brief.json`), null),
      questions: parse(q, null),
      ready: q !== undefined && fileHash(q) === hash,
    };
  });
  const rounds = [];
  for (const p of under('rounds/r', '/questions.json')) {
    const name = p.slice(`${folder}/rounds/`.length, -'/questions.json'.length);
    if (!/^r\d{4,}$/.test(name)) continue;
    rounds.push({
      number: Number(name.slice(1)),
      brief: parse(files.get(`${folder}/rounds/${name}/brief.json`), null),
      questions: parse(files.get(p), null),
    });
  }
  const pool = new Pool({ items: data.scheduled, state: data.state, entries: data.entries, topups, rounds });
  const available = new Map([...data.scheduled].filter(([id]) => pool.pick(id) !== null));
  const requests = mergeLogs(under('requests/', '.jsonl').map((p) => readLog(files.get(p))));
  return { ...data, folder, slug, pool, available, requests };
}

/** Every subject, and the review weights. */
export function loadLibrary(files) {
  const subjects = [];
  const problems = [];
  for (const folder of subjectFolders([...files.keys()])) {
    try {
      subjects.push(loadSubject(folder, files));
    } catch (exc) {
      problems.push(`${folder}: ${exc.message}`);
    }
  }
  return { subjects, reviews: parseReviews(files.get(`${ROOT}/reviews.json`) ?? null), problems };
}

/** The subject as the planner should see it in the app: only the points
 * that have a written question. */
export function servable(subj) {
  return { ...subj, scheduled: subj.available };
}

/** Subjects for a review round, best first (choose.candidates over what can
 * be served). */
export function reviewChoice(lib, now = new Date()) {
  return candidates({ subjects: lib.subjects.map(servable), reviews: lib.reviews, day: today(now), now: nowEpoch(now) });
}

/** How many points a review round of this subject would ask now (0: none). */
export function reviewSize(subj, now = new Date()) {
  if (!subj.state.units.length) return 0;
  try {
    return plan({
      items: subj.available, state: subj.state, kind: REVIEW, length: DEFAULT_LENGTH, rng: makeRng(0),
      day: today(now), now: nowEpoch(now), group: (u) => subj.subject.group(u),
    }).slots.length;
  } catch (exc) {
    return 0;
  }
}

/** How many points of the next review round have no question yet: those a
 * review round would take if every point had one, but cannot. */
export function waiting(subj, now = new Date()) {
  if (!subj.state.units.length) return 0;
  try {
    const { slots } = plan({
      items: subj.scheduled, state: subj.state, kind: REVIEW, length: DEFAULT_LENGTH, rng: makeRng(0),
      day: today(now), now: nowEpoch(now), group: (u) => subj.subject.group(u),
    });
    return slots.filter((s) => !subj.available.has(s.item.id)).length;
  } catch (exc) {
    return 0;
  }
}

/** The intro rounds still to come, as a top-up plans them (topup.intro_groups):
 * the units not yet introduced, in order, cut into rounds of whole
 * consecutive units while they fit in ``length`` points (a big unit is a
 * round of its own, which takes its first ``length`` points). */
export function introGroups(subj, length = DEFAULT_LENGTH) {
  const s = subj.subject;
  const groups = [];
  let current = [];
  let used = 0;
  for (const unit of s.allUnits(subj.scheduled)) {
    const members = new Set(s.group(unit));
    const n = [...subj.scheduled.values()].filter((it) => members.has(it.unit)).length;
    if (subj.state.units.includes(unit) || !n) continue;
    if (current.length && used + n > length) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(unit);
    used += n;
  }
  if (current.length) groups.push(current);
  return groups;
}

/** The intro rounds still to come: [{units, points, written, requested}];
 * ``written`` counts the points that have a question, and ``requested``
 * says every unit has been asked for in the app. */
export function newUnits(subj) {
  const s = subj.subject;
  const asked = new Set(subj.requests.filter((r) => r.type === 'intro').map((r) => String(r.unit)));
  return introGroups(subj).map((units) => {
    const members = new Set(units.flatMap((u) => s.group(u)));
    const pts = [...subj.scheduled.values()].filter((it) => members.has(it.unit));
    return {
      units,
      points: pts.length,
      written: pts.filter((it) => subj.available.has(it.id)).length,
      requested: units.every((u) => asked.has(u)),
    };
  });
}

/** This device's next round name: <device>-<n>, n one more than any round it
 * has started (in any subject). */
export function nextRoundName(lib, device) {
  let n = 0;
  const own = new RegExp(`^${device}-(\\d+)$`);
  for (const subj of lib.subjects) {
    for (const name of subj.state.rounds.keys()) {
      const m = own.exec(String(name));
      if (m) n = Math.max(n, Number(m[1]));
    }
  }
  return `${device}-${n + 1}`;
}

/** A round ready to play: {name, brief, questions}. ``kind`` is intro (with
 * ``unit``) or review. Throws if there is nothing to ask. */
export function planRound(lib, subj, { kind, unit = null, device, length = DEFAULT_LENGTH, now = new Date() }) {
  const { slots, meta } = plan({
    items: subj.available, state: subj.state, kind, unit, length, rng: makeRng(),
    day: today(now), now: nowEpoch(now), group: (u) => subj.subject.group(u),
  });
  if (!slots.length) throw new Error(kind === INTRO ? 'no questions written for that yet' : 'nothing to ask today');
  const name = nextRoundName(lib, device);
  const brief = buildBrief({ subject: subj.subject, slots, meta, items: subj.scheduled, number: name });
  const filled = fillRound(brief.slots, subj.pool);
  brief.slots = filled.slots;
  return { name, brief, questions: filled.questions };
}

export { INTRO, REVIEW };
