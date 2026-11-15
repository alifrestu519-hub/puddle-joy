// A small seeded generator (mulberry32) so a seed always replays the same
// arena: the same seed gives the same spawns, the same shots, the same game.
export function createRandom(seed) {
  let state = seed >>> 0;
  function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    /** A float in [min, max). */
    range(min, max) {
      return min + (max - min) * next();
    },
    /** An integer in [min, max]. */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** Pick one entry of `list`. */
    pick(list) {
      return list[Math.floor(next() * list.length)];
    },
    /** A random angle in radians. */
    angle() {
      return next() * Math.PI * 2;
    },
  };
}
