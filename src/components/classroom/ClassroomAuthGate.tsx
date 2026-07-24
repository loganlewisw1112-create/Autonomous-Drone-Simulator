import { useEffect, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore, listAccounts } from '@/store/authStore'
import type { AccountRecord, AccountRole } from '@/account/types'

/**
 * Wraps ClassSetup / JoinGate: require a signed-in classroom account of the
 * right role before the existing live UI mounts. Does not touch WebSockets.
 */
export function ClassroomAuthGate({
  requiredRole,
  children,
}: {
  requiredRole: AccountRole
  children: ReactNode
}) {
  const { activeAccount, signOut } = useAuthStore(useShallow((s) => ({
    activeAccount: s.activeAccount,
    signOut: s.signOut,
  })))

  if (activeAccount?.role === requiredRole) return <>{children}</>

  if (activeAccount && activeAccount.role !== requiredRole) {
    return (
      <div className="cls-center">
        <div className="cls-card" data-testid="classroom-wrong-role">
          <div style={{ fontSize: 18, fontWeight: 700 }}>Wrong account type</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.45 }}>
            Signed in as <strong>{activeAccount.displayName}</strong>
            {activeAccount.role ? ` (${activeAccount.role})` : ' (solo operator)'}.
            This path needs a <strong>{requiredRole}</strong> account.
          </div>
          <button type="button" className="cls-btn" onClick={() => signOut()}>
            Sign out and switch
          </button>
          <a className="cls-btn ghost" href="?" style={{ textAlign: 'center', textDecoration: 'none' }}>
            Back to classroom home
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="cls-center">
      <ClassroomAuthForm requiredRole={requiredRole} allowRoleSwitch={false} />
    </div>
  )
}

/**
 * Shared sign-in / sign-up form. On classroom home, `allowRoleSwitch` lets the user
 * pick Student or Instructor. Instructor access code is entered later on the
 * Start a training class page (one-time per new instructor account).
 */
export function ClassroomAuthForm({
  requiredRole: fixedRole,
  allowRoleSwitch = false,
  onSignedIn,
}: {
  requiredRole?: AccountRole
  allowRoleSwitch?: boolean
  onSignedIn?: () => void
}) {
  const {
    signIn, signUp, authError, clearAuthError, storageAvailable,
  } = useAuthStore(useShallow((s) => ({
    signIn: s.signIn,
    signUp: s.signUp,
    authError: s.authError,
    clearAuthError: s.clearAuthError,
    storageAvailable: s.storageAvailable,
  })))

  const [role, setRole] = useState<AccountRole>(fixedRole ?? 'student')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [profiles, setProfiles] = useState<AccountRecord[]>([])
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [busy, setBusy] = useState(false)

  const activeRole = fixedRole ?? role

  useEffect(() => {
    void listAccounts().then((accounts) => {
      const matching = allowRoleSwitch
        ? accounts.filter((a) => a.role === 'instructor' || a.role === 'student')
        : accounts.filter((a) => a.role === activeRole)
      setProfiles(matching)
      setMode(matching.length === 0 ? 'signup' : 'signin')
    })
  }, [activeRole, allowRoleSwitch])

  async function handleSubmit() {
    setBusy(true)
    try {
      if (mode === 'signup') {
        const ok = await signUp(username, displayName, password, rememberMe, {
          role: activeRole,
        })
        if (ok) onSignedIn?.()
      } else {
        const ok = await signIn(username, password, rememberMe)
        if (!ok) return
        const signedRole = useAuthStore.getState().activeAccount?.role
        if (!allowRoleSwitch && signedRole !== activeRole) {
          useAuthStore.getState().signOut()
          useAuthStore.setState({
            authError: signedRole
              ? `That profile is a ${signedRole} account — use a ${activeRole} login here`
              : `That profile is not a ${activeRole} classroom account`,
          })
          return
        }
        if (allowRoleSwitch && signedRole !== 'instructor' && signedRole !== 'student') {
          useAuthStore.getState().signOut()
          useAuthStore.setState({
            authError: 'That profile is not a classroom instructor or student account',
          })
          return
        }
        onSignedIn?.()
      }
    } finally {
      setBusy(false)
      setPassword('')
    }
  }

  const title = mode === 'signup'
    ? (activeRole === 'instructor' ? 'Create instructor account' : 'Create student account')
    : 'Sign in'

  return (
    <div className="cls-card" data-testid="classroom-auth">
      <div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
          {mode === 'signup' && activeRole === 'instructor'
            ? 'Create username and password first. On Start a training class you will type the school access code once (first code on a fresh machine becomes the unlock automatically).'
            : mode === 'signup'
              ? 'Anyone can create a student account on this device. Progress stays encrypted locally.'
              : 'Sign in with your classroom username and password.'}
        </div>
      </div>

      {allowRoleSwitch && (
        <div style={{ display: 'flex', gap: 8 }} data-testid="classroom-role-picker">
          <button
            type="button"
            className={`cls-btn${activeRole === 'student' ? '' : ' ghost'}`}
            onClick={() => { setRole('student'); clearAuthError() }}
          >
            Student
          </button>
          <button
            type="button"
            className={`cls-btn${activeRole === 'instructor' ? '' : ' ghost'}`}
            onClick={() => { setRole('instructor'); clearAuthError() }}
          >
            Instructor
          </button>
        </div>
      )}

      {!storageAvailable && (
        <div style={{ color: '#ffc766', fontSize: 12 }}>
          Device storage unavailable — classroom accounts need IndexedDB.
        </div>
      )}

      {mode === 'signin' && profiles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              className="cls-btn ghost"
              style={{ padding: '6px 10px', fontSize: 12 }}
              onClick={() => {
                setUsername(p.username)
                if (allowRoleSwitch && (p.role === 'instructor' || p.role === 'student')) setRole(p.role)
              }}
            >
              {p.displayName}{p.role ? ` · ${p.role}` : ''}
            </button>
          ))}
        </div>
      )}

      <input
        className="cls-input"
        placeholder="Username"
        autoCapitalize="none"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />

      {mode === 'signup' && (
        <input
          className="cls-input"
          placeholder="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      )}

      <input
        className="cls-input"
        type="password"
        placeholder={mode === 'signup' ? 'Password (min 8 characters)' : 'Password'}
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !busy && void handleSubmit()}
      />

      <label className="cls-consent">
        <input
          type="checkbox"
          checked={rememberMe}
          onChange={(e) => setRememberMe(e.target.checked)}
        />
        <span>Stay signed in on this device</span>
      </label>

      {authError && (
        <div style={{ color: '#ff8080', fontSize: 12 }} data-testid="auth-error">
          {authError}
        </div>
      )}

      <button
        type="button"
        className="cls-btn"
        disabled={busy || !storageAvailable}
        onClick={() => void handleSubmit()}
      >
        {busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Sign in'}
      </button>

      <button
        type="button"
        className="cls-btn ghost"
        onClick={() => {
          setMode(mode === 'signin' ? 'signup' : 'signin')
          clearAuthError()
        }}
      >
        {mode === 'signin' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
      </button>

      {!allowRoleSwitch && (
        <a className="cls-btn ghost" href="?" style={{ textAlign: 'center', textDecoration: 'none' }}>
          Back to classroom home
        </a>
      )}
    </div>
  )
}
