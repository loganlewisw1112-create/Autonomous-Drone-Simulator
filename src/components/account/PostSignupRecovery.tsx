import { useEffect, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/store/authStore'
import { RecoveryCodeStep } from '@/components/account/RecoveryCodeStep'
import { AuthenticatorPairing } from '@/components/account/AuthenticatorPairing'

// Several shells mount this host (SignInModal, the classroom gate, ClassroomEntry) and some
// nest: the classroom student path renders App inside the gate. Only the first mounted host
// renders, so the code is never shown in two stacked overlays.
const hosts: symbol[] = []
const hostListeners = new Set<() => void>()

function subscribeHosts(listener: () => void): () => void {
  hostListeners.add(listener)
  return () => { hostListeners.delete(listener) }
}

function useIsPrimaryHost(): boolean {
  const [id] = useState(() => Symbol('recovery-host'))
  useEffect(() => {
    hosts.push(id)
    hostListeners.forEach((listener) => listener())
    return () => {
      hosts.splice(hosts.indexOf(id), 1)
      hostListeners.forEach((listener) => listener())
    }
  }, [id])
  return useSyncExternalStore(subscribeHosts, () => hosts[0] === id, () => false)
}

// Overlay host for the recovery steps. It renders whenever the store holds an
// unacknowledged recovery code (signup, password reset, or regenerate in Settings),
// independent of which form produced it, so it survives the sign-in form unmounting.
// After a NEW account's code is acknowledged it offers the optional authenticator
// step. Shells may mount it freely; only the primary host renders (see above).
export function PostSignupRecovery() {
  const { code, newAccount, activeAccount, acknowledge } = useAuthStore(
    useShallow((s) => ({
      code: s.pendingRecoveryCode,
      newAccount: s.pendingRecoveryNewAccount,
      activeAccount: s.activeAccount,
      acknowledge: s.acknowledgeRecoveryCode,
    })),
  )
  const [offerAuthenticator, setOfferAuthenticator] = useState(false)
  const primary = useIsPrimaryHost()
  if (!primary) return null

  const overlay = (child: React.ReactNode, testId: string) => (
    <div className="modal-overlay" style={{ zIndex: 1200 }} data-testid={testId}>
      <div className="modal">{child}</div>
    </div>
  )

  if (code && activeAccount) {
    return overlay(
      <RecoveryCodeStep
        code={code}
        username={activeAccount.username}
        continueLabel={newAccount ? 'CONTINUE' : 'DONE'}
        onDone={() => {
          setOfferAuthenticator(newAccount)
          acknowledge()
        }}
      />,
      'recovery-overlay',
    )
  }
  if (offerAuthenticator && activeAccount) {
    return overlay(
      <AuthenticatorPairing onDone={() => setOfferAuthenticator(false)} />,
      'authenticator-overlay',
    )
  }
  return null
}
