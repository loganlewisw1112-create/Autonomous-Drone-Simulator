// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useAuthStore } from '@/store/authStore'
import { SignInModal } from '@/components/account/SignInModal'
import { AccountPanels } from '@/components/account/AccountPanels'

// Audit F-09: the sign-in modal and account panels had zero direct coverage — the store
// beneath them is tested (authStore.spec.ts), but a broken submit handler, error surface,
// or sign-out button would pass every store test and the aggregate gate. These tests drive
// the real components with user-event against the real store + fake IndexedDB, mirroring
// authStore.spec.ts (real PBKDF2, so the KDF-heavy tests carry widened timeouts; coverage
// runs swap in the fast KDF via VITEST_COVERAGE_FAST_KDF).

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  useAuthStore.setState({
    activeAccount: null, sessionKey: null, storageReadOnly: false, authError: null,
    prefs: {}, showSignIn: false, showSettings: false, showAnalytics: false,
  })
})

describe('SignInModal', () => {
  it('opens in sign-up mode on a device with no profiles and surfaces validation errors', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({ showSignIn: true })
    render(<SignInModal />)

    // No profiles on-device -> first-run flow must offer profile creation, not sign-in.
    await screen.findByText('CREATE OPERATOR PROFILE')

    await user.type(screen.getByLabelText(/USERNAME/), 'fieldop')
    await user.type(screen.getByLabelText(/PASSWORD/), 'short')
    await user.click(screen.getByRole('button', { name: 'CREATE PROFILE' }))

    // Store rejection must reach the UI, and the modal must stay open for a retry.
    expect(await screen.findByTestId('auth-error')).toHaveTextContent(/at least 8 characters/)
    expect(screen.getByTestId('signin-modal')).toBeInTheDocument()
    expect(useAuthStore.getState().activeAccount).toBeNull()
  })

  it('creates a profile from the form, signs the operator in, and closes the modal', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({ showSignIn: true })
    render(<SignInModal />)
    await screen.findByText('CREATE OPERATOR PROFILE')

    await user.type(screen.getByLabelText(/USERNAME/), 'fieldop')
    await user.type(screen.getByLabelText(/OPERATOR ALIAS/), 'Field Op')
    await user.type(screen.getByLabelText(/PASSWORD/), 'password123')
    await user.click(screen.getByRole('button', { name: 'CREATE PROFILE' }))

    await waitFor(() => expect(useAuthStore.getState().activeAccount?.username).toBe('fieldop'))
    const state = useAuthStore.getState()
    expect(state.activeAccount?.displayName).toBe('Field Op')
    expect(state.sessionKey).not.toBeNull()
    expect(state.showSignIn).toBe(false)
    expect(screen.queryByTestId('signin-modal')).toBeNull()
  }, 20000)

  it('lists existing profiles, rejects a wrong password with a visible error, then signs in', async () => {
    // Seed a profile through the store, then exercise the component round-trip.
    await useAuthStore.getState().signUp('op1', 'Operator One', 'password123')
    useAuthStore.getState().signOut()

    const user = userEvent.setup()
    useAuthStore.setState({ showSignIn: true })
    render(<SignInModal />)
    await screen.findByText('OPERATOR SIGN IN')

    // Profile chip pre-fills the username field.
    await user.click(await screen.findByRole('button', { name: /Operator One/ }))
    expect(screen.getByLabelText(/USERNAME/)).toHaveValue('op1')

    await user.type(screen.getByLabelText(/PASSWORD/), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'SIGN IN' }))
    expect(await screen.findByTestId('auth-error')).toHaveTextContent('Incorrect password')
    expect(useAuthStore.getState().activeAccount).toBeNull()
    // The password field is cleared after every attempt — passwords never linger in the DOM.
    expect(screen.getByLabelText(/PASSWORD/)).toHaveValue('')

    await user.type(screen.getByLabelText(/PASSWORD/), 'password123')
    await user.click(screen.getByRole('button', { name: 'SIGN IN' }))
    await waitFor(() => expect(useAuthStore.getState().activeAccount?.username).toBe('op1'))
    expect(screen.queryByTestId('signin-modal')).toBeNull()
  }, 30000)
})

describe('AccountPanels', () => {
  it('renders signed-out prompts instead of profile data', async () => {
    useAuthStore.setState({ showSettings: true })
    const { unmount } = render(<AccountPanels />)
    expect(screen.getByTestId('settings-panel')).toHaveTextContent('Sign in to manage your profile.')
    unmount()

    useAuthStore.setState({ showSettings: false, showAnalytics: true })
    render(<AccountPanels />)
    expect(screen.getByTestId('analytics-panel')).toHaveTextContent('Sign in to see your mission analytics.')
  })

  it('shows the empty analytics state for a fresh profile', async () => {
    await useAuthStore.getState().signUp('op2', 'Operator Two', 'password123')
    useAuthStore.setState({ showAnalytics: true })
    render(<AccountPanels />)

    // listRuns resolves async against fake IndexedDB before the empty state appears.
    expect(await screen.findByText(/No saved missions yet/)).toBeInTheDocument()
    expect(screen.getByTestId('analytics-panel')).toHaveTextContent('OPERATOR TWO')
  }, 20000)

  it('sign-out from Settings clears the session and closes the panel', async () => {
    const user = userEvent.setup()
    await useAuthStore.getState().signUp('op3', 'Operator Three', 'password123')
    useAuthStore.setState({ showSettings: true })
    render(<AccountPanels />)

    expect(screen.getByTestId('settings-panel')).toHaveTextContent('OPERATOR THREE')
    await user.click(screen.getByRole('button', { name: /SIGN OUT/ }))

    const state = useAuthStore.getState()
    // The derived AES key must not survive sign-out — it is the decryption capability.
    expect(state.sessionKey).toBeNull()
    expect(state.activeAccount).toBeNull()
    expect(state.showSettings).toBe(false)
    expect(screen.queryByTestId('settings-panel')).toBeNull()
  }, 20000)
})
