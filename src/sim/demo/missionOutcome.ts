import type {
  DroneState,
  MissionMetrics,
  MissionOutcomeSummary,
  ScenarioConfig,
  ThermalContactState,
} from '@/types'

interface BuildMissionOutcomeSummaryInput {
  scenario: ScenarioConfig | null
  drones: DroneState[]
  metrics: MissionMetrics
  thermalContacts: ThermalContactState[]
  eventsCount: number
  elapsedSec: number
}

export function buildMissionOutcomeSummary(input: BuildMissionOutcomeSummaryInput): MissionOutcomeSummary {
  const plannedWaypointCount = Math.max(1, Object.values(input.scenario?.perDroneWaypoints ?? {}).reduce(
    (sum, route) => sum + route.length,
    input.scenario?.waypoints.length ?? 1,
  ))
  const uniqueContacts = new Map(input.thermalContacts.map((contact) => [contact.sourceId, contact]))
  const detectedContacts = uniqueContacts.size
  const resolvedContacts = Array.from(uniqueContacts.values()).filter((contact) => contact.resolvedAt !== undefined || contact.groundUnitId).length
  const searchCoveragePct = clampPct((input.metrics.waypointsReached / plannedWaypointCount) * 100)
  const routeRiskReductionPct = clampPct(100 - input.metrics.geofenceBreaches * 35 - input.metrics.conflictsDetected * 8)
  const fleetHealthScore = input.drones.length === 0
    ? 0
    : clampPct(input.drones.reduce((sum, drone) => {
        const batteryScore = drone.batteryPct
        const signalScore = clampPct(((drone.signalDbm + 100) / 70) * 100)
        const statePenalty = drone.missionState === 'emergency' || drone.missionState === 'stranded' ? 35 : 0
        return sum + clampPct((batteryScore * 0.55) + (signalScore * 0.45) - statePenalty)
      }, 0) / input.drones.length)
  const responseTimeSavedMin = Math.max(1, Math.round((detectedContacts * 3 + input.metrics.groundUnitDispatch * 2 + searchCoveragePct / 25) * 10) / 10)

  return {
    headline: `${detectedContacts} contacts, ${Math.round(searchCoveragePct)}% route coverage, fleet health ${Math.round(fleetHealthScore)}%.`,
    missionTimeSec: Math.round(input.elapsedSec),
    searchCoveragePct,
    detectedContacts,
    resolvedContacts,
    responseTimeSavedMin,
    routeRiskReductionPct,
    fleetHealthScore,
    evidenceEvents: input.eventsCount,
    exportReady: input.eventsCount > 0 || input.metrics.waypointsReached > 0 || detectedContacts > 0,
  }
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}
