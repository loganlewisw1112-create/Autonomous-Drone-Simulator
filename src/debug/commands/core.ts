import { BUILD_INFO } from '@/components/BuildInfoFooter'
import { listClassroomSessions, listClassrooms, listMissions, listRunDetails, listRuns } from '@/account/accountDb'
import { getBindings, removeBinding, setBinding } from '@/debug/bindings'
import { useConsoleStore } from '@/debug/consoleStore'
import { clearErrorLog, getErrorLog } from '@/debug/errorLog'
import { getDebugCommand, listDebugCommands } from '@/debug/registry'
import { getRunDebugTaint } from '@/debug/taint'
import type { DebugCommand, DebugCommandGroup } from '@/debug/types'
import { useAuthStore } from '@/store/authStore'
import { useDroneStore } from '@/store/droneStore'
import { useMobileStore } from '@/store/mobileStore'

// ── Redaction ────────────────────────────────────────────────────────────────
// Everything the console prints or exports about store state goes through
// `sanitize`: a key whose NAME looks like key material, a credential or recovery
// data is replaced, and binary buffers are never rendered.
const SECRET_KEY = /key|secret|passw|passphrase|adminpass|token|recovery(?!team)|salt|cipher|totp|authenticator|credential|^pass$/i
const REDACTED = '[redacted]'

export interface SanitizeOptions {
  maxDepth?: number
  maxArray?: number
  maxString?: number
}

export function isSecretKey(name: string): boolean {
  return SECRET_KEY.test(name)
}

export function sanitize(value: unknown, options: SanitizeOptions = {}, depth = 0, seen = new WeakSet<object>()): unknown {
  const { maxDepth = 6, maxArray = 50, maxString = 500 } = options
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}…(+${value.length - maxString})` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[bytes ${value.byteLength}]`
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[cycle]'
  if (depth >= maxDepth) return '[depth limit]'
  seen.add(value)
  if (Array.isArray(value)) {
    const head = value.slice(0, maxArray).map((item) => sanitize(item, options, depth + 1, seen))
    return value.length > maxArray ? [...head, `…+${value.length - maxArray} more`] : head
  }
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === 'function') continue
    out[key] = isSecretKey(key) ? REDACTED : sanitize(inner, options, depth + 1, seen)
  }
  return out
}

// ── Store access ─────────────────────────────────────────────────────────────
const STORE_ROOTS: Record<string, () => unknown> = {
  droneStore: () => useDroneStore.getState(),
  authStore: () => useAuthStore.getState(),
  mobileStore: () => useMobileStore.getState(),
}
const STORE_ALIASES: Record<string, string> = { drone: 'droneStore', auth: 'authStore', mobile: 'mobileStore' }

function nonFunctionKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>)
    .filter(([key, inner]) => typeof inner !== 'function' && !isSecretKey(key))
    .map(([key]) => key)
}

/** Resolve a dotted path into one of the three stores. Throws on a missing or secret segment. */
export function resolveStorePath(path: string): unknown {
  const [rootName, ...rest] = path.split('.').filter(Boolean)
  const root = STORE_ROOTS[STORE_ALIASES[rootName] ?? rootName]
  if (!root) throw new Error(`Unknown store "${rootName}". Try: ${Object.keys(STORE_ROOTS).join(', ')}`)
  let cursor: unknown = root()
  const walked = [rootName]
  for (const segment of rest) {
    if (isSecretKey(segment)) throw new Error(`"${segment}" is redacted (key material, credentials and recovery data are never shown).`)
    if (cursor === null || typeof cursor !== 'object' || !(segment in (cursor as Record<string, unknown>))) {
      throw new Error(`No such path: ${[...walked, segment].join('.')}`)
    }
    cursor = (cursor as Record<string, unknown>)[segment]
    walked.push(segment)
  }
  return cursor
}

// ── Build info / bundle ──────────────────────────────────────────────────────
function buildInfo() {
  return { ...BUILD_INFO, mode: import.meta.env.MODE }
}

export function buildDebugBundle(): Record<string, unknown> {
  const s = useDroneStore.getState()
  const auth = useAuthStore.getState().activeAccount
  const generous: SanitizeOptions = { maxArray: 500, maxString: 2000 }
  return sanitize({
    generatedAt: new Date().toISOString(),
    admin: auth?.adminEmail ?? null,
    build: buildInfo(),
    scenario: s.scenario ? { id: s.scenario.id, name: s.scenario.name, seed: s.scenario.seed } : null,
    scenarioVariant: s.scenarioVariant,
    launchPlan: s.launchPlan,
    taint: getRunDebugTaint(),
    droneStore: {
      tick: s.tick,
      elapsedSec: s.elapsedSec,
      lifecycle: s.lifecycle,
      ui: s.ui,
      metrics: s.metrics,
      drones: s.drones,
      eventsTotal: s.events.length,
      events: s.events.slice(-500),
    },
    errors: getErrorLog(),
    binds: getBindings(),
  }, { ...generous, maxDepth: 8 }) as Record<string, unknown>
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke after the click has been dispatched so the download is not cancelled.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ── Text helpers ─────────────────────────────────────────────────────────────
function pad(value: unknown, width: number): string {
  const text = String(value)
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length)
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return 'n/a'
  if (bytes > 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function parseCount(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : fallback
}

const GROUP_ORDER: DebugCommandGroup[] = ['system', 'inspect', 'export', 'sim', 'fault', 'overlay', 'verify', 'classroom', 'gates']

// ── Optional admin overrides list ────────────────────────────────────────────
// `src/account/adminOverride.ts` is owned by the admin work. The glob resolves to
// nothing until that file exists, so this command works either way.
const adminOverrideModules = import.meta.glob('../../account/adminOverride.ts') as Record<string, () => Promise<Record<string, unknown>>>

async function loadAdminOverrides(): Promise<unknown[] | null> {
  const loader = Object.values(adminOverrideModules)[0]
  if (!loader) return null
  const mod = await loader()
  const list = Object.values(mod).find((exported) => Array.isArray(exported))
  return Array.isArray(list) ? list : []
}

// ── Commands ─────────────────────────────────────────────────────────────────
// None of the commands in this pack set mutatesSim: they read state, change the
// console itself, or download a file.
export const coreCommands: DebugCommand[] = [
  {
    name: 'help',
    aliases: ['?'],
    group: 'system',
    summary: 'List commands by group, or show usage for one command.',
    usage: 'help [command]',
    complete: (args) => (args.length <= 1 ? listDebugCommands().map((c) => c.name) : []),
    run: ({ args, print }) => {
      if (args[0]) {
        const command = getDebugCommand(args[0])
        if (!command) { print(`Unknown command: ${args[0]}`, 'err'); return }
        print(`${command.name}${command.aliases?.length ? ` (${command.aliases.join(', ')})` : ''} [${command.group}]`, 'info')
        print(command.summary)
        print(`usage: ${command.usage ?? command.name}`)
        if (command.mutatesSim) print('Changes simulation state: marks this run DEBUG-tainted.', 'warn')
        return
      }
      const all = listDebugCommands()
      for (const group of GROUP_ORDER) {
        const inGroup = all.filter((c) => c.group === group)
        if (inGroup.length === 0) continue
        print(`${group.toUpperCase()}`, 'info')
        for (const c of inGroup) print(`  ${pad(c.name, 14)}${c.summary}${c.mutatesSim ? '  [taints run]' : ''}`)
      }
      print('Ctrl+` (or Ctrl+Shift+D) toggles this console. Tab completes. Up/Down walks history.', 'info')
    },
  },
  {
    name: 'clear',
    aliases: ['cls'],
    group: 'system',
    summary: 'Clear the console scrollback.',
    run: () => useConsoleStore.getState().clear(),
  },
  {
    name: 'history',
    group: 'system',
    summary: 'Show the commands you have typed (stored per admin on this device).',
    run: ({ print }) => {
      const { history } = useConsoleStore.getState()
      if (history.length === 0) { print('No history yet.', 'info'); return }
      history.forEach((line, index) => print(`${pad(index + 1, 4)}${line}`))
    },
  },
  {
    name: 'bind',
    group: 'system',
    summary: 'Bind a hotkey to a command line.',
    usage: 'bind <combo> "<command line>"   e.g. bind ctrl+shift+p "pause"',
    run: ({ args, print }) => {
      const [combo, ...rest] = args
      if (!combo || rest.length === 0) { print('usage: bind <combo> "<command line>"', 'err'); return }
      const canonical = setBinding(combo, rest.join(' '))
      if (!canonical) { print(`Could not parse key combo "${combo}". Use modifiers like ctrl+shift+f9.`, 'err'); return }
      print(`Bound ${canonical} -> ${rest.join(' ')}`, 'info')
    },
  },
  {
    name: 'unbind',
    group: 'system',
    summary: 'Remove a hotkey binding.',
    usage: 'unbind <combo>',
    complete: () => Object.keys(getBindings()),
    run: ({ args, print }) => {
      if (!args[0]) { print('usage: unbind <combo>', 'err'); return }
      print(removeBinding(args[0]) ? `Unbound ${args[0]}` : `No binding for ${args[0]}`, 'info')
    },
  },
  {
    name: 'binds',
    group: 'system',
    summary: 'List hotkey bindings.',
    run: ({ print }) => {
      const entries = Object.entries(getBindings())
      if (entries.length === 0) { print('No bindings. Try: bind ctrl+shift+p "pause"', 'info'); return }
      for (const [combo, line] of entries) print(`${pad(combo, 22)}${line}`)
    },
  },
  {
    name: 'build',
    group: 'system',
    summary: 'Git SHA, target, version and channel of this build.',
    run: ({ json }) => json(buildInfo()),
  },
  {
    name: 'status',
    group: 'inspect',
    summary: 'Tick, run state, speed, scenario, lifecycle, drone count, replay mode, taint.',
    run: ({ json }) => {
      const s = useDroneStore.getState()
      json({
        tick: s.tick,
        elapsedSec: Number(s.elapsedSec.toFixed(2)),
        running: s.ui.isRunning,
        simSpeed: s.ui.simSpeed,
        scenario: s.scenario ? { id: s.scenario.id, name: s.scenario.name } : null,
        lifecycle: s.lifecycle,
        drones: s.drones.length,
        replayMode: s.ui.isReplayMode,
        taint: getRunDebugTaint(),
      })
    },
  },
  {
    name: 'drones',
    group: 'inspect',
    summary: 'Compact table of every drone.',
    run: ({ print }) => {
      const { drones } = useDroneStore.getState()
      if (drones.length === 0) { print('No drones loaded.', 'info'); return }
      print(`${pad('id', 12)}${pad('state', 18)}${pad('bat%', 7)}${pad('alt ft', 8)}${pad('m/s', 7)}${pad('wp', 4)}flags`, 'info')
      for (const d of drones) {
        const flags = [d.conflictFlag && 'conflict', d.geofenceBreachFlag && 'geofence', d.bvlosFlag && 'bvlos', d.weatherDivertFlag && 'wx'].filter(Boolean).join(',')
        print(`${pad(d.id, 12)}${pad(d.missionState, 18)}${pad(d.batteryPct.toFixed(0), 7)}${pad(d.altitudeFt.toFixed(0), 8)}${pad(d.speedMs.toFixed(1), 7)}${pad(d.currentWaypointIndex, 4)}${flags}`)
      }
    },
  },
  {
    name: 'drone',
    group: 'inspect',
    summary: 'Full state of one drone.',
    usage: 'drone <id>',
    complete: (args) => (args.length <= 1 ? useDroneStore.getState().drones.map((d) => d.id) : []),
    run: ({ args, print, json }) => {
      const wanted = args[0]?.toLowerCase()
      if (!wanted) { print('usage: drone <id>', 'err'); return }
      const drone = useDroneStore.getState().drones.find((d) => d.id.toLowerCase() === wanted || d.label.toLowerCase() === wanted)
      if (!drone) { print(`No drone "${args[0]}". Use "drones" to list ids.`, 'err'); return }
      json(sanitize(drone))
    },
  },
  {
    name: 'events',
    group: 'inspect',
    summary: 'Most recent mission events (chain-of-custody log).',
    usage: 'events [n] [type]',
    run: ({ args, print }) => {
      const n = parseCount(args.find((a) => /^\d+$/.test(a)), 20)
      const type = args.find((a) => !/^\d+$/.test(a))?.toLowerCase()
      const events = useDroneStore.getState().events.filter((e) => !type || String(e.eventType).toLowerCase() === type)
      if (events.length === 0) { print(type ? `No "${type}" events.` : 'No events yet.', 'info'); return }
      for (const e of events.slice(-n)) {
        print(`#${pad(e.tick, 6)}${pad(e.eventType, 24)}${pad(e.droneId, 10)}${JSON.stringify(sanitize(e.payload, { maxDepth: 3, maxString: 120 }))}`)
      }
      print(`${Math.min(n, events.length)} of ${events.length}`, 'info')
    },
  },
  {
    name: 'store',
    group: 'inspect',
    summary: 'Read-only view into droneStore / authStore / mobileStore (secrets redacted).',
    usage: 'store <dotted.path>   e.g. store droneStore.ui.simSpeed',
    complete: (args) => {
      if (args.length > 1) return []
      const partial = args[0] ?? ''
      const segments = partial.split('.')
      const last = segments.pop() ?? ''
      try {
        if (segments.length === 0) return [...Object.keys(STORE_ROOTS)].filter((k) => k.startsWith(last))
        const parent = resolveStorePath(segments.join('.'))
        return nonFunctionKeys(parent).filter((k) => k.startsWith(last)).map((k) => [...segments, k].join('.'))
      } catch {
        return []
      }
    },
    run: ({ args, print, json }) => {
      if (!args[0]) {
        print('Stores: droneStore, authStore, mobileStore (aliases drone, auth, mobile)', 'info')
        print('usage: store <dotted.path>', 'info')
        return
      }
      const value = resolveStorePath(args[0])
      if (typeof value === 'function') { print('[function]', 'info'); return }
      const keys = nonFunctionKeys(value)
      if (args[0].split('.').length === 1 && keys.length > 0) {
        print(`${args[0]} keys: ${keys.join(', ')}`, 'info')
        return
      }
      json(sanitize(value))
    },
  },
  {
    name: 'storage',
    group: 'inspect',
    summary: 'Browser storage estimate and this account\'s record counts.',
    run: async ({ print, json }) => {
      const estimate = await navigator.storage?.estimate?.().catch(() => undefined)
      print(`usage ${formatBytes(estimate?.usage)} of quota ${formatBytes(estimate?.quota)}`, 'info')
      const accountId = useAuthStore.getState().activeAccount?.id
      if (!accountId) { print('No signed-in account: record counts unavailable.', 'warn'); return }
      const [runs, details, missions, classrooms, sessions] = await Promise.allSettled([
        listRuns(accountId), listRunDetails(accountId), listMissions(accountId), listClassrooms(accountId), listClassroomSessions(accountId),
      ])
      const count = (r: PromiseSettledResult<unknown[]>) => (r.status === 'fulfilled' ? r.value.length : `error: ${String(r.reason)}`)
      json({ runs: count(runs), runDetails: count(details), customMissions: count(missions), classrooms: count(classrooms), classroomSessions: count(sessions) })
    },
  },
  {
    name: 'errors',
    group: 'inspect',
    summary: 'Recent captured errors (window errors, unhandled rejections, console.error).',
    usage: 'errors [n] | errors clear',
    run: ({ args, print }) => {
      if (args[0] === 'clear') { clearErrorLog(); print('Error log cleared.', 'info'); return }
      const log = getErrorLog()
      if (log.length === 0) { print('No errors captured this session.', 'info'); return }
      for (const entry of log.slice(-parseCount(args[0], 20))) {
        print(`${new Date(entry.at).toLocaleTimeString()} [${entry.source}] ${entry.message}`, 'err')
      }
      print(`${Math.min(parseCount(args[0], 20), log.length)} of ${log.length}`, 'info')
    },
  },
  {
    name: 'perf',
    group: 'inspect',
    summary: 'Frame time / FPS over about one second, plus the sim tick rate.',
    run: ({ print, json }) =>
      new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame !== 'function') { print('requestAnimationFrame is unavailable here.', 'warn'); resolve(); return }
        const startTick = useDroneStore.getState().tick
        const startedAt = performance.now()
        let last = startedAt
        let frames = 0
        let worst = 0
        const finish = () => {
          const elapsed = (performance.now() - startedAt) / 1000
          if (frames === 0) { print('No frames rendered (tab hidden?). Bring the tab to the front and retry.', 'warn'); resolve(); return }
          json({
            fps: Number((frames / elapsed).toFixed(1)),
            avgFrameMs: Number(((elapsed * 1000) / frames).toFixed(2)),
            worstFrameMs: Number(worst.toFixed(2)),
            simTicksPerSec: Number(((useDroneStore.getState().tick - startTick) / elapsed).toFixed(1)),
            simRunning: useDroneStore.getState().ui.isRunning,
          })
          resolve()
        }
        const timeout = window.setTimeout(finish, 2500)
        const frame = (now: number) => {
          frames += 1
          worst = Math.max(worst, now - last)
          last = now
          if (now - startedAt < 1000) { requestAnimationFrame(frame); return }
          window.clearTimeout(timeout)
          finish()
        }
        requestAnimationFrame(frame)
      }),
  },
  {
    name: 'export',
    group: 'export',
    summary: 'Download a redacted JSON debug bundle (build, scenario, plan, state, errors, taint, binds).',
    usage: 'export bundle',
    complete: (args) => (args.length <= 1 ? ['bundle'] : []),
    run: ({ args, print }) => {
      if (args[0] !== 'bundle') { print('usage: export bundle', 'err'); return }
      const bundle = buildDebugBundle()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      downloadJson(`drone-sim-debug-${stamp}.json`, bundle)
      print(`Debug bundle downloaded (${Math.round(JSON.stringify(bundle).length / 1024)} KB). Secrets, keys and recovery data are redacted.`, 'info')
    },
  },
  {
    name: 'gates',
    group: 'gates',
    summary: 'Read-only: is this profile admin, and which admin overrides apply.',
    run: async ({ print }) => {
      const account = useAuthStore.getState().activeAccount
      print(account?.isAdmin ? `Admin: yes (${account.adminEmail})` : 'Admin: no', account?.isAdmin ? 'info' : 'warn')
      const overrides = await loadAdminOverrides()
      if (overrides === null) { print('Admin override list is not available in this build (src/account/adminOverride.ts).', 'info'); return }
      if (overrides.length === 0) { print('No admin overrides defined.', 'info'); return }
      print('Admin overrides:', 'info')
      for (const entry of overrides) print(`  ${typeof entry === 'string' ? entry : JSON.stringify(sanitize(entry, { maxDepth: 3 }))}`)
    },
  },
]
