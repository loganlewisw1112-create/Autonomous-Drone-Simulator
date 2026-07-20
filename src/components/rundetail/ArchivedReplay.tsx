import { useMemo, useState } from 'react'
import type { StoredRunDetailV2 } from '@/account/types'

export function ArchivedReplay({ detail }: { detail: StoredRunDetailV2 }) {
  const [frameIndex, setFrameIndex] = useState(0)
  const frames = detail.replayFrames
  const frame = frames[frameIndex]
  const bounds = useMemo(() => {
    const positions = frames.flatMap((item) => item.drones.map((drone) => drone.position))
    if (!positions.length) return { minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 }
    return {
      minLat: Math.min(...positions.map((position) => position.lat)),
      maxLat: Math.max(...positions.map((position) => position.lat)),
      minLng: Math.min(...positions.map((position) => position.lng)),
      maxLng: Math.max(...positions.map((position) => position.lng)),
    }
  }, [frames])

  if (!frame) return <p className="rundetail-empty">No replay frames were stored for this run.</p>
  const x = (lng: number) => 6 + ((lng - bounds.minLng) / Math.max(0.000001, bounds.maxLng - bounds.minLng)) * 88
  const y = (lat: number) => 94 - ((lat - bounds.minLat) / Math.max(0.000001, bounds.maxLat - bounds.minLat)) * 88

  return (
    <div className="archived-replay" data-testid="archived-replay">
      <div className="archived-replay-map" aria-label="Archived run map">
        <svg viewBox="0 0 100 100" role="img">
          {frame.drones.map((drone) => <circle key={drone.id} cx={x(drone.position.lng)} cy={y(drone.position.lat)} r="2.2" fill={drone.color} />)}
        </svg>
        <span>T+{Math.round(frame.elapsedSec)}s · frame {frameIndex + 1}/{frames.length}</span>
      </div>
      <input
        aria-label="Archived replay position"
        type="range"
        min={0}
        max={Math.max(0, frames.length - 1)}
        value={frameIndex}
        onChange={(event) => setFrameIndex(Number(event.target.value))}
      />
      <div className="archived-replay-fleet">
        {frame.drones.map((drone) => <div key={drone.id}><strong>{drone.label}</strong><span>{drone.missionState}</span><span>{Math.round(drone.batteryPct)}% battery</span><span>{Math.round(drone.altitudeFt)} ft</span></div>)}
      </div>
      <p className="rundetail-fineprint">
        Coverage T+{Math.round(detail.replayCoverage.startSec)}–{Math.round(detail.replayCoverage.endSec)}s
        {detail.replayCoverage.truncated ? ' · Earlier frames were outside the saved replay window.' : ' · Complete saved replay window.'}
      </p>
    </div>
  )
}
