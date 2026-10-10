// Admin debug console: command contract. Fixed by the orchestrator so the
// console shell and each command pack can be built independently.

export type DebugLineKind = 'cmd' | 'out' | 'info' | 'warn' | 'err' | 'json'

export interface DebugLine {
  id: number
  kind: DebugLineKind
  text: string
  at: number
}

export type DebugCommandGroup =
  | 'system'     // help, clear, history, bind, build
  | 'inspect'    // status, drones, events, store, storage, errors, perf
  | 'export'     // export bundle
  | 'sim'        // pause, resume, step, seek, speed, restart, scenario load
  | 'fault'      // link/gps/motor faults, wind, battery (taints the run)
  | 'overlay'    // overlay toggles, tick/FPS HUD
  | 'verify'     // chain verify, replay verify
  | 'classroom'  // relay status, students, latency, relay errors
  | 'gates'      // unlock / gate status

export interface DebugCommandContext {
  /** Arguments after the command name, shell-style split (quotes respected). */
  args: string[]
  /** The full line as typed. */
  raw: string
  print: (text: string, kind?: DebugLineKind) => void
  /** Pretty-prints a value as JSON. */
  json: (value: unknown) => void
}

export interface DebugCommand {
  name: string
  aliases?: string[]
  group: DebugCommandGroup
  summary: string
  usage?: string
  /**
   * True when running the command changes simulation state or outcomes. The
   * registry marks the current run DEBUG-tainted (src/debug/taint.ts) before
   * running it, so the run is excluded from analytics and flagged in its
   * evidence record.
   */
  mutatesSim?: boolean
  run: (ctx: DebugCommandContext) => void | Promise<void>
  /** Tab-completion candidates for the argument currently being typed. */
  complete?: (args: string[]) => string[]
}
