// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { computeDeviceMode, computeIsTablet } from '@/hooks/useDeviceMode'

type MqlStub = Pick<MediaQueryList, 'matches' | 'media'> & {
  addEventListener: () => void
  removeEventListener: () => void
}

function stubMatchMedia(matching: Record<string, boolean>) {
  vi.stubGlobal('matchMedia', (query: string): MqlStub => ({
    matches: Object.entries(matching).some(([frag, on]) => on && query.includes(frag)),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  // vi.stubGlobal targets globalThis; jsdom window shares it.
  window.matchMedia = globalThis.matchMedia
}

function stubViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

describe('computeDeviceMode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to desktop when matchMedia is unavailable (jsdom baseline)', () => {
    // @ts-expect-error simulate a browser without matchMedia
    delete window.matchMedia
    expect(computeDeviceMode()).toBe('desktop')
  })

  it('reports phone-portrait for a coarse-pointer phone held upright', () => {
    stubMatchMedia({ 'pointer: coarse': true })
    stubViewport(390, 844)
    expect(computeDeviceMode()).toBe('phone-portrait')
  })

  it('reports phone-landscape once the phone is rotated', () => {
    stubMatchMedia({ 'pointer: coarse': true })
    stubViewport(844, 390)
    expect(computeDeviceMode()).toBe('phone-landscape')
  })

  it('treats fine-pointer devices as desktop regardless of window size', () => {
    stubMatchMedia({ 'pointer: coarse': false })
    stubViewport(390, 844)
    expect(computeDeviceMode()).toBe('desktop')
  })

  it('treats tablets (short side >= 700px) as desktop so the frozen grid is used', () => {
    stubMatchMedia({ 'pointer: coarse': true })
    stubViewport(1024, 768)
    expect(computeDeviceMode()).toBe('desktop')
  })
})

describe('computeIsTablet', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is true on the mobile target when the short side reaches the tablet threshold', () => {
    stubViewport(1112, 834) // iPad landscape
    expect(computeIsTablet('mobile')).toBe(true)
    stubViewport(834, 1112) // iPad portrait
    expect(computeIsTablet('mobile')).toBe(true)
  })

  it('is false on the mobile target for phone-sized viewports', () => {
    stubViewport(844, 390)
    expect(computeIsTablet('mobile')).toBe(false)
    stubViewport(390, 844)
    expect(computeIsTablet('mobile')).toBe(false)
  })

  it('is always false off the mobile target so desktop/universal stay frozen', () => {
    stubViewport(1112, 834)
    expect(computeIsTablet('windows')).toBe(false)
    expect(computeIsTablet('universal')).toBe(false)
  })
})
