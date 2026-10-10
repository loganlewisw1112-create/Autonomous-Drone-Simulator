import { constellationFor } from '@/scenarios/constellationFixtures'
import {
  clearInjectedFaults,
  listInjectedFaults,
  setInjectedFault,
  type InjectedFaultKind,
} from '@/sim/faults/injectedFaults'
import { useDroneStore } from '@/store/droneStore'
import type { DebugCommand } from '@/debug/types'
import type { WeatherVariantState } from '@/types'

// Fault injection. Every command here sets `mutatesSim`, so the registry DEBUG-taints the run
// (recorded in the hash chain, excluded from analytics) before the command runs.
//
// Faults drive the sim's own mechanisms (src/sim/faults/injectedFaults.ts explains where each is
// read): link → RF budget path loss, gps → the GNSS evaluator's no-fix path, motor → the mission
// safety override's emergency landing. Wind and battery write the same store state the weather
// engine and energy model use.

const FAULT_KINDS: readonly InjectedFaultKind[] = ['link', 'gps', 'motor']
const MAX_WIND_KTS = 80

/** Weather as it was before the first `wind` command, so `faults clear` can put it back. */
let windBaseline: Pick<WeatherVariantState, 'windKts' | 'gustKts'> | null = null

function droneIds(): string[] {
  return useDroneStore.getState().drones.map((d) => d.id).sort()
}

function requireDrone(id: string | undefined): string {
  if (!id) throw new Error('Name a drone id. Type "drones" for the list.')
  const match = droneIds().find((d) => d.toLowerCase() === id.toLowerCase())
  if (!match) throw new Error(`No drone "${id}". Known: ${droneIds().join(', ') || '(none loaded)'}`)
  return match
}

function matching(candidates: readonly string[], prefix: string | undefined): string[] {
  const p = (prefix ?? '').toLowerCase()
  return candidates.filter((c) => c.toLowerCase().startsWith(p))
}

/** Test-only: forget the remembered wind baseline. */
export function resetFaultCommandStateForTests(): void {
  windBaseline = null
}

export const faultsCommands: DebugCommand[] = [
  {
    name: 'fault',
    group: 'fault',
    summary: 'Inject or clear a link, GPS or motor fault on one drone.',
    usage: 'fault link|gps|motor <droneId> [off]',
    mutatesSim: true,
    run: ({ args, print }) => {
      const kind = args[0]?.toLowerCase() as InjectedFaultKind | undefined
      if (!kind || !FAULT_KINDS.includes(kind)) throw new Error('Usage: fault link|gps|motor <droneId> [off]')
      const droneId = requireDrone(args[1])
      const off = args[2]?.toLowerCase() === 'off'
      if (args[2] !== undefined && !off) throw new Error('The only option after the drone id is "off".')
      if (kind === 'gps' && !off) {
        const scenarioId = useDroneStore.getState().scenario?.id
        if (!constellationFor(scenarioId)) {
          print(`not supported: scenario "${scenarioId ?? 'none'}" has no GNSS constellation fixture, so the sim does not model GPS here.`, 'warn')
          return
        }
      }
      setInjectedFault(kind, droneId, !off)
      print(off ? `${kind} fault cleared on ${droneId}.` : `${kind} fault injected on ${droneId}. Takes effect on the next tick.`, 'info')
    },
    complete: (args) => {
      if (args.length <= 1) return matching(FAULT_KINDS, args[0])
      if (args.length === 2) return matching(droneIds(), args[1])
      if (args.length === 3) return matching(['off'], args[2])
      return []
    },
  },
  {
    name: 'wind',
    group: 'fault',
    summary: 'Set sustained wind (kts). Gusts scale with it. Direction is not modelled.',
    usage: 'wind <kts> [dirDeg]',
    mutatesSim: true,
    run: ({ args, print }) => {
      const kts = Number(args[0])
      if (!Number.isFinite(kts) || kts < 0 || kts > MAX_WIND_KTS) throw new Error(`wind takes knots from 0 to ${MAX_WIND_KTS}.`)
      const s = useDroneStore.getState()
      const current = s.weatherState
      if (!windBaseline) windBaseline = { windKts: current.windKts, gustKts: current.gustKts }
      // Keep the scenario's gust spread: gusts stay the same amount above sustained wind.
      const spread = Math.max(0, current.gustKts - current.windKts)
      s.setWeatherState({ ...current, windKts: kts, gustKts: kts + spread })
      print(`Wind set to ${kts} kts (gusts ${kts + spread} kts).`, 'info')
      if (args[1] !== undefined) print('Direction ignored: the sim models wind speed only, not direction.', 'warn')
    },
  },
  {
    name: 'battery',
    group: 'fault',
    summary: 'Set one drone\'s battery state of charge (0-100%).',
    usage: 'battery <droneId> <pct>',
    mutatesSim: true,
    run: ({ args, print }) => {
      const droneId = requireDrone(args[0])
      const pct = Number(args[1])
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('battery takes a percentage from 0 to 100.')
      // Cell voltage is derived from state of charge by the energy model each physics update;
      // clearing it makes the reserve/critical gates read the new charge until then.
      useDroneStore.getState().updateDrone(droneId, { batteryPct: pct, cellVoltageV: undefined })
      print(`${droneId} battery set to ${pct}%.`, 'info')
    },
    complete: (args) => (args.length <= 1 ? matching(droneIds(), args[0]) : []),
  },
  {
    name: 'faults',
    group: 'fault',
    summary: 'List injected faults, or "faults clear" to remove them all and restore wind.',
    usage: 'faults [clear]',
    // Listing changes nothing; only "clear" changes the sim, and it is handled below.
    run: ({ args, print }) => {
      if (args[0]?.toLowerCase() === 'clear') {
        clearInjectedFaults()
        if (windBaseline) {
          const s = useDroneStore.getState()
          s.setWeatherState({ ...s.weatherState, ...windBaseline })
          windBaseline = null
        }
        print('All injected faults cleared. The run stays DEBUG-tainted.', 'info')
        return
      }
      const active = listInjectedFaults()
      if (active.length === 0 && !windBaseline) { print('No injected faults.'); return }
      for (const f of active) print(`${f.kind.padEnd(6)} ${f.droneId}`)
      if (windBaseline) print(`wind   ${useDroneStore.getState().weatherState.windKts} kts (was ${windBaseline.windKts})`)
    },
    complete: (args) => (args.length <= 1 ? matching(['clear'], args[0]) : []),
  },
]
