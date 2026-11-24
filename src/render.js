// Question text: Markdown-ish (paragraphs, bold, italics, code, lists,
// pipe tables) with TeX left alone for MathJax in subjects with maths (in the
// others, $ is a dollar sign). The same rules as the laptop's round page
// (web/quiz.html).

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<i>$2</i>');
}

const MATH = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?:\\\$|[^$])+?\$/g;
const SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

export function render(text, math) {
  if (!text) return '';
  const kept = [];
  let s = String(text);
  if (math) s = s.replace(MATH, (m) => { kept.push(m); return '\u0000' + (kept.length - 1) + '\u0000'; });
  s = esc(s);
  const blocks = s.split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n');
    if (lines.length >= 2 && lines.every((l) => /^\s*\|.*\|\s*$/.test(l))) {
      const cells = (l) => l.trim().slice(1, -1).split('|').map((c) => inline(c.trim()));
      const rows = lines.filter((l) => !SEPARATOR.test(l)).map(cells);
      const head = SEPARATOR.test(lines[1]) ? rows.shift() : null;
      return '<table>' + (head ? '<tr>' + head.map((c) => '<th>' + c + '</th>').join('') + '</tr>' : '')
        + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</table>';
    }
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return '<ul>' + lines.map((l) => '<li>' + inline(l.replace(/^\s*[-*]\s+/, '')) + '</li>').join('') + '</ul>';
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      return '<ol>' + lines.map((l) => '<li>' + inline(l.replace(/^\s*\d+[.)]\s+/, '')) + '</li>').join('') + '</ol>';
    }
    return '<p>' + inline(lines.join('<br>')) + '</p>';
  });
  return blocks.join('').replace(/\u0000(\d+)\u0000/g, (_, n) => esc(kept[+n]));
}

/** As render, without the paragraph around a single line. */
export function inlineOnly(text, math) {
  const html = render(text, math);
  return html.startsWith('<p>') && html.endsWith('</p>') && html.indexOf('<p>', 1) < 0 ? html.slice(3, -4) : html;
}

let mathjax = null;

/** Load MathJax (kept with the app, so it works offline), once. */
export function loadMath() {
  if (mathjax) return mathjax;
  window.MathJax = {
    tex: { inlineMath: [['$', '$'], ['\\(', '\\)']], displayMath: [['$$', '$$'], ['\\[', '\\]']] },
    svg: { fontCache: 'global' },
    startup: { typeset: false },
  };
  mathjax = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/mathjax/tex-svg-full.js', import.meta.url).href;
    script.async = true;
    script.onload = () => (window.MathJax.startup?.promise ?? Promise.resolve()).then(resolve, resolve);
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
  return mathjax;
}

/** Typeset the maths in ``el`` once MathJax is there. */
export function typeset(el) {
  if (!mathjax) return;
  mathjax.then(() => {
    if (!window.MathJax?.typesetPromise) return;
    window.MathJax.typesetClear?.([el]);
    window.MathJax.typesetPromise([el]).catch(() => {});
  });
}
