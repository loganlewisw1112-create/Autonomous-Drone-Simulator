import { useEffect, useState } from 'react'
import { APP_TARGET, type AppTarget } from '@/platform/appTarget'

export type DeviceMode = 'desktop' | 'phone-portrait' | 'phone-landscape'

// A "phone" is a coarse-pointer device whose short side is under this. Tablets
// (iPad ~768px short side) intentionally fall through to the desktop layout —
// the desktop grid already works there and stays frozen.
const PHONE_SHORT_SIDE_PX = 700

export function computeDeviceMode(target: AppTarget = APP_TARGET): DeviceMode {
  // Deployed editions are intentionally independent: the Windows build always
  // uses the desktop console, while the mobile build always uses mobile chrome.
  if (target === 'windows') return 'desktop'
  if (target === 'mobile') {
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
