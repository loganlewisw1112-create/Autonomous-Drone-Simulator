// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isMacPlatform, isWindowsPlatform, resolveAppTarget } from '@/platform/appTarget'
import { computeDeviceMode } from '@/hooks/useDeviceMode'

function stubViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

describe('deployment app targets', () => {
  it('accepts only explicit mobile and windows target values', () => {
    expect(resolveAppTarget('mobile')).toBe('mobile')
    expect(resolveAppTarget('windows')).toBe('windows')
    expect(resolveAppTarget(undefined)).toBe('universal')
    expect(resolveAppTarget('desktop')).toBe('universal')
  })

  it('recognizes Windows platform and user-agent values', () => {
    expect(isWindowsPlatform('Win32', 'Mozilla/5.0')).toBe(true)
    expect(isWindowsPlatform('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true)
    expect(isWindowsPlatform('iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)')).toBe(false)
    expect(isWindowsPlatform('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe(false)
  })

  it('recognizes Mac desktops but not iPads that report a Mac user agent', () => {
    expect(isMacPlatform('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(true)
    expect(isMacPlatform('macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(true)
    expect(isMacPlatform('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(false)
    expect(isMacPlatform('iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe(false)
    expect(isMacPlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0)).toBe(false)
  })

  it('locks the Windows build to desktop mode', () => {
    stubViewport(390, 844)
    expect(computeDeviceMode('windows')).toBe('desktop')
  })

  it('locks the mobile build to its portrait and landscape shells', () => {
    stubViewport(390, 844)
    expect(computeDeviceMode('mobile')).toBe('phone-portrait')
    stubViewport(844, 390)
    expect(computeDeviceMode('mobile')).toBe('phone-landscape')
  })
})
