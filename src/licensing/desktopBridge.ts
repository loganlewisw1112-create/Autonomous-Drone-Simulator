/**
 * Optional bridge injected by the Electron classroom shell preload.
 * Browser builds never set this — the web prompt stays probe-only.
 */

export interface ClassroomDesktopState {
  isDesktop: true
  promptHandled: boolean
  serverStarted: boolean
  serverOwned: boolean
  relayBaseUrl: string | null
  relayJoinBaseUrl: string | null
}

export type EntitlementStatus =
  | 'activation_required'
  | 'active'
  | 'warning'
  | 'verification_required'
  | 'clock_anomaly'
  | 'debrief'
  | 'expired'
  | 'revoked'
  | 'unsupported_version'
  | 'corrupt'

export interface DesktopEntitlementState {
  status: EntitlementStatus
  tier: 'selected_evaluator_demo' | 'agency_classroom_pilot' | null
  activatedAt: number | null
  expiresAt: number | null
  offlineUntil: number | null
  remainingMs: number | null
  canBeginNewActivity: boolean
  maxStudentsPerClass: number
  maxConcurrentClasses: number
  lastTrustedAt: number | null
  lastError: string | null
}

export type EntitlementOperationResult =
  | { ok: true; state: DesktopEntitlementState }
  | { ok: false; error: string; retryable: boolean; retryAfterSeconds: number | null }

export interface ClassroomDesktopBridge {
  isDesktop: true
  getState: () => ClassroomDesktopState
  provisionInstructorAccess: (
    code: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  getEntitlementState: () => DesktopEntitlementState
  activateEvaluatorCode: (code: string) => Promise<EntitlementOperationResult>
  refreshEntitlement: () => Promise<EntitlementOperationResult>
  subscribeEntitlementState: (listener: (state: DesktopEntitlementState) => void) => () => void
  exportEntitlementDiagnostics: () => Promise<
    { ok: true; filePath: string } | { ok: false; error: string }
  >
}

declare global {
  interface Window {
    classroomDesktop?: ClassroomDesktopBridge
  }
}

export function getClassroomDesktopBridge(): ClassroomDesktopBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = window.classroomDesktop
  if (!bridge
    || bridge.isDesktop !== true
    || typeof bridge.getState !== 'function'
    || typeof bridge.provisionInstructorAccess !== 'function'
    || typeof bridge.getEntitlementState !== 'function'
    || typeof bridge.activateEvaluatorCode !== 'function'
    || typeof bridge.refreshEntitlement !== 'function'
    || typeof bridge.subscribeEntitlementState !== 'function'
    || typeof bridge.exportEntitlementDiagnostics !== 'function') return null
  return bridge
}

/** True when Electron already showed the Start Classroom Server? splash. */
export function desktopPromptAlreadyHandled(): boolean {
  const bridge = getClassroomDesktopBridge()
  if (bridge) {
    try {
      return bridge.getState().promptHandled === true
    } catch {
      return true
    }
  }
  return false
}
