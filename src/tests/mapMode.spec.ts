import { describe, expect, it } from 'vitest'
import { parseMapMode, LOCAL_DEMO_MAP_STYLE } from '@/components/TacticalMap'

describe('parseMapMode', () => {
  it('defaults to remote when no query param is present', () => {
    expect(parseMapMode('')).toBe('remote')
    expect(parseMapMode('?')).toBe('remote')
    expect(parseMapMode('?foo=bar')).toBe('remote')
  })

  it('returns fallback when ?map=fallback is set', () => {
    expect(parseMapMode('?map=fallback')).toBe('fallback')
  })

  it('does not match other map param values', () => {
    expect(parseMapMode('?map=remote')).toBe('remote')
    expect(parseMapMode('?map=local')).toBe('remote')
    expect(parseMapMode('?map=')).toBe('remote')
  })
})

describe('LOCAL_DEMO_MAP_STYLE', () => {
  it('is a valid MapLibre style version 8', () => {
    expect(LOCAL_DEMO_MAP_STYLE.version).toBe(8)
  })

  it('contains a visible background layer', () => {
    const bg = LOCAL_DEMO_MAP_STYLE.layers.find((l) => l.type === 'background')
    expect(bg).toBeDefined()
    const color = (bg?.paint as Record<string, unknown> | undefined)?.['background-color']
    expect(typeof color).toBe('string')
    expect((color as string).length).toBeGreaterThan(0)
  })
})
