// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const device = vi.hoisted(() => ({ mode: 'desktop' as 'desktop' | 'phone-portrait' | 'phone-landscape' }))

vi.mock('@/hooks/useDeviceMode', () => ({ useDeviceMode: () => device.mode, useIsTablet: () => false }))
vi.mock('@/licensing/usagePolicy', async (importActual) => {
  const actual = await importActual<typeof import('@/licensing/usagePolicy')>()
  return { ...actual, USAGE_POLICY: actual.buildUsagePolicy('public_demo') }
})

import { UsagePolicyGate, POLICY_BANNER_HEIGHT_VAR } from '@/licensing/UsagePolicyGate'
import { BuildInfoFooter } from '@/components/BuildInfoFooter'

const bannerHeightVar = () => document.documentElement.style.getPropertyValue(POLICY_BANNER_HEIGHT_VAR)

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  disconnected = false
  constructor(private readonly cb: () => void) { FakeResizeObserver.instances.push(this) }
  observe() { /* driven manually via fire() */ }
  disconnect() { this.disconnected = true }
  fire() { this.cb() }
}

let bannerBottom = 0

beforeEach(() => {
  device.mode = 'desktop'
  bannerBottom = 0
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const bottom = this.dataset.testid === 'usage-policy-banner' ? bannerBottom : 0
    return { x: 0, y: 0, left: 0, top: 0, width: 300, height: bottom, right: 300, bottom, toJSON: () => ({}) }
  })
  document.documentElement.style.removeProperty(POLICY_BANNER_HEIGHT_VAR)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty(POLICY_BANNER_HEIGHT_VAR)
})

describe('PolicyBanner on phone chrome', () => {
  it('desktop default: no offset variable, no pointer-events override, no observer', () => {
    render(<UsagePolicyGate><div /></UsagePolicyGate>)
    const banner = screen.getByTestId('usage-policy-banner')
    expect(bannerHeightVar()).toBe('')
    expect(banner.style.pointerEvents).toBe('')
    expect(banner.dataset.phone).toBeUndefined()
    expect(banner.style.top).toBe('6px')
    expect(FakeResizeObserver.instances).toHaveLength(0)
  })

  it('phone: publishes the measured banner bottom on <html> and re-publishes when it resizes', () => {
    device.mode = 'phone-portrait'
    bannerBottom = 58.2
    render(<UsagePolicyGate><div /></UsagePolicyGate>)
    expect(bannerHeightVar()).toBe('59px')
    expect(FakeResizeObserver.instances).toHaveLength(1)

    bannerBottom = 31
    act(() => FakeResizeObserver.instances[0].fire())
    expect(bannerHeightVar()).toBe('31px')
  })

  it('phone: the link-free banner lets taps through, and the variable is removed on unmount', () => {
    device.mode = 'phone-landscape'
    bannerBottom = 30
    const { unmount } = render(<UsagePolicyGate><div /></UsagePolicyGate>)
    const banner = screen.getByTestId('usage-policy-banner')
    expect(banner.dataset.phone).toBe('true')
    expect(banner.style.pointerEvents).toBe('none')
    expect(banner.querySelector('a, button')).toBeNull()
    unmount()
    expect(bannerHeightVar()).toBe('')
  })
})

describe('BuildInfoFooter placement', () => {
  it('default stays a fixed corner footer (desktop, classroom)', () => {
    render(<BuildInfoFooter />)
    const footer = screen.getByTestId('build-info')
    expect(footer.style.position).toBe('fixed')
    expect(footer.style.bottom).toBe('4px')
    expect(footer.dataset.placement).toBeUndefined()
  })

  it('inline (phone MORE surface) flows in the document instead of floating over the dock', () => {
    render(<BuildInfoFooter inline />)
    const footer = screen.getByTestId('build-info')
    expect(footer.style.position).toBe('')
    expect(footer.style.bottom).toBe('')
    expect(footer.dataset.placement).toBe('inline')
    expect(footer.style.pointerEvents).toBe('none')
  })
})
