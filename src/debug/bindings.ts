import { runDebugLine } from '@/debug/registry'
import { consoleIo } from '@/debug/consoleStore'

// Hotkey bindings for the admin debug console. A binding maps a key combo to a
// console command line. Persisted per admin email; every storage access is wrapped
// because localStorage can be blocked or throw.

const storageKey = (email: string) => `drone-sim:debug-binds:v1:${email.toLowerCase()}`
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const
const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', meta: 'meta', cmd: 'meta', win: 'meta',
}
const KEY_ALIASES: Record<string, string> = { esc: 'escape', space: ' ', spacebar: ' ', plus: '+', del: 'delete', return: 'enter' }

let activeEmail: string | null = null
let bindings: Record<string, string> = {}

/** Canonical form: modifiers in ctrl/alt/shift/meta order, then the lower-cased key. Null when unparseable. */
export function normalizeCombo(combo: string): string | null {
  const trimmed = combo.trim().toLowerCase()
  if (!trimmed) return null
  // A trailing "+" is the plus key itself ("ctrl++"); a lone "+" is too.
  const plusKey = trimmed === '+' || trimmed.endsWith('++')
  const head = plusKey ? trimmed.slice(0, -1) : trimmed
  const parts = head.split('+').map((p) => p.trim()).filter((p, i, all) => !(plusKey && i === all.length - 1 && p === ''))
  const keyToken = plusKey ? '+' : parts.pop()
  if (!keyToken) return null
  const mods = new Set<string>()
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part]
    if (!mod) return null
    mods.add(mod)
  }
  const key = KEY_ALIASES[keyToken] ?? keyToken
  if (key in MODIFIER_ALIASES) return null
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+')
}

export function comboFromEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  const key = event.key.toLowerCase()
  if (key in MODIFIER_ALIASES || key === 'dead') return null
  const mods = [event.ctrlKey && 'ctrl', event.altKey && 'alt', event.shiftKey && 'shift', event.metaKey && 'meta'].filter(Boolean)
  return [...mods, key].join('+')
}

function persist(): void {
  if (!activeEmail) return
  try {
    window.localStorage.setItem(storageKey(activeEmail), JSON.stringify(bindings))
  } catch {
    // Bindings stay in memory for this session.
  }
}

/** Switch to the bindings of this admin (or none when signed out / not admin). */
export function loadBindings(email: string | null): void {
  activeEmail = email
  bindings = {}
  if (!email) return
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(email)) ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [combo, line] of Object.entries(parsed)) {
        const normalized = normalizeCombo(combo)
        if (normalized && typeof line === 'string' && line.trim()) bindings[normalized] = line
      }
    }
  } catch {
    bindings = {}
  }
}

export function getBindings(): Readonly<Record<string, string>> {
  return bindings
}

/** Returns the canonical combo, or null if it could not be parsed. */
export function setBinding(combo: string, line: string): string | null {
  const normalized = normalizeCombo(combo)
  if (!normalized || !line.trim()) return null
  bindings = { ...bindings, [normalized]: line.trim() }
  persist()
  return normalized
}

export function removeBinding(combo: string): boolean {
  const normalized = normalizeCombo(combo)
  if (!normalized || !(normalized in bindings)) return false
  const { [normalized]: _removed, ...rest } = bindings
  bindings = rest
  persist()
  return true
}

/** True when keyboard focus is in an editable field that is not the console's own input. */
export function isForeignTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  if (el.dataset?.debugConsoleInput === 'true') return false
  if (el.isContentEditable) return true
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

/**
 * Fire the binding for a keydown, if any. Bindings only load for a verified admin,
 * and the caller passes the live admin flag, so a non-admin can never fire one.
 */
export function handleBindingKeydown(event: KeyboardEvent, isAdmin: boolean): boolean {
  if (!isAdmin || !activeEmail || event.repeat) return false
  if (isForeignTextTarget(event.target)) return false
  const combo = comboFromEvent(event)
  const line = combo ? bindings[combo] : undefined
  if (!line) return false
  event.preventDefault()
  consoleIo.print(`[bind ${combo}] ${line}`, 'cmd')
  void runDebugLine(line, consoleIo)
  return true
}
