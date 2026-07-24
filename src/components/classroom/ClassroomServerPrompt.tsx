import { useState } from 'react'
import {
  classroomSetupInstructions,
  markClassroomServerPromptResolved,
  probeClassroomRelay,
  type ClassroomProbeResult,
} from '@/classroom/serverProbe'

/**
 * Web / hosted classroom splash — mirrors the desktop Yes/No intent without
 * pretending a browser can spawn Node.
 *
 * Yes → probe localhost (and page host when not a hosted showcase).
 * No → show short setup, then continue into classroom UI.
 */
export function ClassroomServerPrompt({ onResolved }: { onResolved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'ask' | 'setup' | 'probe-result'>('ask')
  const [probe, setProbe] = useState<ClassroomProbeResult | null>(null)

  const finish = () => {
    markClassroomServerPromptResolved()
    onResolved()
  }

  const onYes = async () => {
    setBusy(true)
    setProbe(null)
    try {
      const configured = import.meta.env.VITE_CLASSROOM_RELAY_URL
      const result = await probeClassroomRelay({
        locationOrigin: typeof location !== 'undefined' ? location.origin : undefined,
        configuredBase: typeof configured === 'string' && configured ? configured : null,
      })
      setProbe(result)
      setPhase('probe-result')
    } finally {
      setBusy(false)
    }
  }

  const onNo = () => {
    setPhase('setup')
  }

  return (
    <div className="cls-center" data-testid="classroom-server-prompt">
      <div className="cls-card" style={{ maxWidth: 460 }}>
        {phase === 'ask' && (
          <>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Classroom Server</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.5 }}>
              Start the Classroom Server on this PC?
              <br />
              <br />
              Browser demos cannot spawn Node. Choosing Yes only probes this machine
              (or the page host) for an already-running LAN relay — it does not start one.
              Use the Windows desktop classroom app to auto-start the relay.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="cls-btn"
                data-testid="classroom-server-yes"
                disabled={busy}
                onClick={() => void onYes()}
              >
                {busy ? 'Probing…' : 'Yes — probe for server'}
              </button>
              <button
                type="button"
                className="cls-btn ghost"
                data-testid="classroom-server-no"
                disabled={busy}
                onClick={onNo}
              >
                No — show setup
              </button>
            </div>
          </>
        )}

        {phase === 'probe-result' && probe && (
          <>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {probe.ok ? 'Classroom Server found' : 'Classroom Server not found'}
            </div>
            <div
              style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.5 }}
              data-testid="classroom-server-probe-result"
            >
              {probe.ok ? (
                <>
                  Relay responded at <code style={{ fontFamily: 'var(--font-mono)' }}>{probe.baseUrl}</code>.
                  Live class features can use this host when you open it on the same address.
                </>
              ) : (
                <>
                  No healthy relay at the probed addresses
                  {probe.tried.length > 0 && (
                    <>
                      {' '}({probe.tried.join(', ')})
                    </>
                  )}
                  . Reason: {probe.reason}. Hosted demos cannot start the server — run the
                  desktop app (<code style={{ fontFamily: 'var(--font-mono)' }}>npm run classroom:desktop</code>)
                  or <code style={{ fontFamily: 'var(--font-mono)' }}>npm run classroom</code> on the instructor PC.
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" className="cls-btn" data-testid="classroom-server-continue" onClick={finish}>
                Continue
              </button>
              {!probe.ok && (
                <button
                  type="button"
                  className="cls-btn ghost"
                  data-testid="classroom-server-show-setup"
                  onClick={() => setPhase('setup')}
                >
                  Show setup
                </button>
              )}
            </div>
          </>
        )}

        {phase === 'setup' && (
          <>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Classroom setup</div>
            <pre
              data-testid="classroom-server-setup"
              style={{
                fontSize: 11,
                color: 'var(--text-dim)',
                marginTop: 8,
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {classroomSetupInstructions()}
            </pre>
            <button
              type="button"
              className="cls-btn"
              data-testid="classroom-server-continue"
              style={{ marginTop: 14 }}
              onClick={finish}
            >
              Continue without starting a server
            </button>
          </>
        )}
      </div>
    </div>
  )
}
