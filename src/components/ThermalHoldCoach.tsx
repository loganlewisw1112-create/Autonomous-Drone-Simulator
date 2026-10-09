import { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/droneStore'
import { THERMAL_HOLD_TIMEOUT_SEC } from '@/sim/mission/MissionManager'
import { haversineDistanceM } from '@/utils/geometry'

/**
 * Whether a ground unit can reach the contact. c4 ships with `'unknown'` everywhere (the road
 * network that answers this arrives with c12b, which passes the real `'ok' | 'none'`).
 */
export type CoachRoadAccess = 'ok' | 'none' | 'unknown'

export interface CoachHintInput {
  roadAccess: CoachRoadAccess
  /** Whole sim-seconds until the drone resumes by itself. Clamped to >= 0 and rounded up. */
  secondsLeft: number
}

/** Second line of the banner. Pure so it can be unit-tested and reused. */
export function coachHint({ roadAccess, secondsLeft }: CoachHintInput): string {
  const n = Math.max(0, Math.ceil(Number.isFinite(secondsLeft) ? secondsLeft : 0))
  if (roadAccess === 'none') {
    return `No road access — mark it or let the drone resume. The drone resumes on its own in about ${n}s.`
  }
  return `Dispatch a ground unit or mark it a false positive. The drone resumes on its own in about ${n}s.`
}

interface HoldSnapshot {
  droneId: string | null
  label: string
  /** Whole sim-seconds left before auto-resume; null when no drone is holding. */
  secondsLeft: number | null
  /** Nearest unresolved, undispatched contact to the holding drone (see deviation note below). */
  contactId: string | null
}

/**
 * The store has no drone -> contact link (a contact carries no droneId, the drone no contactId),
 * so the contact that caused the hold is taken to be the nearest unresolved contact to the
 * holding drone. The drone stops where the detection happened, so in practice this is the one.
 * Selectors below return primitives only, so the banner re-renders once per sim-second, not
 * once per tick.
 */
function selectHold(s: ReturnType<typeof useDroneStore.getState>): HoldSnapshot {
  const drone = s.drones.find((d) => d.missionState === 'thermal_hold')
  if (!drone) return { droneId: null, label: '', secondsLeft: null, contactId: null }
  const start = drone.thermalHoldStartSec ?? s.elapsedSec
  const secondsLeft = Math.max(0, Math.ceil(THERMAL_HOLD_TIMEOUT_SEC - (s.elapsedSec - start)))
  let contactId: string | null = null
  let best = Infinity
  for (const c of s.thermalContacts) {
    if (c.resolvedAt !== undefined || c.groundUnitId) continue
    const d = haversineDistanceM(drone.position, c.position)
    if (d < best) { best = d; contactId = c.sourceId }
  }
  return { droneId: drone.id, label: drone.label, secondsLeft, contactId }
}

interface ThermalHoldCoachProps {
  /** `desktop`: top-centre below the header. `phone`: above the dock, below drawers. */
  placement?: 'desktop' | 'phone'
}

export function ThermalHoldCoach({ placement = 'desktop' }: ThermalHoldCoachProps) {
  // Separate primitive selectors: no object-returning selector, so no useShallow needed.
  const holdDroneId = useDroneStore((s) => selectHold(s).droneId)
  const holdLabel = useDroneStore((s) => selectHold(s).label)
  const secondsLeft = useDroneStore((s) => selectHold(s).secondsLeft)
  const contactId = useDroneStore((s) => selectHold(s).contactId)
  const missionKey = useDroneStore((s) => s.events[0]?.hash ?? '')
  // Contacts that have been dispatched to or resolved. Rising past the value captured when the
  // banner opened means the operator acted (Dispatch or mark false positive).
  const actionedCount = useDroneStore(
    (s) => s.thermalContacts.reduce((n, c) => (c.groundUnitId || c.resolvedAt !== undefined ? n + 1 : n), 0),
  )

  // Once per mission. The mission's identity is the hash of its first event: the store resets
  // `events` (append-only otherwise) when a new mission starts. Ref, not module state, so it
  // cannot leak between tests or sessions.
  const shownForMissionRef = useRef<string | null>(null)
  const [open, setOpen] = useState<{ droneId: string; baseline: number } | null>(null)

  // Open on the first hold of a mission.
  useEffect(() => {
    if (!holdDroneId || open) return
    if (shownForMissionRef.current === missionKey) return
    shownForMissionRef.current = missionKey
    setOpen({ droneId: holdDroneId, baseline: actionedCount })
  }, [holdDroneId, missionKey, open, actionedCount])

  // Dismiss: the hold ended / drone resumed, the operator dispatched or resolved a contact,
  // or a new mission began underneath us.
  useEffect(() => {
    if (!open) return
    const holdEnded = holdDroneId !== open.droneId
    const acted = actionedCount > open.baseline
    const newMission = shownForMissionRef.current !== missionKey
    if (holdEnded || acted || newMission) setOpen(null)
  }, [open, holdDroneId, actionedCount, missionKey])

  // Esc dismisses. Listener exists only while the banner is visible (no global Esc handler).
  const visible = open !== null
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible])

  if (!open) return null

  const showThermalView = () => {
    const store = useDroneStore.getState()
    store.setSensorMode('ir')
    if (contactId) store.selectThermal(contactId)
  }

  return (
    <div
      className={`thermal-hold-coach thermal-hold-coach--${placement}`}
      role="status"
      aria-live="polite"
      data-testid="thermal-hold-coach"
    >
      <div className="thermal-hold-coach__body">
        <strong className="thermal-hold-coach__title">
          Thermal contact — {holdLabel || 'A drone'} is holding for you.
        </strong>
        <span className="thermal-hold-coach__hint" data-testid="thermal-hold-coach-hint">
          {coachHint({ roadAccess: 'unknown', secondsLeft: secondsLeft ?? 0 })}
        </span>
      </div>
      <div className="thermal-hold-coach__actions">
        <button type="button" className="thermal-hold-coach__primary" onClick={showThermalView}>
          Show thermal view
        </button>
        <button
          type="button"
          className="thermal-hold-coach__close"
          aria-label="Dismiss thermal hold guidance"
          onClick={() => setOpen(null)}
        >
          ×
        </button>
      </div>
    </div>
  )
}
