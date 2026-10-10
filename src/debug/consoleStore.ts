import { create } from 'zustand'
import type { DebugLine, DebugLineKind } from '@/debug/types'

// Shared console state. Lives outside the component tree so commands (`clear`,
// `history`), hotkey bindings and the pop-out window all drive one scrollback.

export const MAX_CONSOLE_LINES = 2000
export const MAX_HISTORY = 200
export const MIN_CONSOLE_HEIGHT = 140
const DEFAULT_CONSOLE_HEIGHT = 300

const HEIGHT_KEY = 'drone-sim:debug-height:v1'
const historyKey = (email: string) => `drone-sim:debug-history:v1:${email.toLowerCase()}`

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage may be blocked or full; the console works without persistence.
  }
}

function initialHeight(): number {
  const stored = Number(readStorage(HEIGHT_KEY))
  return Number.isFinite(stored) && stored >= MIN_CONSOLE_HEIGHT ? stored : DEFAULT_CONSOLE_HEIGHT
}

interface ConsoleState {
  open: boolean
  poppedOut: boolean
  height: number
  lines: DebugLine[]
  history: string[]
  historyEmail: string | null
  nextId: number
  print: (text: string, kind?: DebugLineKind) => void
  clear: () => void
  setOpen: (open: boolean) => void
  toggle: () => void
  setPoppedOut: (poppedOut: boolean) => void
  setHeight: (height: number) => void
  loadHistory: (email: string | null) => void
  pushHistory: (line: string) => void
}

export const useConsoleStore = create<ConsoleState>()((set, get) => ({
  open: false,
  poppedOut: false,
  height: initialHeight(),
  lines: [],
  history: [],
  historyEmail: null,
  nextId: 1,
  print: (text, kind = 'out') =>
    set((s) => {
      const lines = [...s.lines, { id: s.nextId, kind, text, at: Date.now() }]
      return {
        lines: lines.length > MAX_CONSOLE_LINES ? lines.slice(lines.length - MAX_CONSOLE_LINES) : lines,
        nextId: s.nextId + 1,
      }
    }),
  clear: () => set({ lines: [] }),
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setPoppedOut: (poppedOut) => set({ poppedOut }),
  setHeight: (height) => {
    const next = Math.max(MIN_CONSOLE_HEIGHT, Math.round(height))
    writeStorage(HEIGHT_KEY, String(next))
    set({ height: next })
  },
  loadHistory: (email) => {
    if (!email) {
      set({ history: [], historyEmail: null })
      return
    }
    let history: string[] = []
    try {
      const parsed: unknown = JSON.parse(readStorage(historyKey(email)) ?? '[]')
      if (Array.isArray(parsed)) history = parsed.filter((v): v is string => typeof v === 'string').slice(-MAX_HISTORY)
    } catch {
      history = []
    }
    set({ history, historyEmail: email })
  },
  pushHistory: (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const { history, historyEmail } = get()
    if (history[history.length - 1] === trimmed) return
    const next = [...history, trimmed].slice(-MAX_HISTORY)
    set({ history: next })
    if (historyEmail) writeStorage(historyKey(historyEmail), JSON.stringify(next))
  },
}))

/** Command output sink shared by the typed input, hotkey bindings and tests. */
export const consoleIo = {
  print: (text: string, kind?: DebugLineKind) => useConsoleStore.getState().print(text, kind),
  json: (value: unknown) => {
    let text: string
    try {
      text = JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      text = String(value)
    }
    useConsoleStore.getState().print(text, 'json')
  },
}
