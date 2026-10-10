import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { completeDebugInput } from '@/debug/completion'
import { consoleIo, MIN_CONSOLE_HEIGHT, useConsoleStore } from '@/debug/consoleStore'
import { runDebugLine } from '@/debug/registry'
import { getRunDebugTaint } from '@/debug/taint'
import type { DebugLine } from '@/debug/types'

export type DebugConsoleMode = 'docked' | 'popout'

interface DebugConsoleProps {
  mode: DebugConsoleMode
  adminEmail: string
  touch?: boolean
  onPopOut: () => void
  onRedock: () => void
  onClose: () => void
}

const Line = memo(function Line({ line }: { line: DebugLine }) {
  return <pre className={`dbg-line dbg-line--${line.kind}`}>{line.kind === 'cmd' && !line.text.startsWith('[bind') ? `> ${line.text}` : line.text}</pre>
})

/** Return keyboard focus to the simulator surface (the map canvas when present). */
function focusSim(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
  const canvas = document.querySelector<HTMLElement>('.maplibregl-canvas')
  canvas?.focus?.()
  window.focus()
}

export function DebugConsole({ mode, adminEmail, touch = false, onPopOut, onRedock, onClose }: DebugConsoleProps) {
  const { open, height, lines } = useConsoleStore(useShallow((s) => ({ open: s.open, height: s.height, lines: s.lines })))
  const setHeight = useConsoleStore((s) => s.setHeight)
  const [value, setValue] = useState('')
  const [tainted, setTainted] = useState(() => getRunDebugTaint() !== null)
  const historyIndex = useRef<number | null>(null)
  const draft = useRef('')
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const visible = mode === 'popout' || open

  // Poll the run taint lightly: it is module state, not a subscribable store.
  useEffect(() => {
    if (!visible) return undefined
    const sync = () => setTainted(getRunDebugTaint() !== null)
    sync()
    const id = window.setInterval(sync, 1000)
    return () => window.clearInterval(id)
  }, [visible])

  useEffect(() => {
    if (visible) inputRef.current?.focus()
  }, [visible])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [lines])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }, [])

  const submit = useCallback(() => {
    const line = value.trim()
    setValue('')
    historyIndex.current = null
    if (!line) return
    useConsoleStore.getState().pushHistory(line)
    consoleIo.print(line, 'cmd')
    stickToBottom.current = true
    void runDebugLine(line, consoleIo)
  }, [value])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const { history } = useConsoleStore.getState()
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (history.length === 0) return
      if (historyIndex.current === null) {
        draft.current = value
        historyIndex.current = history.length - 1
      } else {
        historyIndex.current = Math.max(0, historyIndex.current - 1)
      }
      setValue(history[historyIndex.current])
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (historyIndex.current === null) return
      if (historyIndex.current >= history.length - 1) {
        historyIndex.current = null
        setValue(draft.current)
      } else {
        historyIndex.current += 1
        setValue(history[historyIndex.current])
      }
    } else if (event.key === 'Tab') {
      event.preventDefault()
      const result = completeDebugInput(value)
      if (result.candidates.length === 0) return
      if (result.candidates.length > 1 && result.value === value) consoleIo.print(result.candidates.join('  '), 'info')
      setValue(result.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      focusSim()
    }
  }

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const target = event.currentTarget
    target.setPointerCapture?.(event.pointerId)
    const move = (e: globalThis.PointerEvent) => setHeight(Math.min(window.innerHeight * 0.9, window.innerHeight - e.clientY))
    const end = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }

  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp') { event.preventDefault(); setHeight(height + 24) }
    if (event.key === 'ArrowDown') { event.preventDefault(); setHeight(height - 24) }
  }

  const body = (
    <div className={`dbg-console${mode === 'popout' ? ' dbg-console--popout' : ''}${touch ? ' dbg--touch' : ''}`} data-testid="debug-console">
      <div className="dbg-header">
        <span className="dbg-title">ADMIN — {adminEmail}</span>
        {tainted && <span className="dbg-taint" data-testid="debug-taint-badge">DEBUG-TAINTED</span>}
        <span className="dbg-spacer" />
        <button type="button" className="dbg-btn" onClick={mode === 'popout' ? onRedock : onPopOut}>
          {mode === 'popout' ? 'Dock' : 'Pop out'}
        </button>
        <button type="button" className="dbg-btn" onClick={() => useConsoleStore.getState().clear()}>Clear</button>
        {mode === 'docked' && <button type="button" className="dbg-btn" onClick={onClose} aria-label="Close debug console">Close</button>}
      </div>
      <div className="dbg-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="off">
        {lines.length === 0 && <pre className="dbg-line dbg-line--info">Type "help" for commands. Ctrl+` toggles this console.</pre>}
        {lines.map((line) => <Line key={line.id} line={line} />)}
      </div>
      <div className="dbg-inputrow">
        <span className="dbg-prompt" aria-hidden="true">&gt;</span>
        <input
          ref={inputRef}
          className="dbg-input"
          data-debug-console-input="true"
          aria-label="Debug console command"
          value={value}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => { setValue(e.target.value); historyIndex.current = null }}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )

  if (mode === 'popout') return body

  return (
    <div
      className={`dbg-drawer${touch ? ' dbg--touch' : ''}`}
      data-testid="debug-drawer"
      data-open={open}
      aria-hidden={!open}
      style={{ height: Math.max(MIN_CONSOLE_HEIGHT, height) }}
    >
      <div
        className="dbg-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize debug console"
        tabIndex={open ? 0 : -1}
        onPointerDown={beginResize}
        onKeyDown={onResizeKey}
      />
      {body}
    </div>
  )
}
