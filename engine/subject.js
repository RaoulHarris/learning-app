// Subjects (learn/subject.py): subject.json parsed, scope, unit groups and
// order, and the review weights from subjects/reviews.json.

import { loadInventory, mergeLogs, readLog, replay } from './store.js';
import { modelFromConfig } from './strength.js';

export const TOP = 'subjects'; // the collection of top-level subjects
export const ACTIVE = 'active';
export const ARCHIVED = 'archived';
export const REVIEWS = 'reviews.json';
/** What a question can test (questions.TESTS). */
export const TESTS = ['fact', 'understanding', 'calculation'];

export class Subject {
  constructor(fields) {
    Object.assign(this, fields);
  }

  /** "subjects" for a top-level subject, else its folder ("books"). */
  get collection() {
    return this.slug.includes('/') ? this.slug.split('/')[0] : TOP;
  }

  /** The units that come in with ``unit``: itself, plus any grouped with it. */
  group(unit) {
    return this.unit_groups.get(String(unit)) ?? [String(unit)];
  }

  /** Whether the scheduler asks this point: its unit's scope rule (else the
   * "*" rule) sets an importance floor and item fields that rule it out. */
  inScope(item) {
    const rule = this.scope.get(item.unit) ?? this.scope.get('*') ?? {};
    if (item.importance < (rule.min_importance ?? 0)) return false;
    return !(rule.exclude ?? []).some((flag) => Boolean(item.raw[flag]));
  }

  /** The points the scheduler draws from: those in scope. */
  scheduled(items) {
    const out = new Map();
    for (const [id, it] of items) if (this.inScope(it)) out.set(id, it);
    return out;
  }

  /** Every unit in suggestion order: unit_order, then the rest in inventory
   * order. Units only grouped into another are left out. */
  allUnits(items) {
    const grouped = new Set();
    for (const [head, members] of this.unit_groups) for (const u of members) if (u !== head) grouped.add(u);
    const out = [];
    const byOrder = [...items.values()].sort((a, b) => a.order - b.order).map((it) => it.unit);
    for (const unit of [...this.unit_order, ...byOrder]) {
      if (!out.includes(unit) && !grouped.has(unit)) out.push(unit);
    }
    return out;
  }

  /** Whether automatic subject choice may pick it on ``day``: active and not
   * past its "until" day. */
  choosable(day) {
    return this.status === ACTIVE && (this.until == null || day <= this.until);
  }
}

/** subject.json parsed. Only "title" is required. */
export function parseSubject(slug, config) {
  const where = `${slug}/subject.json`;
  if ('weight' in config) throw new Error(`${where}: 'weight' has moved to ${REVIEWS} (overrides)`);
  if ('styles' in config) {
    throw new Error(`${where}: 'styles' is retired; map kinds to what they test in 'tests' `
      + `(${TESTS.join(', ')}). List points are always select all.`);
  }
  const bad = Object.entries(config.tests ?? {}).filter(([, v]) => !TESTS.includes(v));
  if (bad.length) throw new Error(`${where}: 'tests' values must be one of ${TESTS.join(', ')}: ${JSON.stringify(Object.fromEntries(bad))}`);
  if (config.title === undefined) throw new Error(`${where}: no title`);
  let model;
  try {
    model = modelFromConfig(config.memory);
  } catch (exc) {
    throw new Error(`${where}: ${exc.message}`);
  }
  return new Subject({
    slug,
    title: config.title,
    unit_name: config.unit_name ?? 'unit',
    unit_order: (config.unit_order ?? []).map(String),
    unit_groups: new Map(Object.entries(config.unit_groups ?? {}).map(([k, v]) => [String(k), v.map(String)])),
    math: Boolean(config.math),
    banned: [...(config.banned ?? [])],
    named_examples: [...(config.named_examples ?? [])],
    tests: { ...(config.tests ?? {}) },
    model,
    status: config.status ?? ACTIVE,
    until: config.until ?? null,
    sources: config.sources ?? null,
    scope: new Map(Object.entries(config.scope ?? {}).map(([k, v]) => [String(k), { ...v }])),
  });
}

/** Everything the engine needs about one subject, from its files' contents:
 * ``subjectJson`` and ``inventoryJson`` parsed or as text; ``log`` the
 * laptop's log.jsonl and ``logs`` each device's log (in order of their file
 * names), each as text or a list of entries. The logs are merged by time. */
export function subjectData({ slug, subjectJson, inventoryJson, log, logs = [] }) {
  const subject = parseSubject(slug, typeof subjectJson === 'string' ? JSON.parse(subjectJson) : subjectJson);
  const inventory = loadInventory(typeof inventoryJson === 'string' ? JSON.parse(inventoryJson) : inventoryJson);
  const entries = mergeLogs([log, ...logs].map((l) => (typeof l === 'string' ? readLog(l) : [...(l || [])])));
  return {
    subject,
    inventory, // every point
    scheduled: subject.scheduled(inventory), // the points in scope
    entries,
    state: replay(entries, subject.model),
  };
}

/** subjects/reviews.json (parsed or text), checked; {} when there is none. */
export function parseReviews(config) {
  if (config == null) return {};
  const cfg = typeof config === 'string' ? JSON.parse(config) : config;
  const unknown = Object.keys(cfg).filter((k) => k !== 'defaults' && k !== 'overrides').sort();
  if (unknown.length) throw new Error(`${REVIEWS}: unknown key(s) ${unknown.join(', ')}`);
  return cfg;
}

/** The subject's weight for automatic review choice: its override, else its
 * collection's default, else 1 for top-level subjects and 0 for the rest.
 * true and false read as 1 and 0. 0 means never chosen. */
export function reviewWeight(subject, config = {}) {
  const overrides = config.overrides ?? {};
  const defaults = config.defaults ?? {};
  let value;
  if (subject.slug in overrides) value = overrides[subject.slug];
  else if (subject.collection in defaults) value = defaults[subject.collection];
  else value = subject.collection === TOP ? 1 : 0;
  if (typeof value === 'boolean') value = value ? 1 : 0;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${REVIEWS}: weight for ${subject.slug} is ${JSON.stringify(value)}, not a number`);
  }
  if (value < 0) throw new Error(`${REVIEWS}: weight for ${subject.slug} is negative`);
  return value;
}

/** ``config`` with ``subject``'s weight set to ``weight``: an override, or
 * none when the weight is its collection's default anyway. ``subject`` needs
 * only slug and collection. */
export function withWeight(config, subject, weight) {
  if (typeof weight !== 'number' || Number.isNaN(weight) || weight < 0) {
    throw new Error(`a weight must be a number of at least 0, not ${JSON.stringify(weight)}`);
  }
  const overrides = { ...(config.overrides ?? {}) };
  delete overrides[subject.slug];
  const out = { ...config, overrides };
  if (reviewWeight(subject, out) !== weight) overrides[subject.slug] = weight;
  return out;
}

/** reviews.json's text, laid out as the hand-written file is: one line per
 * top-level key. */
export function reviewsText(config) {
  const inline = (obj) => '{' + Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + '}';
  const lines = Object.entries(config).map(([k, v]) => `  ${JSON.stringify(k)}: ${v && typeof v === 'object' ? inline(v) : JSON.stringify(v)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

/** Slugs named in the overrides that match no subject (typos). */
export function unknownOverrides(config, slugs) {
  const known = new Set(slugs);
  return Object.keys(config.overrides ?? {}).filter((s) => !known.has(s)).sort();
}
