// DEBUG taint for the current run. CONTRACT (fixed by the orchestrator):
//   markRunDebugTainted(reason)  — idempotent per run; appends reason
//   getRunDebugTaint()           — null when the run is clean
//   clearRunDebugTaint()         — called when a new run starts / mission resets
//
// Wiring (implemented here and in droneStore):
//   - every mark is RECORDED in the mission event hash chain as a `debug_override` event, via
//     the sink droneStore registers (this module must not import the store: droneStore imports
//     it to clear on resetMission, and a static import back would be a cycle);
//   - runRecorder copies the taint onto the saved summary (`debugTaint`), and analytics skip
//     any run carrying it.

export interface RunDebugTaint {
  firstAt: number
  reasons: string[]
}

/** Longest reason text stored in the taint and in the chain event. */
export const MAX_DEBUG_REASON_CHARS = 200

type TaintSink = (reason: string, info: { index: number; firstAt: number }) => void

let taint: RunDebugTaint | null = null
let sink: TaintSink | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Registered once by droneStore: appends the `debug_override` event to the hash chain. */
export function setTaintEventSink(next: TaintSink | null): void {
  sink = next
}

/** useSyncExternalStore-compatible subscription (HUD badge). */
export function subscribeRunDebugTaint(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function markRunDebugTainted(reason: string): void {
  const text = reason.length > MAX_DEBUG_REASON_CHARS ? `${reason.slice(0, MAX_DEBUG_REASON_CHARS - 1)}…` : reason
  if (!taint) taint = { firstAt: Date.now(), reasons: [] }
  taint.reasons.push(text)
  // A new object each mark so useSyncExternalStore snapshots change.
  taint = { firstAt: taint.firstAt, reasons: taint.reasons }
  sink?.(text, { index: taint.reasons.length - 1, firstAt: taint.firstAt })
  notify()
}

export function getRunDebugTaint(): RunDebugTaint | null {
  return taint
}

export function clearRunDebugTaint(): void {
  if (taint === null) return
  taint = null
  notify()
}
