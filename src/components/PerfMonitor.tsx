import { useEffect, useRef, useState } from 'react'

export function PerfMonitor() {
  const [fps, setFps] = useState<number>(0)
  const [ramMb, setRamMb] = useState<number | null>(null)
  const frameTimesRef = useRef<number[]>([])
  const rafRef = useRef<number | null>(null)
  const lastRef = useRef(performance.now())

  useEffect(() => {
    const frame = (now: number) => {
      const delta = now - lastRef.current
      lastRef.current = now
      if (delta > 0 && delta < 500) {
        frameTimesRef.current.push(delta)
        if (frameTimesRef.current.length > 60) frameTimesRef.current.shift()
      }
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)

    const statsId = setInterval(() => {
      const times = frameTimesRef.current
      if (times.length > 0) {
        const avg = times.reduce((s, d) => s + d, 0) / times.length
        setFps(Math.round(1000 / avg))
      }
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      if (mem) setRamMb(Math.round(mem.usedJSHeapSize / 1_048_576))
    }, 500)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      clearInterval(statsId)
    }
  }, [])

  return (
    <div className="perf-monitor" style={{
      position: 'absolute',
      bottom: 30,
      right: 10,
      fontFamily: 'var(--font-mono)',
      fontSize: 9,
      background: 'var(--bg-panel)',
      border: '1px solid #ffffff11',
      padding: '2px 7px',
      borderRadius: 'var(--radius-sm)',
      display: 'flex',
      gap: 8,
      zIndex: 10,
      pointerEvents: 'none',
    }}>
      <span style={{ color: 'var(--accent-green)' }}>FPS: {fps}</span>
      {ramMb !== null && <span style={{ color: 'var(--accent-yellow)' }}>RAM: {ramMb} MB</span>}
    </div>
  )
}
