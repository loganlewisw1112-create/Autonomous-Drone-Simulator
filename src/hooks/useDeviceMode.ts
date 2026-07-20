import { useEffect, useState } from 'react'
import { APP_TARGET, type AppTarget } from '@/platform/appTarget'

export type DeviceMode = 'desktop' | 'phone-portrait' | 'phone-landscape'

// A "phone" is a coarse-pointer device whose short side is under this. Tablets
// (iPad ~768px short side) intentionally fall through to the desktop layout —
// the desktop grid already works there and stays frozen.
const PHONE_SHORT_SIDE_PX = 700

// On the phone-only mobile deployment, a device whose short side reaches this is
// a tablet: it still runs the mobile shell (never the frozen desktop grid), but
// gets a roomier tablet sizing tier layered on top via `mobile-shell--tablet`.
// This is an ORTHOGONAL flag, deliberately NOT a DeviceMode value — it changes
// only CSS sizing, so the desktop/phone map-fit and badge logic stay untouched.
const TABLET_MIN_SHORT_SIDE_PX = 700

export function computeDeviceMode(target: AppTarget = APP_TARGET): DeviceMode {
  // Deployed editions are intentionally independent: the Windows build always
  // uses the desktop console, while the mobile build always uses mobile chrome.
  if (target === 'windows') return 'desktop'
  if (target === 'mobile') {
    // The mobile deployment (VITE_APP_TARGET=mobile in that Vercel project's dashboard —
    // see src/platform/appTarget.ts) is phone-only BY DESIGN: unlike the 'universal' branch
    // below, there is no short-side/tablet-size check here. Any device that loads the mobile
    // URL — including a tablet — gets the landscape phone shell, never the desktop grid.
    if (typeof window === 'undefined') return 'phone-portrait'
    return window.innerWidth >= window.innerHeight ? 'phone-landscape' : 'phone-portrait'
  }

  // jsdom / SSR safety: no matchMedia → desktop (all existing tests unaffected)
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'desktop'
  const coarse = window.matchMedia('(pointer: coarse)').matches
  const shortSide = Math.min(window.innerWidth, window.innerHeight)
  if (!coarse || shortSide >= PHONE_SHORT_SIDE_PX) return 'desktop'
  return window.innerWidth >= window.innerHeight ? 'phone-landscape' : 'phone-portrait'
}

// True only on the mobile deployment when the viewport is tablet-sized. Scoped to
// the mobile target so the frozen desktop/universal path (where tablets already
// render the desktop grid) is completely unaffected — LAW.1.
export function computeIsTablet(target: AppTarget = APP_TARGET): boolean {
  if (target !== 'mobile') return false
  if (typeof window === 'undefined') return false
  return Math.min(window.innerWidth, window.innerHeight) >= TABLET_MIN_SHORT_SIDE_PX
}

// Re-evaluates on orientation flip and resize. Uses matchMedia change events
// (screen.orientation.lock is unsupported in iOS Safari — hence a gate, not a lock)
// plus a plain resize listener for the iOS URL-bar collapse case.
export function useDeviceMode(): DeviceMode {
  const [mode, setMode] = useState<DeviceMode>(() => computeDeviceMode(APP_TARGET))

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const queries = [
      window.matchMedia('(orientation: landscape)'),
      window.matchMedia('(pointer: coarse)'),
    ]
    const update = () => setMode(computeDeviceMode(APP_TARGET))
    queries.forEach((q) => q.addEventListener?.('change', update))
    window.addEventListener('resize', update)
    return () => {
      queries.forEach((q) => q.removeEventListener?.('change', update))
      window.removeEventListener('resize', update)
    }
  }, [])

  return mode
}

// Companion to useDeviceMode for the tablet sizing tier. Re-evaluates on the same
// resize/orientation signals so a rotate or window resize flips it live.
export function useIsTablet(): boolean {
  const [isTablet, setIsTablet] = useState<boolean>(() => computeIsTablet(APP_TARGET))

  useEffect(() => {
    const update = () => setIsTablet(computeIsTablet(APP_TARGET))
    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia('(orientation: landscape)')
      : null
    media?.addEventListener?.('change', update)
    window.addEventListener('resize', update)
    return () => {
      media?.removeEventListener?.('change', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return isTablet
}
