import { getGenesisHash, hashEvent, verifyChain } from '@/utils/chainOfCustody'
import { useDebugHudStore } from '@/debug/hudState'
import { useDroneStore } from '@/store/droneStore'
import type { DebugCommand } from '@/debug/types'
import type { LayerVisibility, MissionEvent } from '@/types'

// Verification and view commands. None sets `mutatesSim`: chain/replay checks only read, and
// overlays/HUD change what is drawn, never what the sim computes.

/** Index of the first link whose prevHash or hash does not check out, or -1 when intact. */
export function firstBrokenLink(events: MissionEvent[]): number {
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const expectedPrev = i === 0 ? getGenesisHash() : events[i - 1].hash
    if (e.prevHash !== expectedPrev) return i
    const { hash, ...partial } = e
    if (hashEvent(e.prevHash, partial) !== hash) return i
  }
  return -1
}

/**
 * Why `replay verify` cannot run in-browser today. Kept as data so the console and the tests
 * state the same reason, and nobody is shown a MATCH that was never computed.
 */
export const REPLAY_VERIFY_UNAVAILABLE =
  'replay verify is not available in the browser yet. The sim runs on the global droneStore and '
  + 'SimulationLoop module state, so a headless re-run here would overwrite the live run. It needs an '
  + 'isolated store instance (or a worker realm) to re-run from scenario + variant + launch plan. '
  + 'The live run may also contain operator commands and debug overrides that a scenario-only '
  + 'replay cannot reproduce.'

function layerNames(): Array<keyof LayerVisibility> {
  return Object.keys(useDroneStore.getState().ui.layerVisibility).sort() as Array<keyof LayerVisibility>
}

export const verifyCommands: DebugCommand[] = [
  {
    name: 'chain',
    group: 'verify',
    summary: 'Re-verify the live mission event hash chain.',
    usage: 'chain verify',
    run: ({ args, print }) => {
      if (args[0]?.toLowerCase() !== 'verify') throw new Error('Usage: chain verify')
      const events = useDroneStore.getState().events
      if (events.length === 0) { print('No events yet: nothing to verify.'); return }
      const ok = verifyChain(events)
      const broken = ok ? -1 : firstBrokenLink(events)
      const overrides = events.filter((e) => e.eventType === 'debug_override').length
      print(`events     ${events.length}`)
      print(`first hash ${events[0].hash}`)
      print(`last hash  ${events[events.length - 1].hash}`)
      if (overrides > 0) print(`debug overrides recorded in chain: ${overrides}`, 'warn')
      if (ok) print('PASS: every link checks out.', 'info')
      else print(`FAIL: first broken link at index ${broken} (${events[broken]?.eventType ?? 'unknown'}).`, 'err')
    },
    complete: (args) => (args.length <= 1 ? ['verify'].filter((c) => c.startsWith(args[0] ?? '')) : []),
  },
  {
    name: 'replay',
    group: 'verify',
    summary: 'Re-run the scenario from its deterministic inputs and compare (not available yet).',
    usage: 'replay verify',
    run: ({ args, print }) => {
      if (args[0]?.toLowerCase() !== 'verify') throw new Error('Usage: replay verify')
      const events = useDroneStore.getState().events
      const operatorCommands = events.filter((e) => e.eventType === 'operator_command').length
      const overrides = events.filter((e) => e.eventType === 'debug_override').length
      print(`NOT AVAILABLE: ${REPLAY_VERIFY_UNAVAILABLE}`, 'warn')
      print(`This run so far: ${operatorCommands} operator command(s), ${overrides} debug override(s). "chain verify" checks the evidence chain now.`)
    },
    complete: (args) => (args.length <= 1 ? ['verify'].filter((c) => c.startsWith(args[0] ?? '')) : []),
  },
  {
    name: 'overlay',
    group: 'overlay',
    summary: 'Show or hide a map layer, or "overlay list".',
    usage: 'overlay <name> [on|off] | overlay list',
    run: ({ args, print }) => {
      const names = layerNames()
      const name = args[0]
      if (!name || name.toLowerCase() === 'list') {
        const vis = useDroneStore.getState().ui.layerVisibility
        for (const n of names) print(`${n.padEnd(14)} ${vis[n] ? 'on' : 'off'}`)
        return
      }
      const key = names.find((n) => n.toLowerCase() === name.toLowerCase())
      if (!key) throw new Error(`Unknown layer "${name}". Layers: ${names.join(', ')}`)
      const mode = args[1]?.toLowerCase()
      if (mode !== undefined && mode !== 'on' && mode !== 'off') throw new Error('Use "on" or "off".')
      const s = useDroneStore.getState()
      const current = s.ui.layerVisibility[key]
      const want = mode === undefined ? !current : mode === 'on'
      if (want !== current) s.toggleLayer(key)
      print(`${key} ${want ? 'on' : 'off'}.`, 'info')
    },
    complete: (args) => {
      if (args.length <= 1) return ['list', ...layerNames()].filter((c) => c.toLowerCase().startsWith((args[0] ?? '').toLowerCase()))
      if (args.length === 2) return ['on', 'off'].filter((c) => c.startsWith(args[1] ?? ''))
      return []
    },
  },
  {
    name: 'hud',
    group: 'overlay',
    summary: 'Show or hide the tick/FPS debug HUD.',
    usage: 'hud [on|off]',
    run: ({ args, print }) => {
      const mode = args[0]?.toLowerCase()
      if (mode !== undefined && mode !== 'on' && mode !== 'off') throw new Error('Usage: hud [on|off]')
      const hud = useDebugHudStore.getState()
      const want = mode === undefined ? !hud.enabled : mode === 'on'
      hud.setEnabled(want)
      print(`HUD ${want ? 'on' : 'off'}.`, 'info')
    },
    complete: (args) => (args.length <= 1 ? ['on', 'off'].filter((c) => c.startsWith(args[0] ?? '')) : []),
  },
]
