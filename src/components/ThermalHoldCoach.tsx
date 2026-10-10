import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/droneStore'
import { THERMAL_HOLD_TIMEOUT_SEC } from '@/sim/mission/MissionManager'
import { contactRoadAccess } from '@/sim/mission/routeMemo'
import { haversineDistanceM } from '@/utils/geometry'

/**
 * Whether a ground unit can reach the contact: `'ok' | 'none'` from the road network
 * (`contactRoadAccess`), or `'unknown'` while there is no contact or scenario to ask about.
 */
export type CoachRoadAccess = 'ok' | 'none' | 'unknown'

export interface CoachHintInput {
  roadAccess: CoachRoadAccess
  /** Whole sim-seconds until the drone resumes by itself. Clamped to >= 0 and rounded up. */
  secondsLeft: number
}

function wholeSeconds(secondsLeft: number): number {
  return Math.max(0, Math.ceil(Number.isFinite(secondsLeft) ? secondsLeft : 0))
}

/** First sentence of the hint: what the operator can do, which depends on road access. */
function coachAction(roadAccess: CoachRoadAccess): string {
  return roadAccess === 'none'
    ? 'No road access — mark it or let the drone resume.'
    : 'Dispatch a ground unit or mark it a false positive.'
}

/** Second line of the banner. Pure so it can be unit-tested and reused. */
export function coachHint({ roadAccess, secondsLeft }: CoachHintInput): string {
  return `${coachAction(roadAccess)} The drone resumes on its own in about ${wholeSeconds(secondsLeft)}s.`
}

/**
 * The same hint worded for a screen reader and meant to be rendered ONCE, when the hold starts,
 * not re-rendered every second: spelled-out "seconds", so it reads naturally and never changes
 * under an assistive-technology user while the visible countdown (aria-hidden) ticks.
 */
export function coachHintStatic({ roadAccess, secondsLeft }: CoachHintInput): string {
  return `${coachAction(roadAccess)} The drone resumes on its own in about ${wholeSeconds(secondsLeft)} seconds.`
}

/** Where the desktop banner sits relative to the in-map mission feed (see `useFeedAnchor`). */
interface FeedAnchor { top: number; left: number; width: number }

const FEED_SELECTOR = '[data-testid="mission-status-feed"]'
const FEED_GAP_PX = 8
const BANNER_MAX_WIDTH_PX = 620

/**
 * The desktop mission feed docks to the top of the map, so a banner at a fixed top offset would
 * cover it. Measure the feed and sit directly below it, left-aligned with it and never wider than
 * it (the feed stops short of the right-hand ops hub, so neither can the banner). Null when there
 * is no laid-out feed, in which case the CSS default (top-centre under the header) applies.
 */
function measureFeedAnchor(): FeedAnchor | null {
  const feed = document.querySelector(FEED_SELECTOR)
  if (!feed) return null
  const r = feed.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null // display:none or not laid out
  return {
    top: Math.round(r.bottom + FEED_GAP_PX),
    left: Math.round(r.left),
    width: Math.min(BANNER_MAX_WIDTH_PX, Math.round(r.width)),
  }
}

function sameAnchor(a: FeedAnchor | null, b: FeedAnchor | null): boolean {
  if (a === b) return true
  return a !== null && b !== null && a.top === b.top && a.left === b.left && a.width === b.width
}

/**
 * Tracks the feed's rect while `active`: on mount, on window resize and whenever the feed (or the
 * map area holding it) resizes. Everything is released when `active` flips off or on unmount.
 * Layout effect so the first paint is already in place, not a frame at the fallback position.
 */
function useFeedAnchor(active: boolean): FeedAnchor | null {
  const [anchor, setAnchor] = useState<FeedAnchor | null>(null)
  useLayoutEffect(() => {
    if (!active) return
    const update = () => {
      const next = measureFeedAnchor()
      setAnchor((prev) => (sameAnchor(prev, next) ? prev : next))
    }
    update()
    window.addEventListener('resize', update)
    let observer: ResizeObserver | undefined
    const feed = document.querySelector(FEED_SELECTOR)
    if (feed && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update)
      observer.observe(feed)
      if (feed.parentElement) observer.observe(feed.parentElement)
    }
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [active])
  return active ? anchor : null
}

interface HoldSnapshot {
  droneId: string | null
  label: string
  /** Whole sim-seconds left before auto-resume; null when no drone is holding. */
  secondsLeft: number | null
  /** Nearest unresolved, undispatched contact to the holding drone (see deviation note below). */
  contactId: string | null
  /** Road access for that contact; `'unknown'` when there is no contact or no scenario loaded. */
  roadAccess: CoachRoadAccess
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
  if (!drone) return { droneId: null, label: '', secondsLeft: null, contactId: null, roadAccess: 'unknown' }
  const start = drone.thermalHoldStartSec ?? s.elapsedSec
  const secondsLeft = Math.max(0, Math.ceil(THERMAL_HOLD_TIMEOUT_SEC - (s.elapsedSec - start)))
  let contactId: string | null = null
  let target: (typeof s.thermalContacts)[number] | null = null
  let best = Infinity
  for (const c of s.thermalContacts) {
    if (c.resolvedAt !== undefined || c.groundUnitId) continue
    const d = haversineDistanceM(drone.position, c.position)
    if (d < best) { best = d; contactId = c.sourceId; target = c }
  }
  // Same answer the contact panel shows (memoised per contact, so cheap on every store update).
  const roadAccess: CoachRoadAccess = target && s.scenario
    ? contactRoadAccess(s.scenario, { sourceId: target.sourceId, position: target.position })
    : 'unknown'
  return { droneId: drone.id, label: drone.label, secondsLeft, contactId, roadAccess }
}

interface ThermalHoldCoachProps {
  /**
   * `desktop`: directly below the in-map mission feed (top-centre under the header when there is
   * none). `phone`: above the dock, below drawers.
   */
  placement?: 'desktop' | 'phone'
}

interface OpenState {
  droneId: string
  baseline: number
  /** Whole sim-seconds left when the banner opened; fixes the screen-reader line once. */
  announcedSec: number
}

export function ThermalHoldCoach({ placement = 'desktop' }: ThermalHoldCoachProps) {
  // Separate primitive selectors: no object-returning selector, so no useShallow needed.
  const holdDroneId = useDroneStore((s) => selectHold(s).droneId)
  const holdLabel = useDroneStore((s) => selectHold(s).label)
  const secondsLeft = useDroneStore((s) => selectHold(s).secondsLeft)
  const contactId = useDroneStore((s) => selectHold(s).contactId)
  const roadAccess = useDroneStore((s) => selectHold(s).roadAccess)
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
  const [open, setOpen] = useState<OpenState | null>(null)

  // Open on the first hold of a mission.
  useEffect(() => {
    if (!holdDroneId || open) return
    if (shownForMissionRef.current === missionKey) return
    shownForMissionRef.current = missionKey
    setOpen({
      droneId: holdDroneId,
      baseline: actionedCount,
      announcedSec: secondsLeft ?? THERMAL_HOLD_TIMEOUT_SEC,
    })
  }, [holdDroneId, missionKey, open, actionedCount, secondsLeft])

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

  const anchor = useFeedAnchor(visible && placement === 'desktop')

  const showThermalView = () => {
    const store = useDroneStore.getState()
    store.setSensorMode('ir')
    if (contactId) store.selectThermal(contactId)
  }

  // The live region is mounted unconditionally so assistive technology already knows about it
  // when the banner is inserted (a region that appears together with its content is often not
  // announced at all). aria-atomic=false: only what is added gets read. The ticking countdown is
  // aria-hidden and a static sr-only line carries the same information once, so the banner is
  // announced when it opens and not again every second.
  return (
    <div
      className="thermal-hold-coach-live"
      role="status"
      aria-live="polite"
      aria-atomic="false"
      data-testid="thermal-hold-coach-live"
    >
      {open && (
        <div
          className={`thermal-hold-coach thermal-hold-coach--${placement}`}
          style={anchor ? { top: anchor.top, left: anchor.left, width: anchor.width, transform: 'none' } : undefined}
          data-testid="thermal-hold-coach"
        >
          <div className="thermal-hold-coach__body">
            <strong className="thermal-hold-coach__title">
              Thermal contact — {holdLabel || 'A drone'} is holding for you.
            </strong>
            <span className="sr-only" data-testid="thermal-hold-coach-hint-static">
              {coachHintStatic({ roadAccess, secondsLeft: open.announcedSec })}
            </span>
            <span className="thermal-hold-coach__hint" aria-hidden="true" data-testid="thermal-hold-coach-hint">
              {coachHint({ roadAccess, secondsLeft: secondsLeft ?? 0 })}
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
      )}
    </div>
  )
}
