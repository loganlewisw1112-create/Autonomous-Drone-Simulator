import { pointInPolygon } from '@/utils/geometry'
import type { DroneState, Geofence, ScenarioConfig, WeatherVariantState } from '@/types'

/** Check geofence breach for each drone and stamp geofenceBreachFlag. */
export function applyGeofenceFlags(
  drones: DroneState[],
  geofences: Geofence[],
): DroneState[] {
  return drones.map((drone) => {
    const breach = geofences.find((gf) => {
      if (gf.bypassForMission) return false
      if (!pointInPolygon(drone.position, gf.polygon)) return false
      if (gf.type === 'restricted') return drone.altitudeFt <= gf.maxAltitudeFt
      return true
    })

    return {
      ...drone,
      geofenceBreachFlag: breach !== undefined,
      geofenceBreach: breach
        ? {
            id: breach.id,
            label: breach.label,
            type: breach.type,
            maxAltitudeFt: breach.maxAltitudeFt,
          }
        : undefined,
    }
  })
}

/** Simulate RF signal degradation during comms-loss windows with optional weather penalty. */
export function applyCommsModel(
  drones: DroneState[],
  elapsedSec: number,
  scenario: ScenarioConfig,
  weather?: WeatherVariantState,
): DroneState[] {
  const inBlackout = scenario.commsLossWindows.some(
    (w) => elapsedSec >= w.startSec && elapsedSec < w.startSec + w.durationSec,
  )

  return drones.map((drone) => {
    if (['landed', 'idle'].includes(drone.missionState)) return drone

    // Urban environments have dense RF infrastructure; use a higher ceiling if provided.
    // Weather lowers the recovery ceiling once instead of compounding signal loss every tick.
    const signalCeiling = weather?.commsSignalCeilingDbm ?? -55
    const weatherPenaltyDbm = weather ? Math.max(0, 1 - weather.commsReliabilityFactor) * 15 : 0
    const recoveryCeiling = signalCeiling - weatherPenaltyDbm
    let signalDbm = drone.signalDbm
    if (inBlackout) {
      signalDbm = Math.max(-98, signalDbm - 3)
    } else {
      signalDbm = Math.min(recoveryCeiling, signalDbm + 0.5)
    }

    return {
      ...drone,
      signalDbm,
      bvlosFlag: signalDbm < -90,
    }
  })
}
