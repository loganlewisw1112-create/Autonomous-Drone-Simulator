import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/store/authStore'
import { AuthenticatorPairing } from '@/components/account/AuthenticatorPairing'

// Settings > ACCOUNT RECOVERY: set up / regenerate the recovery code and pair or
// unpair an authenticator app. Works for legacy accounts too: setting up recovery
// wraps the key the session already holds, so no saved mission is re-encrypted.
// The new code itself is shown by PostSignupRecovery (mounted beside the panels).
export function AccountRecoverySection() {
  const { activeAccount, storageReadOnly, setupRecovery, unpairTotp } = useAuthStore(
    useShallow((s) => ({
      activeAccount: s.activeAccount, storageReadOnly: s.storageReadOnly,
      setupRecovery: s.setupRecovery, unpairTotp: s.unpairTotp,
    })),
  )
  const [pairing, setPairing] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [confirmUnpair, setConfirmUnpair] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  if (!activeAccount) return null
  const configured = !!activeAccount.recoveryConfigured
  const paired = !!activeAccount.totpPaired

  async function handleSetup() {
    setBusy(true)
    setConfirmRegen(false)
    try {
      const code = await setupRecovery()
      setNote(code ? null : 'Recovery code could not be saved')
    } finally {
      setBusy(false)
    }
  }

  async function handleUnpair() {
    setConfirmUnpair(false)
    setNote((await unpairTotp()) ? 'Authenticator removed' : 'Could not remove the authenticator')
  }

  return (
    <div className="account-settings-section" data-testid="recovery-section">
      <span className="account-label">ACCOUNT RECOVERY</span>
      <p className="account-fineprint" data-testid="recovery-status">
        {configured
          ? 'Recovery code: set up. It can reset a forgotten password; saved missions stay readable.'
          : 'Recovery code: not set up. If you forget your password, this profile cannot be reset.'}
      </p>
      <div className="account-settings-row">
        {!configured || !confirmRegen ? (
          <button
            className="btn"
            disabled={busy || storageReadOnly}
            onClick={() => (configured ? setConfirmRegen(true) : void handleSetup())}
          >
            {configured ? 'REGENERATE RECOVERY CODE' : 'SET UP RECOVERY CODE'}
          </button>
        ) : (
          <>
            <span style={{ color: 'var(--accent-yellow)', fontSize: 12 }}>The current code will stop working. Continue?</span>
            <button className="btn danger" disabled={busy} onClick={() => void handleSetup()}>YES, REGENERATE</button>
            <button className="btn" onClick={() => setConfirmRegen(false)}>CANCEL</button>
          </>
        )}
      </div>

      <p className="account-fineprint" data-testid="authenticator-status">
        {paired
          ? 'Authenticator app: paired. Password reset asks for its 6-digit code as well as the recovery code.'
          : configured
            ? 'Authenticator app: not paired (optional).'
            : 'Authenticator app: set up a recovery code first.'}
        {' '}Offline, the authenticator is a screen-level check; the recovery code is what protects your data.
      </p>
      {pairing ? (
        <AuthenticatorPairing
          skipLabel="CANCEL"
          onDone={(done) => { setPairing(false); if (done) setNote('Authenticator paired') }}
        />
      ) : (
        <div className="account-settings-row">
          {!paired && (
            <button className="btn" disabled={!configured || storageReadOnly} onClick={() => { setNote(null); setPairing(true) }}>
              PAIR AUTHENTICATOR
            </button>
          )}
          {paired && !confirmUnpair && (
            <button className="btn warning" disabled={storageReadOnly} onClick={() => setConfirmUnpair(true)}>UNPAIR AUTHENTICATOR</button>
          )}
          {paired && confirmUnpair && (
            <>
              <span style={{ color: 'var(--accent-yellow)', fontSize: 12 }}>Remove the authenticator requirement?</span>
              <button className="btn danger" onClick={() => void handleUnpair()}>YES, UNPAIR</button>
              <button className="btn" onClick={() => setConfirmUnpair(false)}>CANCEL</button>
            </>
          )}
        </div>
      )}
      {note && <p className="account-status">{note}</p>}
    </div>
  )
}
