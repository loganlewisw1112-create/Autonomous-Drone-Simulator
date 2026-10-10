import { buildWeatherState } from '@/sim/weather/weatherEngine'
import { observedWeatherFor } from '@/scenarios/observedWeather'
import { getScenarioById, getScenarioOptions } from '@/scenarios/registry'
import { prepareScenarioTerrain } from '@/scenarios/terrainFixtures'
import { initFleet, startSimLoop, stopTicking, tick } from '@/sim/SimulationLoop'
import { APP_TARGET } from '@/platform/appTarget'
import { useDroneStore } from '@/store/droneStore'
import type { DebugCommand } from '@/debug/types'
import type { SimSpeed } from '@/types'

// Sim-control commands. None sets `mutatesSim`: pause/resume/speed/step/restart/seek/scenario load
// drive the same transport controls the operator has, and the sim's physics is sub-step
// deterministic, so none of them changes what a given run computes, only when we look at it.

/** The only speeds the sim supports. SimSpeed is NOT widened here: sub-stepping determinism depends on it. */
const SPEEDS: readonly SimSpeed[] = [1, 5, 10, 20]
const MAX_STEP = 1000

function allowedSpeeds(): readonly SimSpeed[] {
  // ControlBar hides 20x in the classroom edition; mirror that.
  return APP_TARGET === 'classroom' ? SPEEDS.filter((s) => s !== 20) : SPEEDS
}

export const simCommands: DebugCommand[] = [
  {
    name: 'pause',
    group: 'sim',
    summary: 'Pause the running mission (same as the Pause control).',
    run: ({ print }) => {
      const s = useDroneStore.getState()
      if (s.lifecycle !== 'running') { print(`Nothing to pause (lifecycle: ${s.lifecycle}).`, 'warn'); return }
      s.setRunning(false)
      stopTicking()
      s.setLifecycle('paused')
      print('Paused.', 'info')
    },
  },
  {
    name: 'resume',
    group: 'sim',
    summary: 'Resume a paused mission (same as the Resume control).',
    run: ({ print }) => {
      const s = useDroneStore.getState()
      if (s.lifecycle !== 'paused') { print(`Nothing to resume (lifecycle: ${s.lifecycle}).`, 'warn'); return }
      s.setRunning(true)
      s.setLifecycle('running')
      startSimLoop()
      print('Resumed.', 'info')
    },
  },
  {
    name: 'step',
    group: 'sim',
    summary: 'Advance n ticks while paused, through the real loop tick() (default 1).',
    usage: 'step [n]',
    run: ({ args, print }) => {
      const n = args[0] === undefined ? 1 : Number(args[0])
      if (!Number.isInteger(n) || n < 1 || n > MAX_STEP) { print(`step takes a whole number from 1 to ${MAX_STEP}.`, 'err'); return }
      if (useDroneStore.getState().lifecycle !== 'paused') { print('step needs a paused mission. Run "pause" first.', 'err'); return }
      const startTick = useDroneStore.getState().tick
      let done = 0
      for (; done < n; done++) {
        // tick() is the production step but bails out unless ui.isRunning, so flip it for exactly one call.
        useDroneStore.getState().setRunning(true)
        try {
          tick()
        } finally {
          useDroneStore.getState().setRunning(false)
        }
        if (useDroneStore.getState().lifecycle !== 'paused') {
          print(`Mission left the paused state (${useDroneStore.getState().lifecycle}); stopped stepping.`, 'warn')
          done += 1
          break
        }
      }
      const s = useDroneStore.getState()
      print(`Stepped ${done} tick call${done === 1 ? '' : 's'} at ${s.ui.simSpeed}x: tick ${startTick} -> ${s.tick}, T+${s.elapsedSec.toFixed(2)}s.`, 'info')
    },
  },
  {
    name: 'speed',
    group: 'sim',
    summary: 'Set the sim speed multiplier (only the supported values).',
    usage: 'speed <1|5|10|20>',
    complete: (args) => (args.length <= 1 ? allowedSpeeds().map(String) : []),
    run: ({ args, print }) => {
      const allowed = allowedSpeeds()
      const value = Number(args[0])
      if (args[0] === undefined || !allowed.includes(value as SimSpeed)) {
        print(`Speed must be one of: ${allowed.join(', ')}. (Other values would break sub-step determinism.)`, 'err')
        return
      }
      useDroneStore.getState().setSimSpeed(value as SimSpeed)
      print(`Sim speed ${value}x.`, 'info')
    },
  },
  {
    name: 'seek',
    group: 'sim',
    summary: 'Jump to a time in replay mode (nearest recorded frame at or after <sec>).',
    usage: 'seek <sec>',
    run: ({ args, print }) => {
      const sec = Number(args[0])
      if (args[0] === undefined || !Number.isFinite(sec) || sec < 0) { print('usage: seek <sec>  (seconds, 0 or more)', 'err'); return }
      const s = useDroneStore.getState()
      const frames = s.replaySession?.frames
      if (!s.ui.isReplayMode || !frames || frames.length === 0) { print('seek only works in replay mode with a recorded session.', 'err'); return }
      const found = frames.findIndex((f) => f.elapsedSec >= sec)
      const index = found === -1 ? frames.length - 1 : found
      s.setReplayIndex(index)
      print(`Replay frame ${index + 1}/${frames.length} at T+${frames[index].elapsedSec.toFixed(1)}s.`, 'info')
    },
  },
  {
    name: 'restart',
    group: 'sim',
    summary: 'Reset the mission and re-seed the fleet for the loaded scenario.',
    run: ({ print }) => {
      const s = useDroneStore.getState()
      if (!s.scenario) { print('No scenario loaded.', 'err'); return }
      stopTicking()
      s.setRunning(false)
      s.resetMission()
      initFleet()
      print(`Restarted ${s.scenario.id}. Open Launch Planning to start again.`, 'info')
    },
  },
  {
    name: 'scenarios',
    group: 'sim',
    summary: 'List scenario ids and names.',
    run: ({ print }) => {
      for (const option of getScenarioOptions()) print(`${option.id.padEnd(40)}${option.label}`)
    },
  },
  {
    name: 'scenario',
    group: 'sim',
    summary: 'Load a scenario by id (refused while a mission is running or paused).',
    usage: 'scenario load <id>',
    complete: (args) => {
      if (args.length <= 1) return ['load']
      return args[0] === 'load' && args.length === 2 ? getScenarioOptions().map((o) => o.id) : []
    },
    run: async ({ args, print }) => {
      if (args[0] !== 'load' || !args[1]) { print('usage: scenario load <id>   (see "scenarios")', 'err'); return }
      const s = useDroneStore.getState()
      // Never discard an in-progress mission; the same rule the scenario picker applies.
      if (s.lifecycle === 'running' || s.lifecycle === 'paused') { print('A mission is in progress. End it first (or "restart"), then load.', 'err'); return }
      const found = getScenarioById(args[1])
      if (!found) { print(`No scenario "${args[1]}". Use "scenarios" to list ids.`, 'err'); return }
      const terrain = await prepareScenarioTerrain(found.config)
      if (!terrain.ok) { print(terrain.reason, 'err'); return }
      stopTicking()
      s.setRunning(false)
      s.setScenario(found.config)
      if (found.config.weatherProfile) {
        s.setWeatherState(buildWeatherState(found.config.weatherProfile, useDroneStore.getState().scenarioVariant, observedWeatherFor(found.config.id)))
      }
      initFleet()
      s.setLifecycle('preflight')
      s.setShowPreflight(true)
      print(`Loaded ${found.config.id}: ${found.config.name}.`, 'info')
    },
  },
]
