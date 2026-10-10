// Single switch for ADMIN access overrides. A verified, un-revoked admin pass on
// the active profile (ActiveAccount.isAdmin, set by authStore.toActive after
// re-verifying the pass) lets the owners walk past ACCESS gates: authorization
// training, instructor unlock, the demo/licence window.
//
// Rules every call site follows:
//   - The bypass is always visible (an "ADMIN override" label), never silent.
//   - Where a gate feeds the mission evidence chain, the override is recorded as
//     an event (see recordAdminOverride) instead of faking the gate as completed.
//   - Sim rules (weather no-launch, physical-safety limits) are NOT access gates
//     and are never bypassed from here.

import { useAuthStore } from '@/store/authStore'

export const ADMIN_OVERRIDE_LABEL = 'ADMIN override'

export function isAdminActive(): boolean {
  return useAuthStore.getState().activeAccount?.isAdmin === true
}

export function useIsAdmin(): boolean {
  return useAuthStore((s) => s.activeAccount?.isAdmin === true)
}

/** Payload for the evidence event that records a gate being bypassed. */
export function adminOverridePayload(gate: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'admin_override',
    gate,
    adminEmail: useAuthStore.getState().activeAccount?.adminEmail ?? null,
    simulationOnly: true,
    ...extra,
  }
}
