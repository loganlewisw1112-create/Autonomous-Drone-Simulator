import { describe, expect, it, vi } from 'vitest'
import { AUTHORED_SYMBOL_LAYERS, OPENFREEMAP_SERVED_FONTS, createResourceErrorReporter } from '@/components/TacticalMap'

/**
 * Regression guard for audit finding F-07.
 *
 * Symptom: the production map requested
 * `https://tiles.openfreemap.org/fonts/Open Sans Regular,Arial Unicode MS Regular/0-255.pbf`
 * (and every other range) on each label render, got a 404 every time, rendered blank labels,
 * and logged one console error per glyph range.
 *
 * Cause: our `operational-point-label` symbol layer omitted `text-font`, so MapLibre fell back
 * to its built-in default stack `["Open Sans Regular", "Arial Unicode MS Regular"]` — a stack
 * the OpenFreeMap glyph server does not hold. It only serves the stacks the liberty base style
 * itself uses.
 *
 * The allowlist (OPENFREEMAP_SERVED_FONTS) was verified against the live glyph endpoint on
 * 2026-08-14: `HEAD https://tiles.openfreemap.org/fonts/<url-encoded stack>/0-255.pbf` returned
 * 200 for "Noto Sans Regular", "Noto Sans Bold" and "Noto Sans Italic", and 404 for the MapLibre
 * default stack. Re-verify the same way (any HTTP client will do) before extending either list.
 */
describe('authored symbol layers use fonts OpenFreeMap actually serves (F-07)', () => {
  const servedFonts: readonly string[] = OPENFREEMAP_SERVED_FONTS

  it('every authored symbol layer declares text-font explicitly', () => {
    // An omitted text-font is the bug itself: MapLibre silently substitutes its default stack,
    // which 404s on OpenFreeMap. Empty stacks are equally invalid.
    AUTHORED_SYMBOL_LAYERS.forEach((layer) => {
      const stack = layer.layout['text-font']
      expect(stack, `layer "${layer.id}" must author text-font`).toBeDefined()
      expect(stack.length, `layer "${layer.id}" text-font must not be empty`).toBeGreaterThan(0)
    })
  })

  it('every authored font is in the verified-served allowlist', () => {
    const authoredFonts = AUTHORED_SYMBOL_LAYERS.flatMap((layer) => layer.layout['text-font'] ?? [])
    authoredFonts.forEach((font) => {
      expect(servedFonts, `"${font}" is not a font the OpenFreeMap glyph server serves`).toContain(font)
    })
  })

  it('the MapLibre default stack never sneaks into the allowlist', () => {
    // If someone "fixes" a 404 by allowlisting the failing stack instead of changing the layer,
    // this fails loudly.
    expect(servedFonts).not.toContain('Open Sans Regular')
    expect(servedFonts).not.toContain('Arial Unicode MS Regular')
  })
})

describe('resource error aggregation (F-07)', () => {
  it('reports a degraded-map condition exactly once, however many resources fail', () => {
    const warn = vi.fn()
    const report = createResourceErrorReporter(warn)

    // MapLibre fires one error per glyph range — simulate the flood.
    report('glyphs 0-255 404')
    report('glyphs 256-511 404')
    report('glyphs 8192-8447 404')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('basemap retained')
    expect(warn.mock.calls[0][0]).toContain('glyphs 0-255 404')
  })

  it('each map instance gets its own reporter', () => {
    // A remount (new map) is a fresh degraded-map condition and may warn again.
    const warnA = vi.fn()
    const warnB = vi.fn()
    createResourceErrorReporter(warnA)('tile 404')
    createResourceErrorReporter(warnB)('sprite 404')
    expect(warnA).toHaveBeenCalledTimes(1)
    expect(warnB).toHaveBeenCalledTimes(1)
  })
})
