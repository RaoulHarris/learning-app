// Small helpers shared by the engine modules.

/** Order two sort keys: numbers, strings, booleans (false first), or arrays of
 * them compared element by element. Returns -1, 0 or 1. */
export function compare(a, b) {
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compare(a[i], b[i]);
      if (c) return c;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  }
  if (typeof a === 'boolean') a = a ? 1 : 0;
  if (typeof b === 'boolean') b = b ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The first element with the smallest key, or null if there are none. */
export function minBy(xs, key) {
  let best = null;
  let bestKey = null;
  for (const x of xs) {
    const k = key(x);
    if (best === null || compare(k, bestKey) < 0) {
      best = x;
      bestKey = k;
    }
  }
  return best;
}

export function sum(xs) {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

/** The middle value; the mean of the two middle values for an even count. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) throw new Error('no median of nothing');
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A question or round number in ids: at least ``width`` digits. */
export function pad(n, width) {
  return String(n).padStart(width, '0');
}
