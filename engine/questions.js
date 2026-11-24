// What a round needs from a question (learn/questions.py) to show and score
// it. The checks a questions file must pass are not ported: the laptop runs
// `learn check`, and a top-up batch says whether it passed with ``ready``.

export const SELECT = 'select';
export const SINGLE = 'single';

/** A select-all-that-apply question: right only if exactly the right set is ticked. */
export function isSelect(q) {
  return q.type === SELECT;
}

/** The right option indexes, as written. */
export function answerSet(q) {
  return new Set(Array.isArray(q.answer) ? q.answer : [q.answer]);
}

/** ``choice``: an option index, or a list of them for a select question. */
export function isRight(q, choice) {
  if (choice == null) return false;
  const picked = new Set(Array.isArray(choice) ? choice : [choice]);
  const right = answerSet(q);
  return picked.size === right.size && [...picked].every((k) => right.has(k));
}

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

export function optionText(option) {
  return isObject(option) ? option.text : String(option);
}

export function optionWhy(option) {
  return isObject(option) ? (option.why ?? null) : null;
}
