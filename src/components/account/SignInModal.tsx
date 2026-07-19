import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore, listAccounts } from '@/store/authStore'
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

  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [profiles, setProfiles] = useState<AccountRecord[]>([])
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!showSignIn) return
    void listAccounts().then((accounts) => {
      setProfiles(accounts)
      setMode(accounts.length === 0 ? 'signup' : 'signin')
    })
  }, [showSignIn])

  if (!showSignIn) return null

  async function handleSubmit() {
    setBusy(true)
    try {
      if (mode === 'signup') await signUp(username, displayName, password, rememberMe)
      else await signIn(username, password, rememberMe)
    } finally {
      setBusy(false)
      setPassword('')
    }
  }

  const switchMode = (next: 'signin' | 'signup') => {
    setMode(next)
    clearAuthError()
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowSignIn(false)}>
      <div className="modal" data-testid="signin-modal">
        <div className="modal-title">{mode === 'signup' ? 'CREATE OPERATOR PROFILE' : 'OPERATOR SIGN IN'}</div>

        {!storageAvailable && (
          <p style={{ color: 'var(--accent-yellow)', fontSize: 12, marginBottom: 12 }}>
            ⚠ Device storage unavailable (private browsing?). Profiles can't be saved here —
            the simulator remains fully usable without an account.
          </p>
        )}

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
          <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            USERNAME
            <input
              className="account-input"
              style={{ marginTop: 4 }}
              value={username}
              autoCapitalize="none"
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>

          {mode === 'signup' && (
            <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              DISPLAY NAME (shown in mission logs)
              <input
                className="account-input"
                style={{ marginTop: 4 }}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
          )}

          <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            PASSWORD {mode === 'signup' && '(min 8 chars — cannot be recovered if lost)'}
            <input
              className="account-input"
              style={{ marginTop: 4 }}
              type="password"
              value={password}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void handleSubmit()}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
            Stay signed in on this device
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
            {mode === 'signin' ? (
              <button className="btn" onClick={() => switchMode('signup')}>NEW PROFILE</button>
            ) : (
              <button className="btn" onClick={() => switchMode('signin')} disabled={profiles.length === 0}>SIGN IN INSTEAD</button>
            )}
          </div>

          <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
            Profiles are stored only on this device. Passwords are never transmitted; mission
            history is AES-256-GCM encrypted with a key derived from your password
            (PBKDF2-SHA-256). A forgotten password cannot be recovered — export backups from Settings.
          </p>
        </div>
      </div>
    </div>
  )
}
