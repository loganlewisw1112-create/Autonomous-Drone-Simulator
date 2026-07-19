import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/store/authStore'

// Header entry point for accounts (both shells). Signed out: opens sign-in.
// Signed in: quick access to analytics/settings/sign-out via a compact strip.
export function AccountChip() {
  const { activeAccount, setShowSignIn, setShowSettings, setShowAnalytics, signOut } = useAuthStore(
    useShallow((s) => ({
      activeAccount: s.activeAccount, setShowSignIn: s.setShowSignIn,
      setShowSettings: s.setShowSettings, setShowAnalytics: s.setShowAnalytics, signOut: s.signOut,
    })),
  )

  if (!activeAccount) {
    return (
      <button className="account-chip" onClick={() => setShowSignIn(true)} data-testid="account-chip">
        ◉ SIGN IN
      </button>
    )
  }

  return (
    <span className="account-chip-group" data-testid="account-chip">
      <span className="account-chip-name" title={`Signed in as ${activeAccount.displayName}`}>
        ◉ {activeAccount.displayName.toUpperCase()}
      </span>
      <button className="account-chip" onClick={() => setShowAnalytics(true)} title="Usage analytics">📊</button>
      <button className="account-chip" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
      <button className="account-chip" onClick={signOut} title="Sign out">⏻</button>
    </span>
  )
}
