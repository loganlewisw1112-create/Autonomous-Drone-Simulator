// mulberry32 — fast, deterministic 32-bit PRNG
// Same seed always produces identical sequence across runs (critical for replay).
export function mulberry32(seed: number): () => number {
  let s = seed
  return function () {
    s += 0x6d2b79f5
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Seeded integer in [min, max] inclusive
export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min
}

// Seeded float in [min, max)
export function randFloat(rng: () => number, min: number, max: number): number {
  return rng() * (max - min) + min
}
