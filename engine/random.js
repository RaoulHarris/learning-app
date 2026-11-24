// A small seeded PRNG (mulberry32), for shuffling a review round and the
// options of a question. The Python uses random.Random (Mersenne Twister),
// which this does not reproduce: shuffled orders differ between the two.

function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return (Math.trunc(seed) ^ Math.trunc(seed / 2 ** 32)) >>> 0;
  let h = 0x811c9dc5; // FNV-1a over the string form
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** {random(), randbelow(n), shuffle(list) in place, choice(list)}. Without a
 * seed, seeded from Math.random. */
export function makeRng(seed) {
  let s = seed == null ? (Math.random() * 2 ** 32) >>> 0 : hashSeed(seed);
  function random() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const randbelow = (n) => Math.floor(random() * n);
  return {
    random,
    randbelow,
    shuffle(x) {
      for (let i = x.length - 1; i > 0; i--) {
        const j = randbelow(i + 1);
        [x[i], x[j]] = [x[j], x[i]];
      }
      return x;
    },
    choice(x) {
      if (!x.length) throw new Error('nothing to choose from');
      return x[randbelow(x.length)];
    },
  };
}
