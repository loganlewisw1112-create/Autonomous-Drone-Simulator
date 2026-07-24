/**
 * Optional bridge injected by the Electron classroom shell preload.
 * Browser builds never set this — web Yes/No stays honest (probe only).
 */

export interface ClassroomDesktopState {
  isDesktop: true
  promptHandled: boolean
  serverStarted: boolean
  serverOwned: boolean
  relayBaseUrl: string | null
}

export interface ClassroomDesktopBridge {
  isDesktop: true
  getState: () => ClassroomDesktopState
}

declare global {
  interface Window {
    classroomDesktop?: ClassroomDesktopBridge
    __CLASSROOM_DESKTOP_STATE__?: Omit<ClassroomDesktopState, 'isDesktop' | 'promptHandled'> & {
      promptHandled?: boolean
    }
  }
}

export function getClassroomDesktopBridge(): ClassroomDesktopBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = window.classroomDesktop
  if (!bridge || bridge.isDesktop !== true || typeof bridge.getState !== 'function') return null
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
  // Main also injects a raw snapshot before preload getState is used.
  const raw = typeof window !== 'undefined' ? window.__CLASSROOM_DESKTOP_STATE__ : undefined
  return raw?.promptHandled === true
}
