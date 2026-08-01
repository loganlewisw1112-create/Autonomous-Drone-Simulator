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

const entitlementStatuses = new Set([
  'activation_required', 'active', 'warning', 'verification_required',
  'clock_anomaly', 'debrief', 'expired', 'revoked', 'unsupported_version', 'corrupt',
])

function finiteOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null
}

function readEntitlementState(raw = ipcRenderer.sendSync('classroom-desktop:get-entitlement-state')) {
  return Object.freeze({
    status: entitlementStatuses.has(raw?.status) ? raw.status : 'corrupt',
    tier: raw?.tier === 'selected_evaluator_demo' || raw?.tier === 'agency_classroom_pilot'
      ? raw.tier
      : null,
    activatedAt: finiteOrNull(raw?.activatedAt),
    expiresAt: finiteOrNull(raw?.expiresAt),
    offlineUntil: finiteOrNull(raw?.offlineUntil),
    remainingMs: finiteOrNull(raw?.remainingMs),
    canBeginNewActivity: raw?.canBeginNewActivity === true,
    maxStudentsPerClass: Number.isSafeInteger(raw?.maxStudentsPerClass)
      ? Math.max(0, Math.min(40, raw.maxStudentsPerClass))
      : 0,
    maxConcurrentClasses: raw?.maxConcurrentClasses === 1 ? 1 : 0,
    lastTrustedAt: finiteOrNull(raw?.lastTrustedAt),
    lastError: typeof raw?.lastError === 'string' ? raw.lastError.slice(0, 80) : null,
  })
}

function sanitizeOperationResult(result, fallback) {
  if (result?.ok === true) return { ok: true, state: readEntitlementState(result.state) }
  return {
    ok: false,
    error: typeof result?.error === 'string' ? result.error.slice(0, 80) : fallback,
    retryable: result?.retryable === true,
    retryAfterSeconds: Number.isFinite(result?.retryAfterSeconds)
      ? Math.max(0, Math.min(86_400, result.retryAfterSeconds))
      : null,
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
  getEntitlementState: () => readEntitlementState(),
  activateEvaluatorCode: async (code) => {
    if (typeof code !== 'string' || code.length > 80) {
      return { ok: false, error: 'invalid-code-format', retryable: false, retryAfterSeconds: null }
    }
    const result = await ipcRenderer.invoke('classroom-desktop:activate-entitlement', code)
    return sanitizeOperationResult(result, 'activation-failed')
  },
  refreshEntitlement: async () => sanitizeOperationResult(
    await ipcRenderer.invoke('classroom-desktop:refresh-entitlement'),
    'refresh-failed',
  ),
  subscribeEntitlementState: (listener) => {
    if (typeof listener !== 'function') return () => {}
    const handler = (_event, state) => listener(readEntitlementState(state))
    ipcRenderer.on('classroom-desktop:entitlement-state', handler)
    return () => ipcRenderer.removeListener('classroom-desktop:entitlement-state', handler)
  },
  exportEntitlementDiagnostics: async () => {
    const result = await ipcRenderer.invoke('classroom-desktop:export-entitlement-diagnostics')
    return result?.ok === true && typeof result?.filePath === 'string'
      ? { ok: true, filePath: result.filePath }
      : { ok: false, error: typeof result?.error === 'string' ? result.error : 'export-failed' }
  },
}))

globalThis.addEventListener?.('online', () => {
  void ipcRenderer.invoke('classroom-desktop:refresh-entitlement')
})
