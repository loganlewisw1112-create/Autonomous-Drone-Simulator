import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { useDebugHudStore } from '@/debug/hudState'
import { getRunDebugTaint, subscribeRunDebugTaint } from '@/debug/taint'

// Fixed corner readout for the admin debug console: tick, sim speed, FPS, frame time, drone
// count, and a DEBUG badge once the run is tainted. Shown only while `hud on` is set.

interface FrameStats { fps: number; frameMs: number }

function useFrameStats(active: boolean): FrameStats {
  const [stats, setStats] = useState<FrameStats>({ fps: 0, frameMs: 0 })
  const lastRef = useRef(0)
  const timesRef = useRef<number[]>([])

  useEffect(() => {
    if (!active) return undefined
    let raf = 0
    lastRef.current = performance.now()
    timesRef.current = []
    const frame = (now: number) => {
      const delta = now - lastRef.current
      lastRef.current = now
      // Ignore backgrounded-tab gaps so they do not read as a 1 FPS stall.
      if (delta > 0 && delta < 500) {
        timesRef.current.push(delta)
        if (timesRef.current.length > 60) timesRef.current.shift()
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    const timer = setInterval(() => {
      const times = timesRef.current
      if (times.length === 0) return
      const avg = times.reduce((sum, t) => sum + t, 0) / times.length
      setStats({ fps: Math.round(1000 / avg), frameMs: Math.round(avg * 10) / 10 })
    }, 500)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(timer)
    }
  }, [active])

  return stats
}

export function DebugHud() {
  const enabled = useDebugHudStore((s) => s.enabled)
  const { tick, simSpeed, droneCount } = useDroneStore(
    useShallow((s) => ({ tick: s.tick, simSpeed: s.ui.simSpeed, droneCount: s.drones.length })),
  )
  const taint = useSyncExternalStore(subscribeRunDebugTaint, getRunDebugTaint, getRunDebugTaint)
  const { fps, frameMs } = useFrameStats(enabled)

  if (!enabled) return null

  return (
    <div
      data-testid="debug-hud"
      role="status"
      aria-label="Debug readout"
      style={{
        position: 'fixed',
        top: 8,
        left: 8,
        zIndex: 10_000,
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        padding: '3px 8px',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-min)',
        lineHeight: 1.3,
        color: 'var(--text-primary, #dde)',
        background: 'var(--bg-panel, rgba(10,14,20,0.88))',
        border: '1px solid #ffffff22',
        borderRadius: 'var(--radius-sm, 3px)',
        pointerEvents: 'none',
      }}
    >
      <span>tick {tick}</span>
      <span>{simSpeed}x</span>
      <span>{fps} fps</span>
      <span>{frameMs} ms</span>
      <span>{droneCount} drones</span>
      {taint ? (
        <span
          data-testid="debug-hud-badge"
          title={`Run modified by ${taint.reasons.length} debug command(s); excluded from analytics`}
          style={{ color: '#fff', background: '#b3261e', padding: '0 6px', borderRadius: 3, fontWeight: 700 }}
        >
          DEBUG
        </span>
      ) : null}
    </div>
  )
}
