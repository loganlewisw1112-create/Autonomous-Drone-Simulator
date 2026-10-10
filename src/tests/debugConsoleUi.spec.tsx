// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DebugConsoleRoot } from '@/components/debug/DebugConsoleRoot'
import { useConsoleStore } from '@/debug/consoleStore'
import { getBindings, handleBindingKeydown, loadBindings, setBinding } from '@/debug/bindings'
import { useAuthStore } from '@/store/authStore'
import { useDroneStore } from '@/store/droneStore'

const ADMIN = { id: 'a1', username: 'owner', displayName: 'Owner', isAdmin: true, adminEmail: 'owner@example.com' }

function pressToggle() {
  fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true })
}

beforeEach(() => {
  localStorage.clear()
  useConsoleStore.setState({ open: false, lines: [], poppedOut: false })
  useAuthStore.setState({ activeAccount: null })
})
afterEach(() => cleanup())

describe('debug console UI', () => {
  it('renders nothing and ignores the hotkey for a non-admin', () => {
    useAuthStore.setState({ activeAccount: { id: 'u1', username: 'student', displayName: 'Student' } })
    const { container } = render(<DebugConsoleRoot />)
    pressToggle()
    expect(container).toBeEmptyDOMElement()
    expect(useConsoleStore.getState().open).toBe(false)
    expect(screen.queryByTestId('debug-console')).toBeNull()
  })

  it('Ctrl+` opens the drawer for an admin, and commands run from the input', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({ activeAccount: ADMIN })
    render(<DebugConsoleRoot />)
    expect(screen.getByTestId('debug-drawer')).toHaveAttribute('data-open', 'false')

    act(() => pressToggle())
    expect(screen.getByTestId('debug-drawer')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('debug-console')).toHaveTextContent('owner@example.com')

    const input = screen.getByLabelText('Debug console command')
    await user.type(input, 'help{Enter}')
    await waitFor(() => expect(screen.getByTestId('debug-console')).toHaveTextContent(/status/))

    // History: Up recalls the last command.
    await user.type(input, '{ArrowUp}')
    expect(input).toHaveValue('help')
    await user.clear(input)

    // Tab completes a unique command prefix.
    await user.type(input, 'repl{Tab}')
    expect((input as HTMLInputElement).value.startsWith('replay')).toBe(true)

    act(() => pressToggle())
    expect(screen.getByTestId('debug-drawer')).toHaveAttribute('data-open', 'false')
  })

  it('a mutating command shows the DEBUG-TAINTED badge', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({ activeAccount: ADMIN })
    useDroneStore.getState().resetMission()
    render(<DebugConsoleRoot />)
    act(() => pressToggle())
    expect(screen.queryByTestId('debug-taint-badge')).toBeNull()
    await user.type(screen.getByLabelText('Debug console command'), 'wind 12{Enter}')
    await waitFor(() => expect(screen.getByTestId('debug-taint-badge')).toBeInTheDocument(), { timeout: 2500 })
    useDroneStore.getState().resetMission()
  })

  it('hotkey bindings persist per admin and fire only for admins', () => {
    loadBindings('owner@example.com')
    expect(setBinding('F5', 'chain verify')).not.toBeNull()
    loadBindings(null)
    loadBindings('owner@example.com')
    expect(Object.values(getBindings())).toContain('chain verify')

    const event = new KeyboardEvent('keydown', { key: 'F5' })
    expect(handleBindingKeydown(event, false)).toBe(false)
    expect(handleBindingKeydown(event, true)).toBe(true)
  })
})
