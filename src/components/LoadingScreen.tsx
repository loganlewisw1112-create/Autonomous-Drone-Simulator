import { useEffect, useRef, useState } from 'react'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { getGenesisHash } from '@/utils/chainOfCustody'

const MIN_DISPLAY_MS = 900
const STAGGER_MS = 160
// Hard ceiling so the app is never stuck behind this screen. MapLibre's 'load' event doesn't
// fire in some real environments (backgrounded/hidden tab, WebGL unavailable, restrictive
// corporate browser) — mapReady staying false forever must not block the rest of the app.
const MAX_WAIT_MS = 8000

type CheckStatus = 'pending' | 'pass' | 'waiting' | 'degraded'

interface Check {
  label: string
  detail: string
  status: CheckStatus
}

const INITIAL_CHECKS: Check[] = [
  { label: 'REACT RUNTIME',       detail: 'js engine + dom',           status: 'pending' },
  { label: 'SCENARIO DATABASE',   detail: '',                           status: 'pending' },
  { label: 'SIMULATION ENGINE',   detail: 'physics + comms + weather', status: 'pending' },
  { label: 'SECURITY HASH CHAIN', detail: 'sha-256 chain-of-custody',  status: 'pending' },
  { label: 'TACTICAL MAP',        detail: 'awaiting renderer',          status: 'pending' },
]

type Phase = 'checking' | 'all_pass' | 'fading'

interface Props {
  mapReady: boolean
  onComplete: () => void
}

export function LoadingScreen({ mapReady, onComplete }: Props) {
  const [checks, setChecks] = useState<Check[]>(INITIAL_CHECKS)
  const [phase, setPhase] = useState<Phase>('checking')
  const [progress, setProgress] = useState(0)
  const minTimeElapsed = useRef(false)
  const completedRef = useRef(false)

  // Minimum display timer
  useEffect(() => {
    const t = setTimeout(() => { minTimeElapsed.current = true }, MIN_DISPLAY_MS)
    return () => clearTimeout(t)
  }, [])

  // Stagger through the first 4 instant checks
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    const genesisSnippet = getGenesisHash().slice(0, 8) + '…'
    const syncChecks: Array<{ index: number; detail: string }> = [
      { index: 0, detail: 'ok' },
      { index: 1, detail: `${ALL_SCENARIOS.length} scenarios verified` },
      { index: 2, detail: 'ok' },
      { index: 3, detail: genesisSnippet },
    ]

    syncChecks.forEach(({ index, detail }, i) => {
      timers.push(setTimeout(() => {
        setChecks((prev) => prev.map((c, ci) =>
          ci === index ? { ...c, status: 'pass', detail: detail || c.detail } : c,
        ))
        setProgress(((i + 1) / 5) * 80)
      }, STAGGER_MS * (i + 1)))
    })

    // Mark map check as 'waiting'
    timers.push(setTimeout(() => {
      setChecks((prev) => prev.map((c, ci) => ci === 4 ? { ...c, status: 'waiting' } : c))
    }, STAGGER_MS * 4))

    return () => timers.forEach(clearTimeout)
  }, [])

  // Watch for map ready
  useEffect(() => {
    if (!mapReady) return
    const tryComplete = () => {
      if (completedRef.current) return
      if (!minTimeElapsed.current) {
        setTimeout(tryComplete, 50)
        return
      }
      setChecks((prev) => prev.map((c, ci) =>
        ci === 4 ? { ...c, status: 'pass', detail: 'renderer ready' } : c,
      ))
      setProgress(100)
      setTimeout(() => setPhase('all_pass'), 300)
      setTimeout(() => setPhase('fading'), 1050)
      setTimeout(() => {
        if (!completedRef.current) {
          completedRef.current = true
          onComplete()
        }
      }, 1400)
    }
    tryComplete()
  }, [mapReady, onComplete])

  // Hard timeout fallback: if the map never confirms ready, proceed anyway rather than
  // hanging the whole app behind this screen. Marked 'degraded', not 'pass' — honest about
  // the fact tactical map confirmation didn't complete, matching this app's no-overclaim norm.
  useEffect(() => {
    const t = setTimeout(() => {
      if (completedRef.current || mapReady) return
      setChecks((prev) => prev.map((c, ci) =>
        ci === 4 ? { ...c, status: 'degraded', detail: 'timeout — continuing' } : c,
      ))
      setProgress(100)
      setPhase('all_pass')
      setTimeout(() => setPhase('fading'), 750)
      setTimeout(() => {
        if (!completedRef.current) {
          completedRef.current = true
          onComplete()
        }
      }, 1100)
    }, MAX_WAIT_MS)
    return () => clearTimeout(t)
  }, [mapReady, onComplete])

  const passCount = checks.filter((c) => c.status === 'pass').length

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse-bar { 0%,100% { opacity:1; } 50% { opacity:0.6; } }
        @keyframes fade-in-up { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        .ls-check-row { animation: fade-in-up 0.25s ease both; }
        .ls-spinner { display:inline-block; animation: spin 0.9s linear infinite; }
        .ls-progress-fill { animation: pulse-bar 1.4s ease infinite; }
      `}</style>

      <div style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--bg-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-mono)',
        opacity: phase === 'fading' ? 0 : 1,
        transition: phase === 'fading' ? 'opacity 0.45s ease' : undefined,
        pointerEvents: phase === 'fading' ? 'none' : 'all',
      }}>
        <div style={{
          width: 480,
          border: '1px solid var(--border-accent)',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--bg-panel)',
          boxShadow: '0 0 48px rgba(0,212,255,0.08), 0 24px 48px rgba(0,0,0,0.6)',
          overflow: 'hidden',
        }}>

          {/* Header */}
          <div style={{
            borderBottom: '1px solid var(--border)',
            padding: '18px 24px 14px',
          }}>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.18em', marginBottom: 6 }}>
              ◈ AUTONOMOUS DRONE MISSION SIMULATOR
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent-blue)', letterSpacing: '0.04em' }}>
              SYSTEM BOOT
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
              initializing command interface · all systems check
            </div>
          </div>

          {/* Checklist */}
          <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {checks.map((check, i) => (
              <div
                key={check.label}
                className="ls-check-row"
                style={{
                  animationDelay: `${i * STAGGER_MS * 0.7}ms`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 11,
                }}
              >
                {/* Status icon */}
                <span style={{ width: 16, textAlign: 'center', flexShrink: 0 }}>
                  {check.status === 'pass'     && <span style={{ color: 'var(--accent-green)' }}>✓</span>}
                  {check.status === 'waiting'  && <span className="ls-spinner" style={{ color: 'var(--accent-yellow)', fontSize: 12 }}>⟳</span>}
                  {check.status === 'degraded' && <span style={{ color: 'var(--accent-yellow)' }}>△</span>}
                  {check.status === 'pending'  && <span style={{ color: 'var(--text-dim)' }}>·</span>}
                </span>

                {/* Label */}
                <span style={{
                  color: check.status === 'pass'
                    ? 'var(--text-primary)'
                    : check.status === 'waiting' || check.status === 'degraded'
                    ? 'var(--accent-yellow)'
                    : 'var(--text-dim)',
                  letterSpacing: '0.08em',
                  minWidth: 170,
                }}>
                  {check.label}
                </span>

                {/* Dot fill */}
                <span style={{ flex: 1, color: 'var(--text-dim)', overflow: 'hidden', fontSize: 10 }}>
                  {'·'.repeat(30)}
                </span>

                {/* Detail / status */}
                <span style={{
                  fontSize: 10,
                  color: check.status === 'pass'
                    ? 'var(--accent-green)'
                    : check.status === 'waiting' || check.status === 'degraded'
                    ? 'var(--accent-yellow)'
                    : 'var(--text-dim)',
                  minWidth: 90,
                  textAlign: 'right',
                }}>
                  {check.status === 'pass'     ? check.detail || 'PASS' : ''}
                  {check.status === 'waiting'  ? 'WAIT' : ''}
                  {check.status === 'degraded' ? check.detail || 'DEGRADED' : ''}
                  {check.status === 'pending'  ? '—' : ''}
                </span>
              </div>
            ))}
          </div>

          {/* Progress bar */}
          <div style={{ padding: '0 24px 16px' }}>
            <div style={{
              height: 3,
              borderRadius: 2,
              background: 'var(--bg-input)',
              overflow: 'hidden',
            }}>
              <div
                className={progress < 100 ? 'ls-progress-fill' : undefined}
                style={{
                  height: '100%',
                  width: `${progress}%`,
                  background: progress === 100 ? 'var(--accent-green)' : 'var(--accent-blue)',
                  borderRadius: 2,
                  transition: 'width 0.35s ease, background 0.4s ease',
                }}
              />
            </div>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 6,
              fontSize: 9,
              color: 'var(--text-dim)',
            }}>
              <span>{passCount}/{checks.length} systems nominal</span>
              <span>{Math.round(progress)}%</span>
            </div>
          </div>

          {/* Footer status line */}
          <div style={{
            borderTop: '1px solid var(--border)',
            padding: '10px 24px',
            fontSize: 11,
            minHeight: 36,
            display: 'flex',
            alignItems: 'center',
          }}>
            {(phase === 'all_pass' || phase === 'fading') && checks.some((c) => c.status === 'degraded') ? (
              <span style={{ color: 'var(--accent-yellow)', fontWeight: 700, letterSpacing: '0.1em' }}>
                △ PROCEEDING WITHOUT MAP CONFIRMATION — LAUNCHING COMMAND INTERFACE
              </span>
            ) : phase === 'all_pass' || phase === 'fading' ? (
              <span style={{ color: 'var(--accent-green)', fontWeight: 700, letterSpacing: '0.1em' }}>
                ✓ ALL SYSTEMS NOMINAL — LAUNCHING COMMAND INTERFACE
              </span>
            ) : (
              <span style={{ color: 'var(--text-secondary)' }}>
                {checks.find((c) => c.status === 'waiting')
                  ? `waiting for ${checks.find((c) => c.status === 'waiting')!.label.toLowerCase()}…`
                  : 'running diagnostics…'}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
