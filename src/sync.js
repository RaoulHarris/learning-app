// Syncing with the data repo: fetch what changed, push what this device wrote.
//
// A device only ever writes its own files, so pushes never clash with each
// other's content: its answers (subjects/<slug>/logs/<device>.jsonl), the
// rounds it started (subjects/<slug>/rounds/<device>-<n>/) and its requests
// (subjects/<slug>/requests/<device>.jsonl). If the branch moved between
// reading it and pushing (the laptop pushed), the sync simply starts again
// from the new head.
//
// What is fetched, by blob sha (a file is fetched again only when it changed):
//   1. every subject's subject.json, inventory.json, logs, requests and
//      topups/ready.json, and subjects/reviews.json;
//   2. then, from those, the top-up batches that are ready, and the rounds
//      numbered by the laptop that still hold a missed question of their own
//      (one that may come back); nothing else under rounds/.

import { MISSED, status, uses } from '../engine/ahead.js';
import { mergeLogs, readLog } from '../engine/store.js';
import { nowTs } from '../engine/time.js';
import { Conflict, blobSha } from './github.js';

export const ROOT = 'subjects';
const ATTEMPTS = 3;
const PARALLEL = 6;

/** The subject folders among ``paths``, as the Python finds them
 * (subject.slugs): subjects/<x> with a subject.json, else subjects/<x>/<y>;
 * names starting with "_" are skipped. Top-level ones first, each group sorted. */
export function subjectFolders(paths) {
  const top = new Set();
  const nested = new Set();
  for (const p of paths) {
    const parts = p.split('/');
    if (parts[0] !== ROOT || parts[parts.length - 1] !== 'subject.json') continue;
    if (parts.length === 3 && !parts[1].startsWith('_')) top.add(parts[1]);
    if (parts.length === 4 && !parts[1].startsWith('_') && !parts[2].startsWith('_')) nested.add(`${parts[1]}/${parts[2]}`);
  }
  const nestedOk = [...nested].filter((n) => !top.has(n.split('/')[0]));
  return [...[...top].sort(), ...nestedOk.sort()].map((s) => `${ROOT}/${s}`);
}

const LOG_FILE = /^(logs|requests)\/[^/]+\.jsonl$/;

/** Step 1: what every subject needs whatever else is there. */
export function firstPaths(paths) {
  const want = new Set();
  if (paths.includes(`${ROOT}/reviews.json`)) want.add(`${ROOT}/reviews.json`);
  for (const folder of subjectFolders(paths)) {
    for (const p of paths) {
      if (!p.startsWith(folder + '/')) continue;
      const rest = p.slice(folder.length + 1);
      if (['subject.json', 'inventory.json', 'log.jsonl', 'topups/ready.json'].includes(rest) || LOG_FILE.test(rest)) {
        want.add(p);
      }
    }
  }
  return want;
}

/** ``base`` with ``texts`` appended, leaving out those already at its end:
 * if the app closed after a push but before clearing the outbox, the first
 * records are in the file already (a push sends them all at once). */
export function appendOnce(base, texts) {
  for (let k = texts.length; k > 0; k--) {
    if (base.endsWith(texts.slice(0, k).join(''))) return base + texts.slice(k).join('');
  }
  return base + texts.join('');
}

/** The files' texts with the outbox laid over them: what this device wrote
 * and has not pushed yet. */
export function overlay(texts, outbox) {
  const out = new Map(texts);
  const byPath = new Map();
  for (const r of [...outbox].sort((a, b) => a.id - b.id)) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  for (const [path, records] of byPath) {
    let text = out.get(path);
    let appends = [];
    const flush = () => {
      if (appends.length) text = appendOnce(text ?? '', appends);
      appends = [];
    };
    for (const r of records) {
      if (r.mode === 'put') {
        appends = [];
        text = r.text;
      } else appends.push(r.text);
    }
    flush();
    out.set(path, text);
  }
  return out;
}

/** Step 2: the ready top-up batches, and the laptop's rounds that hold a
 * missed question of their own, given the texts fetched in step 1. */
export function secondPaths(paths, texts) {
  const have = new Set(paths);
  const want = new Set();
  for (const folder of subjectFolders(paths)) {
    let ready = {};
    try { ready = JSON.parse(texts.get(`${folder}/topups/ready.json`) ?? '{}'); } catch (exc) { /* none */ }
    for (const name of Object.keys(ready)) {
      for (const f of ['brief.json', 'questions.json']) {
        const p = `${folder}/topups/${name}/${f}`;
        if (have.has(p)) want.add(p);
      }
    }
    const logs = [...texts.keys()].filter((p) => p === `${folder}/log.jsonl` || (p.startsWith(`${folder}/logs/`) && p.endsWith('.jsonl')));
    const entries = mergeLogs(logs.sort().map((p) => readLog(texts.get(p))));
    for (const [qid, use] of uses(entries)) {
      const m = /^(r\d{4,})-q\d+$/.exec(qid);
      if (!m || status(use) !== MISSED || use.noted) continue;
      for (const f of ['brief.json', 'questions.json']) {
        const p = `${folder}/rounds/${m[1]}/${f}`;
        if (have.has(p)) want.add(p);
      }
    }
  }
  return want;
}

async function inBatches(xs, fn) {
  for (let i = 0; i < xs.length; i += PARALLEL) await Promise.all(xs.slice(i, i + PARALLEL).map(fn));
}

/** Fetch the wanted files whose sha differs from the copy kept here. */
async function fetchChanged(gh, local, listing, wanted, progress) {
  const cached = new Map((await local.files.all()).map((f) => [f.path, f]));
  const todo = listing.filter((e) => wanted.has(e.path) && cached.get(e.path)?.sha !== e.sha);
  let n = 0;
  await inBatches(todo, async (e) => {
    const text = await gh.blob(e.sha);
    await local.files.putMany([{ path: e.path, sha: e.sha, text }]);
    n += 1;
    progress(`fetching ${n} of ${todo.length}`);
  });
  return todo.length;
}

/** Push the outbox as one commit on ``head``. Returns how many records went. */
async function push(gh, local, head, device) {
  const records = (await local.outbox.all()).sort((a, b) => a.id - b.id);
  if (!records.length) return 0;
  const byPath = new Map();
  for (const r of records) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  const files = [];
  for (const [path, rs] of byPath) {
    const base = (await local.files.get(path))?.text;
    const text = overlay(new Map(base === undefined ? [] : [[path, base]]), rs).get(path);
    if (text !== base) files.push({ path, text });
  }
  if (files.length) {
    const answers = records.filter((r) => r.path.includes('/logs/')).reduce((n, r) => n + r.text.split('\n').filter(Boolean).length, 0);
    await gh.commit({ head, files, message: `From ${device}: ${answers} log line(s), ${files.length} file(s)` });
  }
  await local.outbox.settle(records.map((r) => r.id), files.map((f) => ({ path: f.path, sha: blobSha(f.text), text: f.text })));
  return records.length;
}

/**
 * One sync: fetch what changed, then push the outbox. Starts again from the
 * new head if the branch moved meanwhile. ``keep``: more paths to fetch and
 * keep (the files of a round this device has not finished). ``progress``
 * hears what it is doing. Returns {fetched, pushed, at}.
 */
export async function sync({ gh, local, device, keep: extra = [], progress = () => {} }) {
  let fetched = 0;
  for (let attempt = 1; ; attempt++) {
    progress('reading the repository');
    const head = await gh.head();
    const listing = await gh.tree(head.tree);
    const paths = listing.map((e) => e.path);
    const first = firstPaths(paths);
    fetched += await fetchChanged(gh, local, listing, first, progress);
    const texts = overlay(new Map((await local.files.all()).map((f) => [f.path, f.text])), await local.outbox.all());
    const second = secondPaths(paths, texts);
    for (const p of extra) second.add(p);
    fetched += await fetchChanged(gh, local, listing, second, progress);
    // Forget copies of files no longer wanted (or gone), keeping this
    // device's own files until they are pushed.
    const keep = new Set([...first, ...second]);
    const pending = new Set((await local.outbox.all()).map((r) => r.path));
    const stale = (await local.files.all()).map((f) => f.path).filter((p) => !keep.has(p) && !pending.has(p));
    if (stale.length) await local.files.deleteMany(stale);
    try {
      progress('sending');
      const pushed = await push(gh, local, head, device);
      const result = { fetched, pushed, at: nowTs() };
      await local.kv.set('lastSync', result);
      return result;
    } catch (exc) {
      if (!(exc instanceof Conflict) || attempt >= ATTEMPTS) throw exc;
    }
  }
}
