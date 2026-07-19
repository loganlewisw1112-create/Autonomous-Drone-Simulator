import { useEffect } from 'react'

type WakeLockSentinelLike = { release: () => Promise<void> } | null

// Keeps the phone screen on while a mission is running (field-deployment UX:
// the console must not sleep mid-flight). Silent no-op where the Wake Lock API
// is unavailable (iOS Safari < 16.4, http:// LAN dev). Re-acquires after the
// tab returns to the foreground — the OS auto-releases locks on hide.
export function useWakeLock(active: boolean) {
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } }
    if (!active || !nav.wakeLock) return

    let sentinel: WakeLockSentinelLike = null
    let disposed = false

    const acquire = async () => {
      try {
        sentinel = await nav.wakeLock!.request('screen')
        if (disposed) await sentinel?.release()
      } catch {
        // Denied (low battery, hidden tab) — non-fatal by design.
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel?.release().catch(() => {})
    }
  }, [active])
}
