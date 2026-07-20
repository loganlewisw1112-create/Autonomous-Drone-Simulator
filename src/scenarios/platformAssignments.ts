import type { PlatformId } from '@/sim/drone/platformCatalog'

// ─── Per-scenario platform doctrine ──────────────────────────────────────────
// Each scenario declares which airframe flies each drone slot. Assignments are
// fixed doctrine, not an operator choice — a wildfire cell flies thermal-capable
// Teal 2s, an HRT stack puts BRINC Lemur 2s inside the structure, and so on.
// Drone ids match SimulationLoop.initFleet's `uav-NN` (1-based, zero-padded).

export function droneIdAt(index: number): string {
  return `uav-${String(index + 1).padStart(2, '0')}`
}

/**
 * Builds a `dronePlatforms` record for a fleet of `droneCount` drones.
 *
 * Every slot flies `primary` except every `secondaryEvery`-th slot (1-based),
 * which flies `secondary` — so a 5-drone fleet with the default cadence gets
 * primary, primary, secondary, primary, primary. Passing no `secondary`
 * produces a single-platform fleet.
 */
export function mixedFleet(
  droneCount: number,
  primary: PlatformId,
  secondary?: PlatformId,
  secondaryEvery = 3,
): Record<string, PlatformId> {
  const fleet: Record<string, PlatformId> = {}
  for (let i = 0; i < droneCount; i++) {
    const useSecondary = secondary !== undefined && (i + 1) % secondaryEvery === 0
    fleet[droneIdAt(i)] = useSecondary ? secondary : primary
  }
  return fleet
}

/**
 * Builds a `dronePlatforms` record from an explicit per-slot list, for scenarios
 * whose doctrine doesn't follow a repeating cadence (e.g. an HRT stack where two
 * specific drones make interior entry and the rest hold overwatch).
 */
export function explicitFleet(platforms: PlatformId[]): Record<string, PlatformId> {
  const fleet: Record<string, PlatformId> = {}
  platforms.forEach((platform, i) => { fleet[droneIdAt(i)] = platform })
  return fleet
}
