import { useId, useState, type FormEvent } from 'react'
import {
  getClassroomDesktopBridge,
  type DesktopEntitlementState,
} from '@/licensing/desktopBridge'

const ERROR_MESSAGES: Record<string, string> = {
  'invalid-code-format': 'Enter the complete evaluator code in ADMS-… format.',
  'code-unavailable': 'That code is invalid, expired, or has already been used. Ask the publisher to verify or replace it.',
  'rate-limited': 'Too many activation attempts were made. Wait for the stated retry period, then try again.',
  'service-unavailable': 'The licensing service cannot be reached. Check this computer’s Internet connection and try again.',
  'service-not-configured': 'This installation is missing its publisher licensing configuration. Reinstall from the official evaluator package.',
  'secure-storage-unavailable': 'Windows protected storage is unavailable. Sign in to Windows normally and restart the application.',
  'installation-already-licensed': 'This Windows installation already has an evaluator licence. Codes cannot be stacked.',
  'activation-required': 'Activate this evaluator installation before starting training.',
  revoked: 'This evaluator licence was revoked. Contact the publisher and include a diagnostics export.',
  expired: 'This evaluator term has ended. Saved records and exports remain available.',
  'unsupported-version': 'This application version is not allowed by the licence. Install the publisher-approved update.',
  'clock-anomaly': 'The Windows clock moved backward. Restore automatic date and time, connect to the Internet, and verify again.',
  'installation-state-corrupt': 'The protected installation identity cannot be read. Contact the publisher for an approved replacement.',
}

function stateMessage(state: DesktopEntitlementState): string {
  if (state.lastError && ERROR_MESSAGES[state.lastError]) return ERROR_MESSAGES[state.lastError]
  switch (state.status) {
    case 'verification_required':
      return 'The 72-hour offline allowance has ended. Connect to the Internet and verify the licence to resume training.'
    case 'clock_anomaly':
      return ERROR_MESSAGES['clock-anomaly']
    case 'revoked':
      return ERROR_MESSAGES.revoked
    case 'unsupported_version':
      return ERROR_MESSAGES['unsupported-version']
    case 'corrupt':
      return ERROR_MESSAGES['installation-state-corrupt']
    default:
      return 'Activate this selected-evaluator installation. The evaluation clock begins only after successful activation.'
  }
}

export function EntitlementActivation({ state }: { state: DesktopEntitlementState }) {
  const bridge = getClassroomDesktopBridge()
  const inputId = useId()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<string | null>(null)
  const canEnterCode = state.status === 'activation_required'

  const activate = async (event: FormEvent) => {
    event.preventDefault()
    if (!bridge || busy) return
    setBusy(true)
    setFeedback(null)
    const result = await bridge.activateEvaluatorCode(code)
    setCode('')
    setBusy(false)
    if (!result.ok) {
      const retry = result.retryAfterSeconds
        ? ` Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`
        : ''
      setFeedback(`${ERROR_MESSAGES[result.error] ?? 'Activation failed. Export diagnostics and contact the publisher.'}${retry}`)
    }
  }

  const refresh = async () => {
    if (!bridge || busy) return
    setBusy(true)
    setFeedback(null)
    const result = await bridge.refreshEntitlement()
    setBusy(false)
    if (!result.ok) setFeedback(ERROR_MESSAGES[result.error] ?? 'Verification failed. Check the connection and try again.')
  }

  const exportDiagnostics = async () => {
    if (!bridge || busy) return
    const result = await bridge.exportEntitlementDiagnostics()
    setDiagnostics(result.ok ? `Diagnostics saved to ${result.filePath}` : null)
    if (!result.ok && result.error !== 'cancelled') setFeedback('Diagnostics could not be exported. Check the selected folder and try again.')
  }

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24, background: '#071117', color: '#f4fbff' }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${inputId}-title`}
        style={{ width: 'min(100%, 620px)', padding: 28, border: '1px solid #2b8296', borderRadius: 8, background: '#102a34' }}
      >
        <p style={{ margin: '0 0 8px', color: '#71d7e8', font: '12px ui-monospace, monospace' }}>SELECTED EVALUATOR · WINDOWS</p>
        <h1 id={`${inputId}-title`} style={{ margin: '0 0 12px', fontSize: 26 }}>Evaluator access required</h1>
        <p style={{ lineHeight: 1.55 }}>{stateMessage(state)}</p>

        {canEnterCode && (
          <form onSubmit={(event) => void activate(event)}>
            <label htmlFor={inputId} style={{ display: 'block', marginBottom: 7, fontWeight: 700 }}>Evaluator redemption code</label>
            <input
              id={inputId}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="ADMS-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy || !bridge}
              aria-describedby={`${inputId}-help`}
              style={{ boxSizing: 'border-box', width: '100%', minHeight: 44, padding: '10px 12px', borderRadius: 4, border: '1px solid #81aeb9', font: '14px ui-monospace, monospace' }}
            />
            <p id={`${inputId}-help`} style={{ color: '#bad1d8', fontSize: 13 }}>
              One code activates one Windows installation. The 14-day or 90-day clock continues through sleep and shutdown.
            </p>
            <button type="submit" disabled={busy || !bridge || code.trim().length === 0} style={{ minHeight: 44, padding: '8px 18px', fontWeight: 700 }}>
              {busy ? 'Activating…' : 'Activate evaluator demo'}
            </button>
          </form>
        )}

        {!canEnterCode && ['verification_required', 'clock_anomaly'].includes(state.status) && (
          <button type="button" onClick={() => void refresh()} disabled={busy || !bridge} style={{ minHeight: 44, padding: '8px 18px', fontWeight: 700 }}>
            {busy ? 'Verifying…' : 'Verify licence now'}
          </button>
        )}

        {feedback && <p role="alert" style={{ color: '#ffb7b7', lineHeight: 1.45 }}>{feedback}</p>}
        {diagnostics && <p role="status" style={{ overflowWrap: 'anywhere', color: '#b9efc8' }}>{diagnostics}</p>}
        <hr style={{ border: 0, borderTop: '1px solid #31515b', margin: '24px 0 16px' }} />
        <button type="button" onClick={() => void exportDiagnostics()} disabled={busy || !bridge} style={{ minHeight: 40 }}>
          Export licence diagnostics
        </button>
        <p style={{ color: '#bad1d8', fontSize: 12, lineHeight: 1.5 }}>
          Diagnostics exclude redemption codes, private keys, student data, missions, IP addresses and coordinates.
        </p>
      </section>
    </main>
  )
}
