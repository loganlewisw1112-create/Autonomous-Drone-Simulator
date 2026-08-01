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

export interface ClassroomDesktopBridge {
  isDesktop: true
  getState: () => ClassroomDesktopState
  provisionInstructorAccess: (
    code: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
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
    || typeof bridge.provisionInstructorAccess !== 'function') return null
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
