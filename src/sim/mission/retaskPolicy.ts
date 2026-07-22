import type { DroneState } from '@/types'

const RETASKABLE_MISSION_STATES = new Set<DroneState['missionState']>([
  'navigate',
  'sar_grid',
  'hover',
  'route_complete_loiter',
])

export function isRetaskable(drone: DroneState): boolean {
  return RETASKABLE_MISSION_STATES.has(drone.missionState)
}
