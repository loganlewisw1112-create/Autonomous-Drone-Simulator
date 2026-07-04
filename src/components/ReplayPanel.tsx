import { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/droneStore'
import { weatherSummaryLabel } from '@/sim/weather/weatherEngine'
import { buildAfterActionPackage, serializeAfterActionPackage } from '@/sim/demo/missionReport'

export function ReplayPanel() {
  const { replaySession, replayIndex, ui, scenario, scenarioVariant, drones, metrics, thermalContacts, events, elapsedSec, positionHistory, setReplayIndex, setIsReplayMode } = useDroneStore()
  const [playing, setPlaying] = useState(false)
  const [playSpeed, setPlaySpeed] = useState(1)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const frames = replaySession?.frames ?? []
  const total = frames.length

  // Playback loop — must be before any early return (Rules of Hooks)
  useEffect(() => {
    if (!playing || total === 0) return
    intervalRef.current = setInterval(() => {
      const state = useDroneStore.getState()
      const curr = state.replayIndex
      const next = curr + 1
      if (next >= total) {
        setPlaying(false)
        state.setReplayIndex(total - 1)
        return
      }
      state.setReplayIndex(next)
    }, Math.round(50 / playSpeed))
    return () => { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null } }
  }, [playing, playSpeed, total])

  // Only render when there's a replay session AND the sim has stopped
  if (total === 0 || ui.isRunning) return null

  function handleEnterReplay() {
    setIsReplayMode(true)
    setReplayIndex(0)
  }

  function handleExitReplay() {
    setPlaying(false)
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    setIsReplayMode(false)
    setReplayIndex(total - 1)
  }

  function handlePlayPause() {
    if (playing) {
      setPlaying(false)
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    } else {
      if (replayIndex >= total - 1) setReplayIndex(0)
      setPlaying(true)
    }
  }

  function handleExportAfterAction() {
    // replaySession carries the end-of-mission snapshot, so exporting while scrubbed to any
    // frame still produces the mission's FINAL state (live drones/thermal are frame-overwritten).
    const packageData = buildAfterActionPackage({
      scenario,
      scenarioVariant,
      drones,
      metrics,
      thermalContacts,
      events,
      elapsedSec,
      replayFrameCount: replaySession?.frames.length ?? 0,
      positionHistory,
      replaySession,
    })
    const blob = new Blob([serializeAfterActionPackage(packageData)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'after-action-' + (scenario?.id ?? 'mission') + '-' + Date.now() + '.json'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    window.setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1000)
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const i = Number(e.target.value)
    setPlaying(false)
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    setReplayIndex(i)
  }

  const currentFrame = frames[replayIndex]
  const lastFrame = frames[total - 1]
  const pct = total > 1 ? ((replayIndex / (total - 1)) * 100).toFixed(1) : '0'
  // Rolling buffer keeps only the last MAX_FRAMES snapshots; if frame 0 isn't tick 0, the
  // earliest mission minutes were dropped and the operator should know.
  const truncated = frames.length > 0 && frames[0].tick > 0
  const coveredDur = truncated ? formatDur((lastFrame?.elapsedSec ?? 0) - frames[0].elapsedSec) : null

  if (!ui.isReplayMode) {
    return (
      <div style={{
        position: 'fixed', bottom: 72, left: '50%', transform: 'translateX(-50%)',
        background: 'var(--bg-panel)', border: '1px solid var(--accent-blue)',
        borderRadius: 6, padding: '6px 16px',
        display: 'flex', alignItems: 'center', gap: 10,
        fontFamily: 'var(--font-mono)', fontSize: 10, zIndex: 200,
      }}>
        <span style={{ color: 'var(--accent-blue)' }}>▶ REPLAY AVAILABLE</span>
        <span style={{ color: 'var(--text-dim)' }}>
          {total} frames · {formatDur(lastFrame?.elapsedSec ?? 0)} mission ·{' '}
          {replaySession?.scenarioId ?? ''}
        </span>
        {truncated && (
          <span style={{ color: 'var(--accent-yellow)' }} title="The rolling replay buffer keeps the most recent frames; the earliest mission minutes were dropped.">
            ⚠ last {coveredDur} only
          </span>
        )}
        <button className="btn primary" onClick={handleEnterReplay} style={{ padding: '3px 10px', fontSize: 9 }}>
          ENTER REPLAY
        </button>
        <button className="btn" onClick={handleExportAfterAction} style={{ padding: '3px 10px', fontSize: 9 }}>
          EXPORT REPORT
        </button>
      </div>
    )
  }

  const weather = currentFrame?.weatherState

  return (
    <div style={{
      position: 'fixed', bottom: 72, left: '50%', transform: 'translateX(-50%)',
      background: 'var(--bg-panel)', border: '1px solid var(--accent-blue)',
      borderRadius: 6, padding: '8px 16px',
      display: 'flex', flexDirection: 'column', gap: 6,
      fontFamily: 'var(--font-mono)', fontSize: 10, zIndex: 200,
      minWidth: 560,
    }}>
      {/* Weather state during scrub */}
      {weather && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '3px 6px', background: 'var(--bg-input)', borderRadius: 3,
          fontSize: 9,
        }}>
          <span style={{ color: 'var(--text-dim)' }}>WX</span>
          <span style={{ color: weather.activeHazards.length > 0 ? 'var(--accent-yellow)' : 'var(--accent-green)' }}>
            {weatherSummaryLabel(weather)}
          </span>
          <span style={{ color: 'var(--text-dim)' }}>·</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            wind {weather.windKts}kt · vis {weather.visibilityMi}mi · ceil {weather.ceilingFt}ft
          </span>
          {weather.batteryDrainMultiplier > 1.05 && (
            <span style={{ color: 'var(--accent-yellow)' }}>
              ⚡ drain ×{weather.batteryDrainMultiplier.toFixed(2)}
            </span>
          )}
          <span style={{ color: 'var(--text-dim)', marginLeft: 'auto' }}>
            thermal: {currentFrame?.thermalContacts?.length ?? 0} contacts ·
            {' '}units: {currentFrame?.groundUnits?.filter((u) => u.status !== 'standby').length ?? 0}
          </span>
        </div>
      )}

      {/* Transport controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Mode label */}
        <span style={{ color: 'var(--accent-blue)', letterSpacing: 1, minWidth: 80 }}>
          ◈ REPLAY{truncated ? ' ⚠' : ''}
        </span>
        {truncated && (
          <span style={{ color: 'var(--accent-yellow)', fontSize: 9 }} title="Rolling buffer — earliest mission frames were dropped.">
            last {coveredDur}
          </span>
        )}

        {/* Play/pause */}
        <button className="btn primary" onClick={handlePlayPause} style={{ padding: '3px 10px', fontSize: 11, minWidth: 32 }}>
          {playing ? '⏸' : '▶'}
        </button>

        {/* Seek slider */}
        <input
          type="range"
          min={0}
          max={total - 1}
          value={replayIndex}
          onChange={handleSeek}
          style={{ flex: 1, accentColor: 'var(--accent-blue)', cursor: 'pointer' }}
        />

        {/* Time display */}
        <span style={{ color: 'var(--text-secondary)', minWidth: 72, textAlign: 'right' }}>
          {currentFrame ? formatDur(currentFrame.elapsedSec) : '0m 00s'}
          <span style={{ color: 'var(--text-dim)' }}> / {formatDur(lastFrame?.elapsedSec ?? 0)}</span>
        </span>

        {/* Percent */}
        <span style={{ color: 'var(--accent-blue)', minWidth: 40, textAlign: 'right' }}>{pct}%</span>

        {/* Speed */}
        <div className="btn-group">
          {[1, 2, 4].map((s) => (
            <button key={s} className={`btn${playSpeed === s ? ' active' : ''}`} onClick={() => setPlaySpeed(s)} style={{ fontSize: 9, padding: '2px 6px' }}>
              {s}×
            </button>
          ))}
        </div>

        <button className="btn" onClick={handleExportAfterAction} style={{ padding: '3px 8px', fontSize: 9 }}>
          REPORT
        </button>

        {/* Exit */}
        <button className="btn danger" onClick={handleExitReplay} style={{ padding: '3px 8px', fontSize: 9 }}>
          EXIT
        </button>
      </div>
    </div>
  )
}

function formatDur(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}
