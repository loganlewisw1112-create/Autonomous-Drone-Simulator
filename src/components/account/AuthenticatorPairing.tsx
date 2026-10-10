import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/store/authStore'
import { formatSecretForDisplay } from '@/account/totp'

// Optional authenticator-app pairing (RFC 6238). Nothing is saved until the user
// types a correct 6-digit code from the app, so a mistyped secret cannot leave the
// reset flow waiting on a code nobody can produce. Offline, this is a UI-level gate
// on password reset, not a cryptographic factor (see src/account/totp.ts).

async function qrDataUrl(uri: string): Promise<string | null> {
  try {
    const mod = await import('qrcode')
    const toString = mod.toString ?? mod.default?.toString
    const svg = await toString(uri, { type: 'svg', margin: 1, width: 176 })
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  } catch {
    return null // QR is a convenience; the secret text below always works
  }
}

export function AuthenticatorPairing({
  onDone,
  skipLabel = 'SKIP',
}: {
  /** `paired` is true when a code was verified and saved. */
  onDone: (paired: boolean) => void
  skipLabel?: string
}) {
  const { totpPairing, beginTotpPairing, confirmTotpPairing, cancelTotpPairing, authError } = useAuthStore(
    useShallow((s) => ({
      totpPairing: s.totpPairing, beginTotpPairing: s.beginTotpPairing,
      confirmTotpPairing: s.confirmTotpPairing, cancelTotpPairing: s.cancelTotpPairing,
      authError: s.authError,
    })),
  )
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    beginTotpPairing()
    return () => cancelTotpPairing()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once per mount; cancel on unmount
  }, [])

  const uri = totpPairing?.uri
  useEffect(() => {
    let cancelled = false
    setQr(null)
    if (uri) void qrDataUrl(uri).then((url) => { if (!cancelled) setQr(url) })
    return () => { cancelled = true }
  }, [uri])

  async function handleConfirm() {
    setBusy(true)
    try {
      if (await confirmTotpPairing(code)) onDone(true)
    } finally {
      setBusy(false)
      setCode('')
    }
  }

  return (
    <div data-testid="authenticator-pairing" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="modal-title">ADD AN AUTHENTICATOR APP (OPTIONAL)</div>
      <p style={{ fontSize: 'var(--fs-min)', color: 'var(--text-secondary)', margin: 0 }}>
        Scan the code with an authenticator app, or enter the secret by hand. Resetting a
        forgotten password will then ask for the app&apos;s 6-digit code as well as the recovery code.
      </p>
      {totpPairing && (
        <>
          {qr && (
            <img
              src={qr}
              alt="Authenticator app QR code"
              width={176}
              height={176}
              style={{ alignSelf: 'center', background: '#fff', borderRadius: 4 }}
            />
          )}
          <div style={{ fontSize: 'var(--fs-min)', color: 'var(--text-secondary)' }}>
            Secret for manual entry
            <div
              data-testid="totp-secret"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--accent-green)', userSelect: 'all', wordBreak: 'break-all' }}
            >
              {formatSecretForDisplay(totpPairing.secret)}
            </div>
          </div>
          <label style={{ fontSize: 'var(--fs-min)', color: 'var(--text-secondary)' }}>
            6-DIGIT CODE FROM THE APP
            <input
              className="account-input"
              style={{ marginTop: 4 }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && code && void handleConfirm()}
            />
          </label>
        </>
      )}
      {authError && (
        <span style={{ color: 'var(--accent-red)', fontSize: 12 }} data-testid="auth-error">✕ {authError}</span>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" disabled={busy || !totpPairing || !code} onClick={() => void handleConfirm()}>
          {busy ? 'WORKING…' : 'VERIFY AND SAVE'}
        </button>
        <button className="btn" onClick={() => onDone(false)}>{skipLabel}</button>
      </div>
    </div>
  )
}
