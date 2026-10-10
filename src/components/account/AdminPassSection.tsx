// Settings section for entering / removing a signed ADMIN pass. The pass is
// verified (Ed25519) by authStore.applyAdminPass; the profile stores it and
// re-verifies on every sign-in, so pasting a forged pass unlocks nothing.
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/store/authStore'

export function AdminPassSection() {
  const { isAdmin, adminEmail, authError, hasProfile } = useAuthStore(useShallow((s) => ({
    isAdmin: s.activeAccount?.isAdmin === true,
    adminEmail: s.activeAccount?.adminEmail,
    authError: s.authError,
    hasProfile: s.activeAccount !== null,
  })))
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!hasProfile) return null

  async function unlock() {
    if (busy || !pass.trim()) return
    setBusy(true)
    setError(null)
    try {
      const ok = await useAuthStore.getState().applyAdminPass(pass)
      if (ok) {
        setPass('')
      } else {
        setError(useAuthStore.getState().authError ?? 'That admin pass is not valid')
      }
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const ok = await useAuthStore.getState().removeAdminPass()
      if (!ok) setError('Could not remove the admin pass from device storage')
    } finally {
      setBusy(false)
    }
  }

  const shownError = error ?? (authError && !isAdmin && pass ? authError : null)

  return (
    <div className="account-settings-section" data-testid="admin-pass-section">
      <span className="account-label">ADMIN</span>
      {isAdmin ? (
        <>
          <div
            data-testid="admin-active"
            style={{ fontSize: 'var(--fs-min)', fontFamily: 'var(--font-mono)', color: 'var(--accent-yellow)' }}
          >
            ADMIN — {adminEmail}
          </div>
          <p className="account-fineprint">
            Admin unlocks: authorization-training and preflight gates, the demo and licence window,
            and instructor class setup without the access code. Every bypass is labelled
            "ADMIN override" and recorded in the mission log. Weather and safety rules in the
            simulation still apply. Hint: Ctrl+` opens the debug console.
          </p>
          <div className="account-settings-row">
            <button className="btn danger" onClick={() => void remove()} disabled={busy} data-testid="admin-remove">
              REMOVE ADMIN PASS
            </button>
          </div>
        </>
      ) : (
        <>
          <label>Admin pass
            <textarea
              className="account-input"
              rows={3}
              value={pass}
              spellCheck={false}
              autoComplete="off"
              placeholder="DSA1.…"
              onChange={(e) => setPass(e.target.value)}
              data-testid="admin-pass-input"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-min)', width: '100%' }}
            />
          </label>
          <div className="account-settings-row">
            <button className="btn" onClick={() => void unlock()} disabled={busy || !pass.trim()} data-testid="admin-unlock">
              UNLOCK ADMIN
            </button>
          </div>
          {shownError && (
            <p role="alert" data-testid="admin-error" style={{ color: 'var(--accent-red)', fontSize: 'var(--fs-min)' }}>
              {shownError}
            </p>
          )}
        </>
      )}
    </div>
  )
}
