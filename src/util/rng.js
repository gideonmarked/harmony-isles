// @ts-check

/**
 * Seeded mulberry32 PRNG. Deterministic and serializable so the RNG
 * state is part of the save and replays line up exactly.
 */
export class RNG {
  /** @param {number} seed */
  constructor(seed) {
    /** @type {number} Internal 32-bit state. */
    this.state = seed >>> 0;
    /** @type {number} Number of next() calls — useful for telemetry/debug. */
    this.calls = 0;
  }

  /** @returns {number} Uniform float in [0, 1). */
  next() {
    this.calls += 1;
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Float in [min, max).
   *
   * @param {number} min
   * @param {number} max
   */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /**
   * Integer in [min, max] (inclusive on both ends).
   *
   * @param {number} min
   * @param {number} max
   */
  intRange(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /**
   * Pick a random element from an array.
   *
   * @template T
   * @param {T[]} arr
   * @returns {T}
   */
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /**
   * Weighted choice. `weighted({ a: 1, b: 3 })` returns `'b'` 75% of
   * the time and `'a'` 25% of the time.
   *
   * @param {Record<string, number>} weights
   * @returns {string}
   */
  weighted(weights) {
    const entries = Object.entries(weights);
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let r = this.next() * total;
    for (const [key, w] of entries) {
      if (r < w) return key;
      r -= w;
    }
    return entries[entries.length - 1][0];
  }

  /** @returns {{ state: number, calls: number }} */
  serialize() {
    return { state: this.state, calls: this.calls };
  }

  /** @param {{ state: number, calls: number }} s */
  static deserialize(s) {
    const r = new RNG(s.state);
    r.calls = s.calls;
    return r;
  }
}
