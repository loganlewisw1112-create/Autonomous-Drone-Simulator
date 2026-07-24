// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const windowsClient = vi.hoisted(() => ({ enabled: true }))

vi.mock('@/platform/appTarget', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/platform/appTarget')>()
  return {
    ...mod,
    isWindowsClient: () => windowsClient.enabled,
  }
})

vi.mock('@/components/classroom/ClassroomHome', () => ({
  ClassroomHome: () => <div data-testid="classroom-home">home</div>,
}))

vi.mock('@/classroom/desktopBridge', () => ({
  desktopPromptAlreadyHandled: () => true,
  getClassroomDesktopBridge: () => null,
}))

import { ClassroomEntry } from '@/components/classroom/ClassroomEntry'

afterEach(() => {
  cleanup()
  windowsClient.enabled = true
})

describe('ClassroomEntry Windows gate', () => {
  it('renders classroom content on Windows clients', () => {
    windowsClient.enabled = true
    render(<ClassroomEntry mode="home" />)
    expect(screen.getByTestId('classroom-home')).toBeInTheDocument()
    expect(screen.queryByTestId('classroom-windows-gate')).toBeNull()
  })

  it('blocks non-Windows clients before any classroom UI', () => {
    windowsClient.enabled = false
    render(<ClassroomEntry mode="home" />)
    expect(screen.getByTestId('classroom-windows-gate')).toBeInTheDocument()
    expect(screen.queryByTestId('classroom-home')).toBeNull()
  })
})
