import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore, listAccounts } from '@/store/authStore'
import { PostSignupRecovery } from '@/components/account/PostSignupRecovery'
import { PasswordResetFlow } from '@/components/account/PasswordResetFlow'
import type { AccountRecord } from '@/account/types'

// Local-profile sign-in / sign-up. Rendered by both shells (lazy). Everything
// stays on this device: profiles are IndexedDB records, passwords never leave
// the browser, run history is AES-256-GCM encrypted with the derived key.
export function SignInModal() {
  const { showSignIn, setShowSignIn, signIn, signUp, authError, clearAuthError, storageAvailable } = useAuthStore(
    useShallow((s) => ({
      showSignIn: s.showSignIn, setShowSignIn: s.setShowSignIn,
      signIn: s.signIn, signUp: s.signUp,
      authError: s.authError, clearAuthError: s.clearAuthError,
      storageAvailable: s.storageAvailable,
    })),
  )

  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin')
  const [profiles, setProfiles] = useState<AccountRecord[]>([])
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!showSignIn) return
    void listAccounts().then((accounts) => {
      setProfiles(accounts)
      setMode(accounts.length === 0 ? 'signup' : 'signin')
    })
  }, [showSignIn])

  // The recovery-code overlay outlives the form: signup closes the modal first.
  if (!showSignIn) return <PostSignupRecovery />

  async function handleSubmit() {
    setBusy(true)
    try {
      if (mode === 'signup') await signUp(username, displayName, password)
      else await signIn(username, password)
    } finally {
      setBusy(false)
      setPassword('')
    }
  }

  const switchMode = (next: 'signin' | 'signup' | 'reset') => {
    setMode(next)
    clearAuthError()
  }

  return (
    <>
    <PostSignupRecovery />
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowSignIn(false)}>
      <div className="modal" data-testid="signin-modal">
        <div className="modal-title">
          {mode === 'signup' ? 'CREATE OPERATOR PROFILE' : mode === 'reset' ? 'RESET FORGOTTEN PASSWORD' : 'OPERATOR SIGN IN'}
        </div>

        {!storageAvailable && (
          <p style={{ color: 'var(--accent-yellow)', fontSize: 12, marginBottom: 12 }}>
            ⚠ Device storage unavailable (private browsing?). Profiles can't be saved here —
            the simulator remains fully usable without an account.
          </p>
        )}

        {mode === 'reset' ? (
          <PasswordResetFlow initialUsername={username} onCancel={() => switchMode('signin')} />
        ) : (<>
        {mode === 'signin' && profiles.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {profiles.map((p) => (
              <button
                key={p.id}
                className={`btn${username === p.username ? ' active' : ''}`}
                onClick={() => setUsername(p.username)}
              >
                ◉ {p.displayName}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 'var(--fs-min)', color: 'var(--text-secondary)' }}>
            USERNAME
            <input
              className="account-input"
              style={{ marginTop: 4 }}
              value={username}
              maxLength={64}
              autoCapitalize="none"
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>

          {mode === 'signup' && (
            <label style={{ fontSize: 'var(--fs-min)', color: 'var(--text-secondary)' }}>
              OPERATOR ALIAS (shown in mission logs; do not use a real name for classroom pilots)
              <input
                className="account-input"
                style={{ marginTop: 4 }}
                value={displayName}
                maxLength={64}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
          )}

          <label style={{ fontSize: 'var(--fs-min)', color: 'var(--text-secondary)' }}>
            PASSWORD {mode === 'signup' && '(min 8 chars; you will get a recovery code next)'}
            <input
              className="account-input"
              style={{ marginTop: 4 }}
              type="password"
              maxLength={128}
              value={password}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void handleSubmit()}
            />
          </label>

          {authError && (
            <span style={{ color: 'var(--accent-red)', fontSize: 12 }} data-testid="auth-error">✕ {authError}</span>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn primary" onClick={() => void handleSubmit()} disabled={busy || !storageAvailable}>
              {busy ? 'WORKING…' : mode === 'signup' ? 'CREATE PROFILE' : 'SIGN IN'}
            </button>
            <button className="btn" onClick={() => setShowSignIn(false)}>CANCEL</button>
            <div style={{ flex: 1 }} />
            {mode === 'signin' && (
              <button className="btn" onClick={() => switchMode('reset')}>FORGOT PASSWORD?</button>
            )}
            {mode === 'signin' ? (
              <button className="btn" onClick={() => switchMode('signup')}>NEW PROFILE</button>
            ) : (
              <button className="btn" onClick={() => switchMode('signin')} disabled={profiles.length === 0}>SIGN IN INSTEAD</button>
            )}
          </div>

          <p style={{ fontSize: 'var(--fs-min)', color: 'var(--text-dim)', marginTop: 4 }}>
            Profiles are stored only on this device. Passwords are never transmitted; mission
            history is AES-256-GCM encrypted with a key that only your password or your
            recovery code can unlock (PBKDF2-SHA-256). The key stays in memory, so reloading
            signs you out. The recovery code you get at signup (and an
            authenticator app, if you pair one) can reset a forgotten password. Without
            the code, a forgotten password cannot be reset. Export backups from Settings.
          </p>
        </div>
        </>)}
      </div>
    </div>
    </>
  )
}
