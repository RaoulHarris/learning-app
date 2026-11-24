// The round screen: the laptop's round page (web/quiz.html) driven by an
// engine session in the page instead of a server. The session picks,
// scores and logs; this renders what it hands back.
//
// Keys: 1-6 answer (in a select-all question, tick and untick; enter or
// space checks the ticked set) · 0 or ? don't know · space shows the options
// when they are hidden, and moves on after the reveal · L lucky guess · B bad
// question · N note · U or backspace undoes the answer until you move on ·
// R recall-first auto/on/off. Everything is a button too, for touch.

import { esc, inlineOnly, loadMath, render, typeset } from './render.js';

const RECALL_KEY = 'learn.recall';

function days(d) {
  return d < 1 ? Math.round(d * 24) + ' h' : (d < 10 ? d.toFixed(1) : Math.round(d)) + ' d';
}

/**
 * Play ``session`` in ``root``. ``subject`` is the engine's Subject.
 * ``onChange()`` runs after anything that changes the answer held on screen
 * (to keep it across a reload); ``onFinished(result)`` when the round ends;
 * ``onHome()`` when the learner leaves it unfinished. Returns a function
 * that removes the screen's key handler.
 */
export function playRound({ root, session, subject, onChange = () => {}, onFinished = () => {}, onHome = () => {} }) {
  const MATH = subject.math;
  const UNIT = subject.unit_name;
  const Unit = UNIT.charAt(0).toUpperCase() + UNIT.slice(1);
  if (MATH) loadMath();

  root.innerHTML = `
    <header class="roundbar">
      <div><button class="small" id="homeBtn" title="Leave the round; it can be resumed">‹ home</button>
        <b>${esc(subject.title)}</b> <span id="where"></span></div>
      <div><span id="progress"></span> <button class="small" id="recallToggle" title="R">recall-first: auto</button>
        <button class="small" id="endBtn">end round</button></div>
    </header>
    <div class="bar"><i id="bar"></i></div>
    <main class="round"><div class="panel" id="panel">Loading…</div></main>`;
  const $ = (id) => root.querySelector('#' + id);
  const panel = $('panel');

  let q = null; // the question on screen
  let reveal = null; // its reveal, once answered
  let optionsShown = true;
  let shownAt = 0;
  let noteOpen = false;
  let picked = new Set(); // ticked options (shown indexes) in a select-all question
  let finished = false;
  let recallMode = 'auto';
  try { recallMode = localStorage.getItem(RECALL_KEY) || 'auto'; } catch (e) { /* private mode */ }

  function fail(exc) {
    panel.innerHTML = '<p class="error">' + esc(exc.message || String(exc)) + '</p>';
  }

  function show(data) {
    if (data.done) return summary(data);
    q = data;
    reveal = data.reveal || null;
    noteOpen = false;
    picked = new Set();
    optionsShown = reveal ? true : !wantsRecall();
    shownAt = performance.now();
    draw();
  }

  function next(current = false) {
    try {
      show(current ? session.getCurrent() : session.getNext());
      onChange();
    } catch (exc) { fail(exc); }
  }

  function wantsRecall() {
    if (recallMode === 'on') return true;
    if (recallMode === 'off') return false;
    return !!q.recall_first;
  }

  const isSelect = () => !!q && q.type === 'select';
  const inSet = (x, i) => (Array.isArray(x) ? x.includes(i) : x === i);

  function toggle(i) {
    if (!q || reveal || !optionsShown) return;
    if (picked.has(i)) picked.delete(i); else picked.add(i);
    draw();
  }

  function check() {
    if (isSelect() && picked.size) answer(Array.from(picked).sort((a, b) => a - b));
  }

  function answer(shownIndex) {
    if (!q || reveal || (!optionsShown && shownIndex !== null)) return;
    try {
      reveal = session.answer(shownIndex, Math.round(performance.now() - shownAt));
      optionsShown = true;
      onChange();
      draw();
    } catch (exc) { fail(exc); }
  }

  function undo() {
    if (!reveal) return;
    try {
      q = session.undo();
      reveal = null;
      noteOpen = false;
      picked = new Set();
      shownAt = performance.now();
      onChange();
      draw();
    } catch (exc) { fail(exc); }
  }

  function amend(outcome, note) {
    if (!reveal) return;
    try {
      reveal = session.amend(outcome, note);
      onChange();
      draw();
    } catch (exc) { fail(exc); }
  }

  function draw() {
    $('where').textContent = 'round ' + q.round + (q.kind === 'intro' ? ' · new ' + UNIT : ' · review');
    $('progress').textContent = q.answered + ' answered · ' + q.left + ' to go';
    $('bar').style.width = (100 * q.answered / (q.answered + q.left)) + '%';
    $('recallToggle').textContent = 'recall-first: ' + recallMode;
    let h = '';
    h += '<div class="tag' + (q.repeat ? ' repeat' : '') + '">'
      + (q.repeat ? 'again: you missed this one earlier' : 'question ' + q.number + ' of ' + q.total)
      + (isSelect() ? ' · select all that apply' : '') + '</div>';
    h += '<div class="stem">' + render(q.stem, MATH) + '</div>';
    if (q.diagram) h += '<div class="diagram">' + q.diagram + '</div>';
    if (!optionsShown) {
      h += '<button class="recall" id="recall">Recall the answer first, then tap here (or press <b>space</b>) to see the options.</button>';
    }
    h += '<div class="options' + (optionsShown ? '' : ' hidden') + '">';
    q.options.forEach((text, i) => {
      let cls = 'option';
      let why = '';
      if (reveal && isSelect()) {
        const right = inSet(reveal.answer, i);
        const ticked = inSet(reveal.choice, i);
        if (right) cls += ' correct' + (ticked ? '' : ' missed');
        else if (ticked) cls += ' chosen';
        const flag = right && !ticked ? '<span class="flag">missed</span>' : '';
        if (flag || (reveal.why && reveal.why[i])) {
          why = '<span class="why">' + flag + inlineOnly((reveal.why && reveal.why[i]) || '', MATH) + '</span>';
        }
      } else if (!reveal) {
        if (picked.has(i)) cls += ' picked';
      } else {
        if (i === reveal.answer) cls += ' correct';
        else if (i === reveal.choice) cls += ' chosen';
        if (reveal.why && reveal.why[i] && (i === reveal.choice || i !== reveal.answer)) {
          why = '<span class="why">' + inlineOnly(reveal.why[i], MATH) + '</span>';
        }
      }
      h += '<button class="option ' + cls + '" data-i="' + i + '"' + (reveal ? ' disabled' : '') + '>'
        + '<span class="key">' + (i + 1) + '</span><span class="body">' + inlineOnly(text, MATH) + why + '</span></button>';
    });
    h += '</div>';
    if (!reveal) {
      h += '<div class="actions">';
      if (isSelect() && optionsShown) h += '<button class="small primary" id="checkBtn"' + (picked.size ? '' : ' disabled') + '>check (enter)</button>';
      h += '<button class="small" id="dunno">don\'t know (0)</button></div>';
      h += '<div class="hint keys">' + (!optionsShown
        ? '<kbd>space</kbd> show options · <kbd>0</kbd> don\'t know'
        : isSelect()
          ? '<kbd>1</kbd>–<kbd>' + Math.min(9, q.options.length) + '</kbd> tick or untick · <kbd>enter</kbd> check · <kbd>0</kbd> don\'t know'
          : '<kbd>1</kbd>–<kbd>' + Math.min(9, q.options.length) + '</kbd> answer · <kbd>0</kbd> don\'t know') + ' · <kbd>R</kbd> recall-first auto/on/off</div>';
    } else {
      h += verdict();
      h += '<div class="explain">' + render(reveal.explanation, MATH) + '</div>';
      if (reveal.point) {
        h += '<div class="point"><span class="t">' + esc(reveal.point.title) + '</span><span class="s">' + Unit + ' '
          + esc(String(reveal.point.unit)) + (reveal.point.section ? ' · §' + esc(reveal.point.section) : '')
          + '</span><div>' + render(reveal.point.statement, MATH) + '</div></div>';
      }
      h += '<div class="actions">';
      h += '<button class="small primary" id="nextBtn">next (space)</button>';
      h += '<button class="small" id="undoBtn">undo answer (U)</button>';
      if (reveal.outcome === 'right' || reveal.outcome === 'lucky') {
        h += '<button class="small' + (reveal.outcome === 'lucky' ? ' on' : '') + '" id="lucky">lucky guess (L)</button>';
      }
      h += '<button class="small' + (reveal.outcome === 'bad' ? ' on' : '') + '" id="bad">bad question (B)</button>';
      h += '<button class="small' + (reveal.note ? ' on' : '') + '" id="noteBtn">note (N)</button>';
      h += '</div>';
      if (noteOpen) {
        h += '<textarea id="note" placeholder="What is wrong with the question, or anything Claude should know. Ctrl+Enter saves, Esc cancels.">' + esc(reveal.note || '') + '</textarea>';
        h += '<div class="actions"><button class="small" id="saveNote">save note</button></div>';
      }
    }
    panel.innerHTML = h;
    const svg = panel.querySelector('.diagram svg');
    if (svg) {
      // About 1.4x the viewBox's own units, so a small diagram is not blown
      // up to the full column width with heavy strokes.
      const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb[2] > 0) svg.style.width = Math.min(vb[2] * 1.4, 728) + 'px';
    }
    wire();
    typeset(panel);
    if (noteOpen) {
      const t = $('note');
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
  }

  function verdict() {
    const o = reveal.outcome;
    const words = { right: 'Right', wrong: 'Wrong', dunno: 'Don\'t know', lucky: 'Lucky guess: scored as wrong', bad: 'Bad question: not scored' };
    let extra = '';
    if (q.repeat) extra = 'repeat, not scored';
    else if (o !== 'bad') extra = 'memory half-life ' + (reveal.half_life_before === null ? 'new' : days(reveal.half_life_before)) + ' → ' + days(reveal.half_life_after);
    if (o === 'wrong' || o === 'dunno' || o === 'lucky') extra += ' · this question comes back later in the round';
    return '<div class="verdict ' + o + '">' + words[o] + (extra ? ' <span>· ' + extra + '</span>' : '') + '</div>';
  }

  function wire() {
    panel.querySelectorAll('.option').forEach((b) => b.addEventListener('click', () => (isSelect() ? toggle : answer)(+b.dataset.i)));
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('checkBtn', check);
    on('dunno', () => answer(null));
    on('recall', showOptions);
    on('nextBtn', () => next());
    on('undoBtn', undo);
    on('lucky', () => amend(reveal.outcome === 'lucky' ? 'unlucky' : 'lucky'));
    on('bad', () => { if (reveal.outcome === 'bad') amend('unbad'); else { noteOpen = true; amend('bad'); } });
    on('noteBtn', () => { noteOpen = !noteOpen; draw(); });
    on('saveNote', saveNote);
  }

  function showOptions() {
    if (!optionsShown) { optionsShown = true; draw(); }
  }

  function saveNote() {
    const t = $('note');
    noteOpen = false;
    amend(null, t ? t.value : '');
  }

  function delta(a, b, digits) {
    if (a === null || b === null || a === undefined) return b === null ? '–' : b.toFixed(digits);
    const d = b - a;
    const f = (x) => x.toFixed(digits);
    if (Math.abs(d) < Math.pow(10, -digits) / 2) return f(b);
    return f(a) + ' → ' + f(b) + ' <span class="' + (d > 0 ? 'up' : 'down') + '">(' + (d > 0 ? '+' : '') + f(d) + ')</span>';
  }
  const MARKS = { right: '✓', wrong: '✗', dunno: '?', lucky: '~', bad: '!' };

  function statsHtml(st) {
    const s = st.summary;
    const bits = ['<b>' + s.right_first + '/' + s.scored + '</b> right first time',
      '<b>' + s.new + '</b> new', '<b>' + s.reviewed + '</b> reviewed'];
    if (s.median_half_life_factor !== null) bits.push('half-life ×<b>' + s.median_half_life_factor.toFixed(2) + '</b> (median, reviewed)');
    if (s.active_minutes) bits.push('<b>' + s.active_minutes.toFixed(1) + '</b> min active');
    if (s.calibration) bits.push('predicted recall <b>' + s.calibration.predicted.toFixed(2) + '</b>, actual <b>' + s.calibration.actual.toFixed(2) + '</b> (n=' + s.calibration.n + ')');
    let h = '<div class="stats"><div class="line">' + bits.join(' · ') + '</div>';
    if (st.units.length) {
      h += '<h3>' + Unit + 's</h3><div class="scroll"><table><tr><th>' + UNIT + '</th><th>seen</th><th>recall, all points</th><th>recall, seen</th><th>median half-life</th><th>secure</th></tr>';
      for (const c of st.total ? st.units.concat([st.total]) : st.units) {
        const b = c.before;
        h += '<tr' + (c.unit === null ? ' class="total"' : '') + '><td>' + (c.unit === null ? 'total' : esc(String(c.unit))) + '</td><td>' + (b.seen !== c.seen ? b.seen + ' → ' : '') + c.seen + '/' + c.points + '</td>'
          + '<td>' + delta(b.recall_all, c.recall_all, 2) + '</td><td>' + delta(b.recall_seen, c.recall_seen, 2) + '</td>'
          + '<td>' + (b.median_half_life !== null && Math.abs(b.median_half_life - (c.median_half_life ?? NaN)) >= 0.05 ? days(b.median_half_life) + ' → ' : '') + (c.median_half_life === null ? '–' : days(c.median_half_life)) + '</td>'
          + '<td>' + (b.secure !== c.secure ? b.secure + ' → ' : '') + c.secure + '</td></tr>';
      }
      h += '</table></div>';
    }
    if (st.points.length) {
      h += '<h3>Points</h3><div class="scroll"><table><tr><th>point</th><th>' + UNIT + '</th><th></th><th>half-life</th><th>recall before</th></tr>';
      for (const p of st.points) {
        const hl = (p.half_life_before === null ? 'new' : days(p.half_life_before)) + ' → ' + (p.half_life_after === null ? '–' : days(p.half_life_after));
        h += '<tr><td class="title">' + esc(p.title) + '</td><td>' + (p.unit === null ? '' : esc(String(p.unit))) + '</td>'
          + '<td><span class="mark ' + p.outcome + '" title="' + p.outcome + '">' + (MARKS[p.outcome] || '') + '</span></td>'
          + '<td>' + hl + '</td><td>' + (p.recall_before === null ? '–' : p.recall_before.toFixed(2)) + '</td></tr>';
      }
      h += '</table></div>';
    }
    return h + '</div>';
  }

  function summary(data) {
    q = null;
    reveal = null;
    $('bar').style.width = '100%';
    $('progress').textContent = 'round finished';
    $('endBtn').style.display = 'none';
    $('recallToggle').style.display = 'none';
    const t = data.tally;
    const first = t.right + t.wrong + t.dunno + t.lucky;
    let h = '<div class="summary"><h2>Round finished</h2><div class="tally">';
    h += '<div><b>' + t.right + '/' + first + '</b>right first time</div>';
    if (t.wrong + t.dunno) h += '<div><b>' + (t.wrong + t.dunno) + '</b>missed</div>';
    if (t.lucky) h += '<div><b>' + t.lucky + '</b>lucky</div>';
    if (t.bad) h += '<div><b>' + t.bad + '</b>flagged bad</div>';
    h += '</div>';
    if (data.misses && data.misses.length) {
      h += '<p>Missed:</p><ul class="misses">' + data.misses.map((m) => '<li>' + esc(m.title) + '</li>').join('') + '</ul>';
    }
    if (data.stats) h += statsHtml(data.stats);
    if (data.left_unasked) h += '<p>' + data.left_unasked + ' question(s) left unasked; they stay available for later rounds.</p>';
    h += '<div class="actions"><button class="small primary" id="doneBtn">home</button></div></div>';
    panel.innerHTML = h;
    $('doneBtn').addEventListener('click', onHome);
    if (!finished) {
      finished = true;
      onFinished(data);
    }
  }

  function onKey(e) {
    if (noteOpen) {
      if (e.key === 'Escape') { noteOpen = false; draw(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote();
      return;
    }
    if (!q || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key.toUpperCase();
    if (k === 'R') { cycleRecall(); return; }
    if (!reveal) {
      if (!optionsShown) {
        if (k === ' ' || k === 'ENTER') { e.preventDefault(); showOptions(); } else if (k === '0' || k === '?') answer(null);
        return;
      }
      const i = '123456789'.indexOf(k);  // options past 9 are tapped or clicked
      if (i >= 0 && i < q.options.length) (isSelect() ? toggle : answer)(i);
      else if (k === '0' || k === '?') answer(null);
      else if (isSelect() && (k === ' ' || k === 'ENTER')) { e.preventDefault(); check(); }
      return;
    }
    if (k === ' ' || k === 'ENTER') { e.preventDefault(); next(); }
    else if (k === 'L' && (reveal.outcome === 'right' || reveal.outcome === 'lucky')) amend(reveal.outcome === 'lucky' ? 'unlucky' : 'lucky');
    else if (k === 'B') { if (reveal.outcome === 'bad') amend('unbad'); else { noteOpen = true; amend('bad'); } }
    else if (k === 'N') { e.preventDefault(); noteOpen = true; draw(); }
    else if (k === 'U' || k === 'BACKSPACE') { e.preventDefault(); undo(); }
  }

  function cycleRecall() {
    recallMode = { auto: 'on', on: 'off', off: 'auto' }[recallMode];
    try { localStorage.setItem(RECALL_KEY, recallMode); } catch (e) { /* private mode */ }
    if (q && !reveal) optionsShown = !wantsRecall();
    if (q) draw();
    else $('recallToggle').textContent = 'recall-first: ' + recallMode;
  }

  document.addEventListener('keydown', onKey);
  $('recallToggle').addEventListener('click', cycleRecall);
  $('homeBtn').addEventListener('click', onHome);
  $('endBtn').addEventListener('click', () => {
    if (!confirm('End the round now? Answers so far are kept.')) return;
    try {
      summary(session.endEarly());
      onChange();
    } catch (exc) { fail(exc); }
  });

  next(true);
  return () => document.removeEventListener('keydown', onKey);
}
