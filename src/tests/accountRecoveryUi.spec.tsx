// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { resetRecoveryThrottle, useAuthStore } from '@/store/authStore'
import { SignInModal } from '@/components/account/SignInModal'

// Same KDF cap as accountRecovery.spec: these drive the real UI and store, not the
// iteration policy.
vi.mock('@/account/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/account/crypto')>()
  return {
    ...actual,
    deriveKey: (password: string, params: Parameters<typeof actual.deriveKey>[1]) =>
      actual.deriveKey(password, { ...params, iterations: Math.min(params.iterations, 1_000) }),
  }
})

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  resetRecoveryThrottle()
  useAuthStore.setState({
    activeAccount: null, sessionKey: null, storageReadOnly: false, authError: null,
    prefs: {}, showSignIn: false, showSettings: false, showAnalytics: false,
    pendingRecoveryCode: null, pendingRecoveryNewAccount: false,
  })
})

describe('recovery UI', () => {
  it('signup shows the mandatory recovery code, then offers an optional authenticator', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({ showSignIn: true })
    render(<SignInModal />)
    await screen.findByText('CREATE OPERATOR PROFILE')
    await user.type(screen.getByLabelText(/USERNAME/), 'cadet')
    await user.type(screen.getByLabelText(/PASSWORD/), 'cadet-pass-1')
    await user.click(screen.getByRole('button', { name: 'CREATE PROFILE' }))

    await screen.findByTestId('recovery-overlay')
    const code = useAuthStore.getState().pendingRecoveryCode
    expect(screen.getByTestId('recovery-code-value')).toHaveTextContent(code!)
    // Only one overlay even though SignInModal mounts the host in both of its branches.
    expect(screen.getAllByTestId('recovery-overlay')).toHaveLength(1)

    const cont = screen.getByRole('button', { name: 'CONTINUE' })
    expect(cont).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /I saved it/ }))
    await user.click(cont)
    expect(screen.queryByTestId('recovery-overlay')).not.toBeInTheDocument()
    expect(useAuthStore.getState().pendingRecoveryCode).toBeNull()

    await screen.findByTestId('authenticator-pairing')
    await user.click(screen.getByRole('button', { name: 'SKIP' }))
    await waitFor(() => expect(screen.queryByTestId('authenticator-overlay')).not.toBeInTheDocument())
  }, 30000)

  it('forgot password resets with the recovery code and shows the rotated code', async () => {
    const user = userEvent.setup()
    await useAuthStore.getState().signUp('lost', '', 'forgot-me-1')
    const code = useAuthStore.getState().pendingRecoveryCode!
    useAuthStore.getState().acknowledgeRecoveryCode()
    useAuthStore.getState().signOut()

    useAuthStore.setState({ showSignIn: true })
    render(<SignInModal />)
    await user.click(await screen.findByRole('button', { name: 'FORGOT PASSWORD?' }))
    await screen.findByTestId('password-reset')
    await user.type(screen.getByLabelText(/USERNAME/), 'lost')
    await user.type(screen.getByLabelText(/RECOVERY CODE/), code.toLowerCase())
    await user.click(screen.getByRole('button', { name: 'CONTINUE' }))

    await user.type(await screen.findByLabelText(/^NEW PASSWORD/), 'remembered-1')
    await user.type(screen.getByLabelText(/CONFIRM NEW PASSWORD/), 'remembered-1')
    await user.click(screen.getByRole('button', { name: 'RESET PASSWORD' }))

    await screen.findByTestId('recovery-overlay')
    const rotated = useAuthStore.getState().pendingRecoveryCode
    expect(rotated).not.toBe(code)
    expect(screen.getByTestId('recovery-code-value')).toHaveTextContent(rotated!)
    expect(useAuthStore.getState().activeAccount?.username).toBe('lost')
  }, 30000)

  it('the sign-in screen no longer claims a forgotten password is unrecoverable', async () => {
    useAuthStore.setState({ showSignIn: true })
    render(<SignInModal />)
    await screen.findByText('CREATE OPERATOR PROFILE')
    expect(document.body.textContent).not.toMatch(/cannot be recovered/i)
    expect(document.body.textContent).toMatch(/recovery code/i)
  })
})
