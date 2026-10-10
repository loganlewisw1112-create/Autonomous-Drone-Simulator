import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/store/authStore'

// "Forgot password?" flow: username + recovery code -> authenticator code (only if
// one is paired) -> new password twice. On success the store rotates the recovery
// code, signs the user in and raises PostSignupRecovery to show the new code once.

type Step = 'code' | 'totp' | 'password'

export function PasswordResetFlow({
  initialUsername = '',
  onCancel,
  variant = 'modal',
}: {
  initialUsername?: string
  onCancel: () => void
  /** 'classroom' uses the classroom form styling. */
  variant?: 'modal' | 'classroom'
}) {
  const { checkRecoveryCode, resetPasswordWithRecovery, authError, clearAuthError } = useAuthStore(
    useShallow((s) => ({
      checkRecoveryCode: s.checkRecoveryCode,
      resetPasswordWithRecovery: s.resetPasswordWithRecovery,
      authError: s.authError,
      clearAuthError: s.clearAuthError,
    })),
  )
  const [step, setStep] = useState<Step>('code')
  const [username, setUsername] = useState(initialUsername)
  const [recoveryCode, setRecoveryCode] = useState('')
  const [totp, setTotp] = useState('')
  const [totpRequired, setTotpRequired] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const cls = variant === 'classroom'
  const inputClass = cls ? 'cls-input' : 'account-input'
  const primaryClass = cls ? 'cls-btn' : 'btn primary'
  const secondaryClass = cls ? 'cls-btn ghost' : 'btn'
  const labelStyle = { fontSize: 'var(--fs-min)', color: 'var(--text-secondary)' }
  const error = localError ?? authError

  async function handleCode() {
    setBusy(true)
    setLocalError(null)
    try {
      const result = await checkRecoveryCode(username, recoveryCode)
      if (!result.ok) return
      setTotpRequired(result.totpRequired)
      setStep(result.totpRequired ? 'totp' : 'password')
    } finally {
      setBusy(false)
    }
  }

  async function handleReset() {
    setLocalError(null)
    if (password.length < 8) { setLocalError('Password must be at least 8 characters'); return }
    if (password.length > 128) { setLocalError('Password must be 128 characters or fewer'); return }
    if (password !== confirm) { setLocalError('The two passwords do not match'); return }
    setBusy(true)
    try {
      const result = await resetPasswordWithRecovery(username, recoveryCode, totpRequired ? totp : null, password)
      if (!result.ok) {
        // A wrong authenticator code sends the user back to that step; other errors stay here.
        if (totpRequired && useAuthStore.getState().authError?.includes('authenticator')) setStep('totp')
        return
      }
      onCancel() // signed in; the new recovery code now shows via PostSignupRecovery
    } finally {
      setBusy(false)
      setPassword('')
      setConfirm('')
    }
  }

  const back = () => { clearAuthError(); setLocalError(null); onCancel() }

  return (
    <div data-testid="password-reset" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {step === 'code' && (
        <>
          <label style={labelStyle}>
            USERNAME
            <input
              className={inputClass}
              style={{ marginTop: 4 }}
              value={username}
              maxLength={64}
              autoCapitalize="none"
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label style={labelStyle}>
            RECOVERY CODE
            <input
              className={inputClass}
              style={{ marginTop: 4 }}
              value={recoveryCode}
              maxLength={40}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              onChange={(e) => setRecoveryCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void handleCode()}
            />
          </label>
        </>
      )}

      {step === 'totp' && (
        <label style={labelStyle}>
          AUTHENTICATOR CODE (6 digits from your app)
          <input
            className={inputClass}
            style={{ marginTop: 4 }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && totp && setStep('password')}
          />
        </label>
      )}

      {step === 'password' && (
        <>
          <label style={labelStyle}>
            NEW PASSWORD (8-128 characters)
            <input
              className={inputClass}
              style={{ marginTop: 4 }}
              type="password"
              maxLength={128}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label style={labelStyle}>
            CONFIRM NEW PASSWORD
            <input
              className={inputClass}
              style={{ marginTop: 4 }}
              type="password"
              maxLength={128}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void handleReset()}
            />
          </label>
        </>
      )}

      {error && (
        <span style={{ color: cls ? '#ff8080' : 'var(--accent-red)', fontSize: 12 }} data-testid="auth-error">
          {cls ? error : `✕ ${error}`}
        </span>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
        {step === 'code' && (
          <button className={primaryClass} disabled={busy || !username.trim() || !recoveryCode.trim()} onClick={() => void handleCode()}>
            {busy ? 'CHECKING…' : 'CONTINUE'}
          </button>
        )}
        {step === 'totp' && (
          <button className={primaryClass} disabled={!totp.trim()} onClick={() => { clearAuthError(); setStep('password') }}>
            CONTINUE
          </button>
        )}
        {step === 'password' && (
          <button className={primaryClass} disabled={busy || !password || !confirm} onClick={() => void handleReset()}>
            {busy ? 'WORKING…' : 'RESET PASSWORD'}
          </button>
        )}
        <button className={secondaryClass} onClick={back}>BACK TO SIGN IN</button>
      </div>

      <p style={{ fontSize: 'var(--fs-min)', color: 'var(--text-dim)', margin: 0 }}>
        Resetting keeps your saved missions. The recovery code you just used stops working
        and a new one is shown once. Five wrong attempts pause recovery for 30 seconds.
      </p>
    </div>
  )
}
