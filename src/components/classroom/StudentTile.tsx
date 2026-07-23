import { useEffect, useRef } from 'react'
import { useClassroomStore } from '@/classroom/classroomStore'
import {
  alertSeverity, decodeDrone, frameActiveDroneCount, frameLowestBattery, type GridDrone, type GridFrame,
} from '@/classroom/gridFrame'
import {
  fitBboxToAspect, lerpDrones, renderTile, syncCanvasToDisplaySize, type Bbox,
} from '@/components/classroom/tileRenderer'

/**
 * Tile aspect ratio — 3:2, matching the proportions of the student's own map pane so the
 * instructor is looking at the same shape of world the student is.
 */
export const TILE_ASPECT = 3 / 2

// One student's live tile. Canvas 2D over the shared backdrop bitmap — never a
// MapLibre instance (24 WebGL contexts would fail late on someone else's laptop).
// A single rAF lerps between the last two 1 Hz frames so the wall glides instead
// of stepping (a stepping wall reads as broken even when nothing is wrong).
export function StudentTile({
  studentId, name, backdrop, bbox, selected, onClick,
}: {
  studentId: string
  name: string
  backdrop: CanvasImageSource | null
  bbox: Bbox
  selected: boolean
  onClick: () => void
}) {
  const frame = useClassroomStore((s) => s.frames[studentId]) as GridFrame | undefined
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Frame interpolation state kept in refs so it survives renders without re-triggering them.
  const prev = useRef<GridDrone[]>([])
  const next = useRef<GridDrone[]>([])
  const stamp = useRef<number>(0)

  useEffect(() => {
    if (!frame) return
    prev.current = next.current.length ? next.current : frame.d.map(decodeDrone)
    next.current = frame.d.map(decodeDrone)
    stamp.current = performance.now()
  }, [frame])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx) {
        // Re-synced every frame rather than on a ResizeObserver: it is a couple of integer
        // compares when nothing changed, and it means the tile is always crisp immediately after
        // a column reflow, a window resize or a monitor change, with no transient blur.
        const size = syncCanvasToDisplaySize(canvas, TILE_ASPECT)
        if (size) {
          const alpha = Math.min(1, (performance.now() - stamp.current) / 1000)
          const fitted = fitBboxToAspect(bbox, size.width, size.height)
          renderTile(ctx, backdrop, lerpDrones(prev.current, next.current, alpha), fitted, size.width, size.height)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [backdrop, bbox])

  const severity = frame ? alertSeverity(frame.a) : 'none'
  const active = frame ? frameActiveDroneCount(frame) : 0
  const lowBatt = frame ? frameLowestBattery(frame) : null
  const elapsed = frame ? frame.t : 0

  return (
    <div className={`cls-tile ${severity} ${selected ? 'selected' : ''}`} onClick={onClick} title={name}>
      {/* No width/height attributes: the backing store is owned by syncCanvasToDisplaySize,
          which sizes it to the tile's real layout width × devicePixelRatio. */}
      <canvas ref={canvasRef} />
      <div className="cls-tile-chrome">
        <span className="cls-tile-name">{name}</span>
        <span>T+{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
        <span>◆{active}</span>
        <span style={{ color: lowBatt != null && lowBatt < 20 ? '#ff8080' : undefined }}>
          {lowBatt != null ? `${lowBatt}%` : '—'}
        </span>
      </div>
      <div className="cls-tile-assessment" aria-label={`${name} rubric status`}>
        <span>Progress <strong>{frame?.p ?? '—'}{frame?.p !== undefined ? '%' : ''}</strong></span>
        <span>Band <strong>{frame?.b ?? '—'}</strong></span>
        <span>Score <strong>{frame?.sc ?? '—'}{frame?.sc !== undefined ? '/100' : ''}</strong></span>
      </div>
    </div>
  )
}
