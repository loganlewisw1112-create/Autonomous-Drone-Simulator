import { describe, it, expect } from 'vitest'
import { mulberry32, randInt, randFloat } from '@/utils/rng'

describe('mulberry32', () => {
  it('produces same sequence for same seed', () => {
    const rng1 = mulberry32(42)
    const rng2 = mulberry32(42)
    const seq1 = Array.from({ length: 100 }, () => rng1())
    const seq2 = Array.from({ length: 100 }, () => rng2())
    expect(seq1).toEqual(seq2)
  })

  it('produces different sequences for different seeds', () => {
    const rng1 = mulberry32(42)
    const rng2 = mulberry32(43)
    const v1 = rng1()
    const v2 = rng2()
    expect(v1).not.toEqual(v2)
  })

  it('always returns values in [0, 1)', () => {
    const rng = mulberry32(99)
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('randInt stays within bounds', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 500; i++) {
      const v = randInt(rng, 0, 10)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(10)
    }
  })

  it('randFloat stays within bounds', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 500; i++) {
      const v = randFloat(rng, -5, 5)
      expect(v).toBeGreaterThanOrEqual(-5)
      expect(v).toBeLessThan(5)
    }
  })
})
