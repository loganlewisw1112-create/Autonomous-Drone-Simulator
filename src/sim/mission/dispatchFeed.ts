import type {
  DispatchFeedEntry,
  DispatchPriority,
  DroneState,
  MissionEvent,
  ScenarioConfig,
  ThermalDetection,
} from '@/types'

const MAX_FEED_ENTRIES = 32

export interface MissionStatusFeedInput {
  scenario: ScenarioConfig | null
  elapsedSec: number
  events: MissionEvent[]
  drones: DroneState[]
  thermalDetections: ThermalDetection[]
}

export function buildMissionStatusFeed(input: MissionStatusFeedInput): DispatchFeedEntry[] {
  if (!input.scenario) return []

  const entries: DispatchFeedEntry[] = []

  for (const item of input.scenario.dispatchTimeline ?? []) {
    if (item.timeSec > input.elapsedSec) continue
    entries.push({
      id: `authored-${item.id}`,
      timeSec: item.timeSec,
      source: item.source,
      priority: item.priority,
      message: item.message,
      linkedDroneId: item.linkedDroneId,
      kind: 'authored',
      category: item.category ?? 'dispatch',
    })
  }

  entries.push(...derivedEventEntries(input))
  entries.push(...liveWarningEntries(input))

  return dedupe(entries)
    .sort((a, b) => b.timeSec - a.timeSec || priorityRank(b.priority) - priorityRank(a.priority))
    .slice(0, MAX_FEED_ENTRIES)
}

function derivedEventEntries(input: MissionStatusFeedInput): DispatchFeedEntry[] {
  const entries: DispatchFeedEntry[] = []
  const events = [...input.events].sort((a, b) => a.tick - b.tick)

  for (const event of events) {
    const timeSec = Math.round(event.tick * 0.05)
    if (timeSec > input.elapsedSec) continue

    const droneLabel = event.droneId === 'system' ? 'SYSTEM' : event.droneId.toUpperCase()
    const base = {
      timeSec,
      linkedDroneId: event.droneId === 'system' ? undefined : event.droneId,
      kind: 'derived' as const,
    }

    switch (event.eventType) {
      case 'thermal_detection': {
        const conf = event.payload.confidence
        const cls = event.payload.class
        const pos = event.payload.position as { lat: number; lng: number } | undefined
        const coordStr = pos ? ` at ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : ''
        entries.push({
          ...base,
          id: `event-thermal-${event.droneId}-${String(event.payload.sourceId ?? 'contact')}`,
          source: droneLabel,
          priority: 'urgent',
          category: 'field_unit',
          message: `${droneLabel} thermal contact ${cls ?? 'unknown class'}${coordStr} (${conf ?? '?'}% confidence). Drone entering hold — awaiting operator action.`,
        })
        break
      }
      case 'route_complete':
        entries.push({
          ...base,
          id: `event-route-complete-${event.droneId}`,
          source: droneLabel,
          priority: 'routine',
          category: 'operator_task',
          message: `${droneLabel} completed assigned route; loitering at last waypoint awaiting operator tasking. Battery ${event.payload.batteryRemaining}%.`,
        })
        break
      case 'weather_divert':
        entries.push({
          ...base,
          id: `event-weather-divert-${event.droneId}`,
          source: droneLabel,
          priority: 'critical',
          category: 'safety',
          message: `${droneLabel} diverting to safe zone due to weather (${event.payload.hazard ?? 'severe conditions'}); returning to ${event.payload.targetSafeZone ?? 'base'}.`,
        })
        break
      case 'comms_degraded':
      case 'comms_lost': {
        const pos = event.eventType === 'comms_lost'
          ? (event.payload?.position as { lat: number; lng: number } | undefined)
          : undefined
        const coordStr = pos ? ` Last known: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}.` : ''
        entries.push({
          ...base,
          id: `event-comms-${event.droneId}-${event.eventType}`,
          source: 'COMMS',
          priority: event.eventType === 'comms_lost' ? 'critical' : 'advisory',
          category: 'safety',
          message: event.eventType === 'comms_lost'
            ? `${droneLabel} link lost.${coordStr} Relay reposition or altitude hold may be required.`
            : `${droneLabel} link quality degraded; relay reposition or altitude hold may be required.`,
        })
        break
      }
      case 'geofence_breach':
        entries.push({
          ...base,
          id: `event-geofence-${event.droneId}-${String(event.payload.geofenceId ?? 'unknown')}`,
          source: 'SAFETY',
          priority: 'critical',
          category: 'safety',
          message: `${droneLabel} route safety alert near ${String(event.payload.geofenceLabel ?? 'active geofence')}; return-to-base guard is active.`,
        })
        break
      case 'conflict_detected':
        entries.push({
          ...base,
          id: `event-conflict-${event.droneId}-${String(event.payload.conflictWith ?? 'airspace')}`,
          source: 'DECONFLICT',
          priority: 'critical',
          category: 'safety',
          message: `${droneLabel} has aircraft spacing conflict with ${String(event.payload.conflictWith ?? 'another unit')}; altitude/route separation required.`,
        })
        break
      case 'rtb_triggered':
        const rtbStationLabel = stringPayload(event.payload.rechargeStationLabel)
        const rtbReason = String(event.payload.reason ?? 'route_complete').replace(/_/g, ' ')
        entries.push({
          ...base,
          id: `event-rtb-${event.droneId}-${String(event.payload.reason ?? event.payload.from ?? 'route')}`,
          source: droneLabel,
          priority: priorityForRtbReason(String(event.payload.reason ?? 'route_complete')),
          category: 'agency_update',
          message: rtbStationLabel
            ? `${droneLabel} diverting to ${rtbStationLabel} (${rtbReason}); operator monitor the recovery route leg.`
            : `${droneLabel} executing return-to-base (${rtbReason}).`,
        })
        break
      case 'waypoint_reached':
        entries.push({
          ...base,
          id: `event-wp-${event.droneId}-${String(event.payload.waypointIndex ?? 'wp')}`,
          source: droneLabel,
          priority: 'routine',
          category: 'agency_update',
          message: `${droneLabel} reached tactical waypoint ${String(event.payload.waypointIndex ?? '')}; next route leg active.`,
        })
        break
      case 'recharge_start':
        const rechargeStationLabel = stringPayload(event.payload.rechargeStationLabel)
        entries.push({
          ...base,
          id: `event-recharge-${event.droneId}-${String(event.payload.sortieNum ?? 'sortie')}`,
          source: droneLabel,
          priority: 'advisory',
          category: 'field_unit',
          message: rechargeStationLabel
            ? `${droneLabel} on recharge cycle at ${rechargeStationLabel}; sortie ${String(event.payload.sortieNum ?? '')} turnaround in progress.`
            : `${droneLabel} on recharge cycle; sortie ${String(event.payload.sortieNum ?? '')} turnaround in progress.`,
        })
        break
      case 'sortie_launch':
        entries.push({
          ...base,
          id: `event-sortie-${event.droneId}-${String(event.payload.sortieNum ?? 'sortie')}`,
          source: droneLabel,
          priority: 'advisory',
          category: 'agency_update',
          message: `${droneLabel} relaunching for next sortie with approved route resume point.`,
        })
        break
      case 'mission_complete':
        entries.push({
          ...base,
          id: `event-complete-${event.droneId}`,
          source: droneLabel,
          priority: 'routine',
          category: 'agency_update',
          message: `${droneLabel} mission leg complete; evidence chain updated and recovery state confirmed.`,
        })
        break
      case 'operator_command': {
        if (event.payload.source === 'fleet_retask') {
          const tacticalAction = String(event.payload.tacticalAction ?? 'route update').replace(/_/g, ' ')
          const objectiveId = stringPayload(event.payload.objectiveId)
          entries.push({
            ...base,
            id: `event-route-advisor-${event.droneId}-${String(event.payload.tacticalAction ?? 'route')}-${event.tick}`,
            source: 'ROUTE ADVISOR',
            priority: 'advisory',
            category: 'operator_task',
            message: `${droneLabel} Route Advisor decision support: ${tacticalAction}${objectiveId ? ` for objective ${objectiveId}` : ''}.`,
          })
          break
        }
        entries.push({
          ...base,
          id: `event-operator-${event.droneId}-${String(event.payload.command ?? 'command')}-${event.tick}`,
          source: 'OPERATOR',
          priority: 'advisory',
          category: 'operator_task',
          message: `${droneLabel} received operator command: ${String(event.payload.command ?? 'route update').replace(/_/g, ' ')}.`,
        })
        break
      }
      default:
        break
    }
  }

  return entries
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function liveWarningEntries(input: MissionStatusFeedInput): DispatchFeedEntry[] {
  const entries: DispatchFeedEntry[] = []

  for (const drone of input.drones) {
    if (drone.geofenceBreachFlag) {
      entries.push(warningEntry({
        id: `warning-geofence-${drone.id}-${drone.geofenceBreach?.id ?? 'unknown'}`,
        timeSec: input.elapsedSec,
        source: 'SAFETY',
        priority: 'critical',
        message: `${drone.label} is inside ${drone.geofenceBreach?.label ?? 'an active geofence'}; route guard is commanding immediate safety response.`,
        linkedDroneId: drone.id,
        category: 'safety',
      }))
    }
    if (drone.conflictFlag) {
      entries.push(warningEntry({
        id: `warning-conflict-${drone.id}`,
        timeSec: input.elapsedSec,
        source: 'DECONFLICT',
        priority: 'critical',
        message: `${drone.label} conflict flag active; hold altitude separation and review route suggestion.`,
        linkedDroneId: drone.id,
        category: 'safety',
      }))
    }
    if (drone.signalDbm < -90) {
      entries.push(warningEntry({
        id: `warning-comms-lost-${drone.id}`,
        timeSec: input.elapsedSec,
        source: `${drone.label} RELAY`,
        priority: 'urgent',
        message: `${drone.label} comms link is below BVLOS threshold; relay reposition recommended.`,
        linkedDroneId: drone.id,
        category: 'safety',
      }))
    }
  }

  const latestBySource = new Map<string, ThermalDetection>()
  for (const detection of input.thermalDetections) latestBySource.set(detection.sourceId, detection)
  latestBySource.forEach((detection) => {
    entries.push(warningEntry({
      id: `warning-thermal-${detection.sourceId}`,
      timeSec: Math.round(detection.tick * 0.05),
      source: 'THERMAL',
      priority: 'urgent',
      message: `Thermal contact ${detection.sourceId} marked at ${Math.round(detection.confidence * 100)} percent confidence; operator can approve focused follow-up scan.`,
      category: 'operator_task',
    }))
  })

  return entries
}

function warningEntry(input: Omit<DispatchFeedEntry, 'kind'>): DispatchFeedEntry {
  return { ...input, kind: 'warning' }
}

function dedupe(entries: DispatchFeedEntry[]): DispatchFeedEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = entry.id
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function priorityRank(priority: DispatchPriority): number {
  switch (priority) {
    case 'critical': return 4
    case 'urgent': return 3
    case 'advisory': return 2
    case 'routine':
    default: return 1
  }
}

function priorityForRtbReason(reason: string): DispatchPriority {
  if (reason.includes('geofence')) return 'critical'
  if (reason.includes('battery')) return 'urgent'
  return 'advisory'
}
