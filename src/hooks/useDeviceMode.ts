import { useEffect, useState } from 'react'

export type DeviceMode = 'desktop' | 'phone-portrait' | 'phone-landscape'

// A "phone" is a coarse-pointer device whose short side is under this. Tablets
// (iPad ~768px short side) intentionally fall through to the desktop layout —
// the desktop grid already works there and stays frozen.
const PHONE_SHORT_SIDE_PX = 700

export function computeDeviceMode(): DeviceMode {
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
  const [mode, setMode] = useState<DeviceMode>(computeDeviceMode)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const queries = [
      window.matchMedia('(orientation: landscape)'),
      window.matchMedia('(pointer: coarse)'),
    ]
    const update = () => setMode(computeDeviceMode())
    queries.forEach((q) => q.addEventListener?.('change', update))
    window.addEventListener('resize', update)
    return () => {
      queries.forEach((q) => q.removeEventListener?.('change', update))
      window.removeEventListener('resize', update)
    }
  }, [])

  return mode
}
