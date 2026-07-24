/**
 * Preload bridge for the classroom desktop shell.
 * Exposes a read-only snapshot so the React UI can skip the web Yes/No prompt
 * when Electron already handled the splash dialog.
 */
const { contextBridge } = require('electron')

function readState() {
  const injected = typeof globalThis !== 'undefined'
    ? globalThis.__CLASSROOM_DESKTOP_STATE__
    : undefined
  return {
    isDesktop: true,
    promptHandled: true,
    serverStarted: Boolean(injected?.serverStarted),
    serverOwned: Boolean(injected?.serverOwned),
    relayBaseUrl: typeof injected?.relayBaseUrl === 'string' ? injected.relayBaseUrl : null,
  }
}

contextBridge.exposeInMainWorld('classroomDesktop', {
  isDesktop: true,
  getState: () => readState(),
})
