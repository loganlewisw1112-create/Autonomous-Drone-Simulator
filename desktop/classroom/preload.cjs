/**
 * Preload bridge for the classroom desktop shell.
 * Exposes one schema-validated, read-only state query so the React UI can skip
 * the web Yes/No prompt when Electron already handled the splash dialog.
 */
const { contextBridge, ipcRenderer } = require('electron')

function readState() {
  const raw = ipcRenderer.sendSync('classroom-desktop:get-state')
  return {
    isDesktop: true,
    promptHandled: raw?.promptHandled === true,
    serverStarted: raw?.serverStarted === true,
    serverOwned: raw?.serverOwned === true,
    relayBaseUrl: typeof raw?.relayBaseUrl === 'string' ? raw.relayBaseUrl : null,
    relayJoinBaseUrl: typeof raw?.relayJoinBaseUrl === 'string' ? raw.relayJoinBaseUrl : null,
  }
}

contextBridge.exposeInMainWorld('classroomDesktop', Object.freeze({
  isDesktop: true,
  getState: () => readState(),
  /** @param {unknown} code */
  provisionInstructorAccess: async (code) => {
    if (typeof code !== 'string') return { ok: false, error: 'invalid-code-policy' }
    const normalized = code.normalize('NFKC')
    if (normalized.length < 12 || normalized.length > 128) {
      return { ok: false, error: 'invalid-code-policy' }
    }
    const result = await ipcRenderer.invoke('classroom-desktop:provision-instructor-access', normalized)
    return result?.ok === true
      ? { ok: true }
      : { ok: false, error: typeof result?.error === 'string' ? result.error : 'provision-failed' }
  },
}))
