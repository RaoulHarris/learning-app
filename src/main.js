// The app: setup, the home screen, settings, and starting or resuming a
// round. One page; the views replace each other in #app.
//
// What this device keeps in localStorage (small, and needed before
// anything else loads):
//   learn.repo, learn.token   the data repo and the token for it
//   learn.device              this browser's id, made up on first run
//   learn.active              the round this device started and has not
//                             finished: {folder, name}
//   learn.held                the answer on screen, not yet logged (the
//                             session logs an answer only when moving on,
//                             so lucky, bad, a note or undo can still change
//                             it): kept so a reload or a closed tab loses nothing
//   learn.recall              recall-first auto/on/off
// Everything else (copies of the repo's files, the outbox) is in IndexedDB.

import { RoundSession } from '../engine/session.js';
import { logLine } from '../engine/store.js';
import { subjectSummary } from '../engine/summary.js';
import { nowEpoch, nowTs } from '../engine/time.js';
import {
  INTRO, REVIEW, loadLibrary, newUnits, planRound, readFiles, reviewChoice, reviewSize, waiting,
} from './data.js';
import { GitHub } from './github.js';
import { openLocal } from './local.js';
import { esc } from './render.js';
import { playRound } from './round.js';
import { sync } from './sync.js';
import { VERSION } from './version.js';

const app = document.getElementById('app');
const KEYS = { repo: 'learn.repo', token: 'learn.token', device: 'learn.device', active: 'learn.active', held: 'learn.held', api: 'learn.api' };

function getItem(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function setItem(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (e) { /* storage blocked: settings will not persist */ }
}
const getJson = (key) => { try { return JSON.parse(getItem(key) || 'null'); } catch (e) { return null; } };
const setJson = (key, value) => setItem(key, value === null ? null : JSON.stringify(value));

/** This browser's id: six letters and digits, made up once. Its rounds are
 * <id>-1, <id>-2, ... and its answers go to logs/<id>.jsonl. */
function deviceId() {
  let id = getItem(KEYS.device);
  if (!id) {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    id = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    setItem(KEYS.device, id);
  }
  return id;
}

const device = deviceId();
let local = null;
let files = new Map();
let lib = null;
let view = 'home';
let teardown = null;
let syncing = false;
let syncError = null;
let syncNote = '';
let writes = Promise.resolve(); // log appends, in order
const openUnits = new Set(); // subjects whose new units are shown

function github() {
  const gh = new GitHub({ repo: getItem(KEYS.repo), token: getItem(KEYS.token) });
  const api = getItem(KEYS.api); // a stand-in API for testing
  if (api) {
    gh.fetchFn = (url, opts) => fetch(url.replace('https://api.github.com', api), opts);
  }
  return gh;
}

async function refresh() {
  files = await readFiles(local);
  lib = loadLibrary(files);
}

// --- syncing ------------------------------------------------------------

function activePaths() {
  const active = getJson(KEYS.active);
  if (!active) return [];
  const dir = `${active.folder}/rounds/${active.name}`;
  return [`${dir}/brief.json`, `${dir}/questions.json`];
}

async function syncNow() {
  if (syncing || !getItem(KEYS.token)) return;
  syncing = true;
  syncError = null;
  drawStatus();
  const run = () => sync({
    gh: github(), local, device, keep: activePaths(),
    progress: (text) => { syncNote = text; drawStatus(); },
  });
  try {
    await writes;
    if (navigator.locks) await navigator.locks.request('learn-sync', run);
    else await run();
  } catch (exc) {
    syncError = exc.message || String(exc);
  } finally {
    syncing = false;
    syncNote = '';
  }
  await refresh();
  if (view === 'home') drawHome();
  else drawStatus();
}

async function statusText() {
  if (syncing) return syncNote || 'syncing…';
  const pending = (await local.outbox.all()).length;
  const last = await local.kv.get('lastSync');
  const bits = [];
  if (syncError) bits.push(`not synced: ${syncError}`);
  else if (last) bits.push(`synced ${last.at.slice(11, 16)}${last.at.slice(0, 10) === nowTs().slice(0, 10) ? '' : ' on ' + last.at.slice(0, 10)}`);
  else bits.push('not synced yet');
  if (pending) bits.push(`${pending} change(s) to send`);
  return bits.join(' · ');
}

async function drawStatus() {
  const el = document.getElementById('syncStatus');
  if (el) {
    el.textContent = await statusText();
    el.classList.toggle('error', !!syncError);
  }
}

// --- the answer held on screen ------------------------------------------

function saveHeld(session) {
  const p = session.current;
  setJson(KEYS.held, p && p.outcome !== null ? { name: session.number, ...p } : null);
}

/** Put a held answer back on screen in a session made again for the same
 * round, unless it was logged meanwhile. */
function restoreHeld(session) {
  const held = getJson(KEYS.held);
  if (!held || held.name !== session.number) return;
  const k = session.queue.findIndex(([i, rep]) => i === held.index && rep === held.repeat);
  if (k < 0) return;
  session.queue.splice(k, 1);
  const { index, repeat, order, choice, outcome, note, ms } = held;
  session.current = { index, repeat, order, choice, outcome, note, ms };
}

// --- rounds -------------------------------------------------------------

function roundFiles(active) {
  const dir = `${active.folder}/rounds/${active.name}`;
  const brief = files.get(`${dir}/brief.json`);
  const questions = files.get(`${dir}/questions.json`);
  if (!brief || !questions) return null;
  return { brief: JSON.parse(brief), questions: JSON.parse(questions).questions };
}

function makeSession(subj, name, brief, questions) {
  const path = `${subj.folder}/logs/${device}.jsonl`;
  return new RoundSession({
    subject: subj.subject, number: name, brief, questions, items: subj.inventory, log: subj.entries,
    onAppend: (entries) => {
      const text = entries.map((e) => logLine(e) + '\n').join('');
      writes = writes.then(() => local.outbox.add({ path, mode: 'append', text }));
    },
  });
}

/** The round this device left unfinished: {subj, name, brief, questions,
 * left} or null (and forgotten if it is in fact finished or gone). */
function activeRound() {
  const active = getJson(KEYS.active);
  if (!active || !lib) return null;
  const subj = lib.subjects.find((s) => s.folder === active.folder);
  const round = subj && roundFiles(active);
  if (!round) {
    setJson(KEYS.active, null);
    return null;
  }
  const probe = makeSession(subj, active.name, round.brief, round.questions);
  restoreHeld(probe);
  const left = probe.queue.length + (probe.current ? 1 : 0);
  if (!left) {
    setJson(KEYS.active, null);
    setJson(KEYS.held, null);
    return null;
  }
  return { subj, name: active.name, ...round, left };
}

/** Log the unfinished round's held answer, if any, and let the round go. */
async function closeActive() {
  const a = activeRound();
  if (a) {
    const s = makeSession(a.subj, a.name, a.brief, a.questions);
    restoreHeld(s);
    s.commit();
    await writes;
  }
  setJson(KEYS.active, null);
  setJson(KEYS.held, null);
}

async function startRound(subj, kind, unit = null) {
  const a = activeRound();
  if (a && !confirm(`Round ${a.name} (${a.subj.subject.title}) is unfinished, with ${a.left} question(s) to go. `
    + 'Start a new round anyway? The unfinished one stops where you left it.')) return;
  await closeActive();
  await refresh();
  subj = lib.subjects.find((s) => s.folder === subj.folder);
  let round;
  try {
    round = planRound(lib, subj, { kind, unit, device });
  } catch (exc) {
    alert(exc.message);
    drawHome();
    return;
  }
  const dir = `${subj.folder}/rounds/${round.name}`;
  await local.outbox.add({ path: `${dir}/brief.json`, mode: 'put', text: JSON.stringify(round.brief, null, 1) + '\n' });
  await local.outbox.add({
    path: `${dir}/questions.json`, mode: 'put',
    text: JSON.stringify({ round: round.name, questions: round.questions }, null, 1) + '\n',
  });
  setJson(KEYS.active, { folder: subj.folder, name: round.name });
  setJson(KEYS.held, null);
  await refresh();
  openRound(lib.subjects.find((s) => s.folder === subj.folder), round.name, round.brief, round.questions);
}

function openRound(subj, name, brief, questions) {
  const session = makeSession(subj, name, brief, questions);
  session.start();
  restoreHeld(session);
  view = 'round';
  app.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'roundview';
  app.appendChild(root);
  teardown = playRound({
    root, session, subject: subj.subject,
    onChange: () => saveHeld(session),
    onFinished: async () => {
      setJson(KEYS.active, null);
      setJson(KEYS.held, null);
      await writes;
      syncNow();
    },
    onHome: async () => {
      saveHeld(session);
      await writes;
      await goHome();
      syncNow();
    },
  });
}

async function resume() {
  const a = activeRound();
  if (a) openRound(a.subj, a.name, a.brief, a.questions);
  else drawHome();
}

/** Ask the next top-up to write the intro round of ``units`` (comma-separated):
 * one request line per unit. */
async function request(subj, units) {
  const ts = nowTs();
  await local.outbox.add({
    path: `${subj.folder}/requests/${device}.jsonl`, mode: 'append',
    text: units.split(',').map((unit) => logLine({ type: 'intro', unit, ts }) + '\n').join(''),
  });
  await refresh();
  drawHome();
  syncNow();
}

// --- home ---------------------------------------------------------------

async function goHome() {
  if (teardown) teardown();
  teardown = null;
  view = 'home';
  await refresh();
  drawHome();
}

function topBar(title, extra = '') {
  return `<header class="top"><div><b>${esc(title)}</b></div>
    <div class="right"><span id="syncStatus" class="status"></span>
    <button class="small" id="syncBtn">sync</button>${extra}</div></header>`;
}

function subjectCard(subj, now) {
  const s = subj.subject;
  const row = subjectSummary(subj, null, now);
  const wait = waiting(subj);
  const facts = [`${row.units_in} of ${row.units_total} ${s.unit_name}s in`];
  if (row.unseen) facts.push(`${row.unseen} unseen`);
  if (row.below) facts.push(`${row.below} below target`);
  if (wait) facts.push(`<span class="warn">${wait} waiting for questions</span>`);
  const reviewable = reviewSize(subj);
  const fresh = newUnits(subj);
  const open = openUnits.has(subj.folder);
  let h = `<div class="subject" data-folder="${esc(subj.folder)}">
    <div class="name">${esc(s.title)}</div>
    <div class="facts">${facts.join(' · ')}</div>
    <div class="actions">
      <button class="small" data-act="review"${reviewable ? '' : ' disabled'}>review${reviewable ? ` (${reviewable})` : ''}</button>
      ${fresh.length ? `<button class="small${open ? ' on' : ''}" data-act="units">new ${esc(s.unit_name)}…</button>` : ''}
    </div>`;
  if (open && fresh.length) {
    h += '<table class="units">';
    for (const g of fresh) {
      const units = esc(g.units.join(','));
      let act;
      if (g.written) act = `<button class="small primary" data-act="intro" data-unit="${units}">start</button>`;
      else if (g.requested) act = '<span class="dim">asked for: in the next top-up</span>';
      else act = `<button class="small" data-act="request" data-unit="${units}">write this</button>`;
      const name = g.units.length > 1 ? `${s.unit_name}s ${g.units.join(', ')}` : `${s.unit_name} ${g.units[0]}`;
      h += `<tr><td>${esc(name)}</td><td class="dim">${g.points} points${g.written ? `, ${g.written} written` : ''}</td><td>${act}</td></tr>`;
    }
    h += '</table>';
  }
  return h + '</div>';
}

function drawHome() {
  view = 'home';
  const now = nowEpoch();
  let h = topBar('Learning', '<button class="small" id="settingsBtn">settings</button>');
  h += '<main class="home">';
  if (!lib || !lib.subjects.length) {
    h += `<div class="panel"><p>${syncing ? 'Fetching your subjects…' : 'No subjects here yet. Sync to fetch them.'}</p></div>`;
  } else {
    const a = activeRound();
    if (a) {
      h += `<div class="panel card"><div class="name">Unfinished round</div>
        <div class="facts">${esc(a.subj.subject.title)} · ${a.left} question(s) to go</div>
        <div class="actions"><button class="small primary" id="resumeBtn">resume</button></div></div>`;
    }
    const ranked = reviewChoice(lib);
    const best = ranked.length && ranked[0].why_not === null ? ranked[0] : null;
    h += '<div class="panel card"><div class="name">Review</div>';
    if (best) {
      h += `<div class="facts">The weakest now: <b>${esc(best.subject.title)}</b>, ${best.points} points, `
        + `mean predicted recall ${best.strength.toFixed(2)}</div>
        <div class="actions"><button class="small primary" id="reviewBtn">start a review round</button></div>`;
    } else {
      h += '<div class="facts">Nothing to review with the questions written so far.</div>';
    }
    h += '</div>';
    const top = lib.subjects.filter((s) => s.subject.collection === 'subjects');
    const rest = lib.subjects.filter((s) => s.subject.collection !== 'subjects');
    h += '<div class="panel">' + top.map((s) => subjectCard(s, now)).join('') + '</div>';
    const groups = [...new Set(rest.map((s) => s.subject.collection))];
    for (const g of groups) {
      h += `<details class="panel"${rest.some((s) => openUnits.has(s.folder)) ? ' open' : ''}><summary>${esc(g)}</summary>`
        + rest.filter((s) => s.subject.collection === g).map((s) => subjectCard(s, now)).join('') + '</details>';
    }
    if (lib.problems.length) {
      h += '<div class="panel"><p class="error">Could not read:</p><ul>' + lib.problems.map((p) => `<li>${esc(p)}</li>`).join('') + '</ul></div>';
    }
  }
  h += '</main>';
  app.innerHTML = h;
  wireTop();
  document.getElementById('settingsBtn').addEventListener('click', drawSettings);
  document.getElementById('resumeBtn')?.addEventListener('click', resume);
  document.getElementById('reviewBtn')?.addEventListener('click', () => {
    const ranked = reviewChoice(lib);
    if (ranked.length && ranked[0].why_not === null) {
      startRound(lib.subjects.find((s) => s.slug === ranked[0].slug), REVIEW);
    }
  });
  app.querySelectorAll('.subject button[data-act]').forEach((b) => b.addEventListener('click', () => {
    const subj = lib.subjects.find((s) => s.folder === b.closest('.subject').dataset.folder);
    const act = b.dataset.act;
    if (act === 'review') startRound(subj, REVIEW);
    else if (act === 'intro') startRound(subj, INTRO, b.dataset.unit);
    else if (act === 'request') request(subj, b.dataset.unit);
    else if (act === 'units') {
      if (openUnits.has(subj.folder)) openUnits.delete(subj.folder); else openUnits.add(subj.folder);
      drawHome();
    }
  }));
  drawStatus();
}

function wireTop() {
  document.getElementById('syncBtn')?.addEventListener('click', () => syncNow());
}

// --- setup and settings ---------------------------------------------------

const TOKEN_HELP = `<ol class="help">
  <li>On GitHub, open <b>Settings → Developer settings → Personal access tokens → Fine-grained tokens</b>
    and choose <b>Generate new token</b>.</li>
  <li>Repository access: <b>Only select repositories</b>, and pick the data repository.</li>
  <li>Permissions: <b>Contents: Read and write</b> (nothing else).</li>
  <li>Copy the token and paste it here. It stays on this device.</li></ol>`;

function drawSetup(message = '') {
  view = 'setup';
  app.innerHTML = `<header class="top"><div><b>Learning</b></div></header>
  <main class="home"><div class="panel">
    <h2>Connect this device</h2>
    <p>The app reads your subjects from a GitHub repository and writes this device's answers back to it.</p>
    <label>Repository (owner/name)<input id="repo" value="${esc(getItem(KEYS.repo) || '')}" placeholder="owner/learning" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <label>Token<input id="token" type="password" autocomplete="off" spellcheck="false"></label>
    ${TOKEN_HELP}
    <div class="actions"><button class="small primary" id="connect">connect</button></div>
    <p id="msg" class="error">${esc(message)}</p>
  </div></main>`;
  document.getElementById('connect').addEventListener('click', async () => {
    const repo = document.getElementById('repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    const token = document.getElementById('token').value.trim();
    const msg = document.getElementById('msg');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) {
      msg.textContent = 'Fill in both: the repository as owner/name, and the token.';
      return;
    }
    msg.textContent = 'Checking…';
    const gh = github();
    gh.repo = repo;
    gh.token = token;
    try {
      const info = await gh.info();
      if (!info.permissions?.push) throw new Error('the token can read the repository but not write to it');
    } catch (exc) {
      msg.textContent = exc.message;
      return;
    }
    setItem(KEYS.repo, repo);
    setItem(KEYS.token, token);
    await goHome();
    syncNow();
  });
}

async function drawSettings() {
  view = 'settings';
  const pending = (await local.outbox.all()).length;
  app.innerHTML = `${topBar('Settings', '<button class="small" id="backBtn">‹ home</button>')}
  <main class="home"><div class="panel">
    <table class="facts-table">
      <tr><td>Repository</td><td>${esc(getItem(KEYS.repo) || '')}</td></tr>
      <tr><td>This device</td><td><code>${esc(device)}</code> (its rounds are named ${esc(device)}-1, ${esc(device)}-2, …)</td></tr>
      <tr><td>Changes not yet sent</td><td>${pending}</td></tr>
      <tr><td>App version</td><td>${esc(VERSION)}</td></tr>
    </table>
    <div class="actions">
      <button class="small" id="tokenBtn">change repository or token</button>
      <button class="small" id="refetchBtn">fetch everything again</button>
    </div>
    <p class="dim">Fetching everything again replaces this device's copies of your subjects. Changes not yet sent are kept.</p>
  </div></main>`;
  wireTop();
  drawStatus();
  document.getElementById('backBtn').addEventListener('click', goHome);
  document.getElementById('tokenBtn').addEventListener('click', () => drawSetup());
  document.getElementById('refetchBtn').addEventListener('click', async () => {
    await local.files.clear();
    await goHome();
    syncNow();
  });
}

// --- start ----------------------------------------------------------------

async function main() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    local = await openLocal();
  } catch (exc) {
    app.innerHTML = `<main class="home"><div class="panel"><p class="error">This browser will not let the app keep data (${esc(exc.message)}).</p></div></main>`;
    return;
  }
  if (!getItem(KEYS.token) || !getItem(KEYS.repo)) {
    drawSetup();
    return;
  }
  await refresh();
  drawHome(); // an unfinished round shows there, to resume
  syncNow();
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden' && (await local.outbox.all()).length) syncNow();
    if (document.visibilityState === 'visible' && view === 'home') syncNow();
  });
}

main();
