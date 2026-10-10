import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { DebugConsole } from '@/components/debug/DebugConsole'
import { DebugHud } from '@/components/debug/DebugHud'
import { handleBindingKeydown, loadBindings } from '@/debug/bindings'
import { registerAllDebugCommands } from '@/debug/commands'
import { useConsoleStore } from '@/debug/consoleStore'
import { installErrorCapture, uninstallErrorCapture } from '@/debug/errorLog'
import { useAuthStore } from '@/store/authStore'
import './debugConsole.css'

const POPUP_NAME = 'drone-sim-debug'

/** Ctrl+` (or Ctrl+Shift+D where there is no backtick key) toggles the console. */
function isToggleKey(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || event.altKey || event.metaKey) return false
  if (event.key === '`' || event.code === 'Backquote') return true
  return event.shiftKey && (event.key === 'D' || event.key === 'd')
}

/** Copy every stylesheet of this document into the popup so it looks identical. */
function copyStyles(target: Document): void {
  for (const node of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) {
    const copy = node.cloneNode(true) as HTMLElement
    // Absolute hrefs: the popup starts at about:blank and must not resolve relative to itself.
    if (copy instanceof HTMLLinkElement) copy.href = (node as HTMLLinkElement).href
    target.head.appendChild(copy)
  }
}

interface DebugConsoleRootProps {
  /** Phones get a floating DBG button and 44px touch targets. */
  variant?: 'desktop' | 'mobile'
}

/**
 * Admin-only debug console. Always loaded through React.lazy behind an
 * `activeAccount?.isAdmin` check in the shells, and it re-checks here, so a
 * non-admin never mounts it (and never downloads this chunk).
 */
export function DebugConsoleRoot({ variant = 'desktop' }: DebugConsoleRootProps) {
  const { isAdmin, adminEmail } = useAuthStore(
    useShallow((s) => ({ isAdmin: s.activeAccount?.isAdmin === true, adminEmail: s.activeAccount?.adminEmail ?? '' })),
  )
  const { open, poppedOut } = useConsoleStore(useShallow((s) => ({ open: s.open, poppedOut: s.poppedOut })))
  const [popup, setPopup] = useState<{ win: Window; host: HTMLElement } | null>(null)
  const popupRef = useRef<Window | null>(null)
  const touch = variant === 'mobile'

  // Admin session lifecycle: register commands, per-admin history and bindings, error capture.
  useEffect(() => {
    if (!isAdmin) return undefined
    registerAllDebugCommands()
    installErrorCapture()
    loadBindings(adminEmail)
    useConsoleStore.getState().loadHistory(adminEmail)
    return () => {
      uninstallErrorCapture()
      loadBindings(null)
      useConsoleStore.getState().loadHistory(null)
      useConsoleStore.getState().setOpen(false)
    }
  }, [isAdmin, adminEmail])

  // Global hotkeys: console toggle plus user bindings, in the main window.
  useEffect(() => {
    if (!isAdmin) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (isToggleKey(event)) {
        event.preventDefault()
        useConsoleStore.getState().toggle()
        return
      }
      handleBindingKeydown(event, true)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [isAdmin])

  const redock = useCallback(() => {
    const win = popupRef.current
    popupRef.current = null
    setPopup(null)
    useConsoleStore.getState().setPoppedOut(false)
    try {
      if (win && !win.closed) win.close()
    } catch {
      // A cross-origin or already-torn-down popup can throw; there is nothing left to close.
    }
  }, [])

  const popOut = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) { popupRef.current.focus(); return }
    // Same-origin about:blank popup: it shares this window's JS realm for React, and the
    // app's COOP same-origin header does not sever it. We keep the Window reference below.
    const win = window.open('', POPUP_NAME, 'width=900,height=500')
    if (!win) {
      useConsoleStore.getState().print('Pop-out was blocked by the browser. Allow popups for this site; staying docked.', 'warn')
      return
    }
    win.document.title = 'Drone Sim Debug Console'
    win.document.body.textContent = ''
    win.document.body.style.margin = '0'
    win.document.body.style.background = '#070a0f'
    copyStyles(win.document)
    const host = win.document.createElement('div')
    win.document.body.appendChild(host)
    popupRef.current = win
    setPopup({ win, host })
    useConsoleStore.getState().setPoppedOut(true)
    useConsoleStore.getState().setOpen(true)
  }, [])

  // While popped out: re-dock when the popup goes away, and keep hotkeys working inside it.
  useEffect(() => {
    if (!popup) return undefined
    const { win } = popup
    const onKeyDown = (event: KeyboardEvent) => {
      if (isToggleKey(event)) {
        event.preventDefault()
        redock()
        return
      }
      handleBindingKeydown(event, true)
    }
    win.addEventListener('pagehide', redock)
    win.addEventListener('beforeunload', redock)
    win.addEventListener('keydown', onKeyDown, true)
    // Some browsers skip pagehide on a user-closed popup; poll as a fallback.
    const poll = window.setInterval(() => { if (win.closed) redock() }, 1000)
    return () => {
      window.clearInterval(poll)
      win.removeEventListener('pagehide', redock)
      win.removeEventListener('beforeunload', redock)
      win.removeEventListener('keydown', onKeyDown, true)
    }
  }, [popup, redock])

  // Sign-out or unmount closes any popup too.
  useEffect(() => () => {
    try {
      popupRef.current?.close()
    } catch {
      // Already gone.
    }
    popupRef.current = null
    useConsoleStore.getState().setPoppedOut(false)
  }, [])

  if (!isAdmin) return null

  const onClose = () => useConsoleStore.getState().setOpen(false)
  const shared = { adminEmail, touch, onPopOut: popOut, onRedock: redock, onClose }

  return (
    <>
      <DebugHud />
      {touch && !open && !poppedOut && (
        <button type="button" className="dbg-fab" aria-label="Open debug console" onClick={() => useConsoleStore.getState().setOpen(true)}>
          DBG
        </button>
      )}
      {popup ? createPortal(<DebugConsole mode="popout" {...shared} />, popup.host) : <DebugConsole mode="docked" {...shared} />}
    </>
  )
}
