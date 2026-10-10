// Operator-injected faults (admin debug console only).
//
// The sim has no discrete "fault" object: link loss, GNSS outage and emergency landings are
// *consequences* modelled by the RF budget (SafetyManager.applyCommsModel), the GNSS evaluator
// (SimulationLoop) and the mission safety override (MissionManager.getMissionSafetyOverride).
// This registry is the single explicit input those three places consult, so an injected fault
// flows through exactly the same physics and mission logic as an authored one.
//
// Determinism: the registry is plain data set by an explicit command, never random, and every
// command that writes it is DEBUG-tainting (src/debug/taint.ts). It is empty by default and
// cleared on mission reset, so a clean run is unaffected.

export type InjectedFaultKind = 'link' | 'gps' | 'motor'

/** Extra path loss (dB) added to a drone's whole link while a link fault is injected.
 *  Large enough to drive reported RSSI to the model floor regardless of range or relays. */
export const INJECTED_LINK_JAM_DB = 120

const active: Record<InjectedFaultKind, Set<string>> = {
  link: new Set<string>(),
  gps: new Set<string>(),
  motor: new Set<string>(),
}

export function setInjectedFault(kind: InjectedFaultKind, droneId: string, on: boolean): void {
  if (on) active[kind].add(droneId)
  else active[kind].delete(droneId)
}

export function isFaultInjected(kind: InjectedFaultKind, droneId: string): boolean {
  return active[kind].has(droneId)
}

export function listInjectedFaults(): Array<{ kind: InjectedFaultKind; droneId: string }> {
  const out: Array<{ kind: InjectedFaultKind; droneId: string }> = []
  for (const kind of ['link', 'gps', 'motor'] as const) {
    for (const droneId of [...active[kind]].sort()) out.push({ kind, droneId })
  }
  return out
}

export function clearInjectedFaults(): void {
  for (const set of Object.values(active)) set.clear()
}
