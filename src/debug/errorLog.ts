// Admin debug console: ring buffer of runtime errors. Installed only while an
// admin is signed in (see DebugConsoleRoot) and fully uninstalled on sign-out,
// so a non-admin session never has its error handling touched.

export type ErrorLogSource = 'error' | 'unhandledrejection' | 'console.error'

export interface ErrorLogEntry {
  at: number
  source: ErrorLogSource
  message: string
  stack?: string
}

export const ERROR_LOG_CAPACITY = 200

let entries: ErrorLogEntry[] = []
let installed = false
let originalConsoleError: typeof console.error | null = null
let wrappedConsoleError: typeof console.error | null = null

function record(source: ErrorLogSource, message: string, stack?: string): void {
  entries.push({ at: Date.now(), source, message: message.slice(0, 2000), ...(stack ? { stack: stack.slice(0, 4000) } : {}) })
  if (entries.length > ERROR_LOG_CAPACITY) entries = entries.slice(entries.length - ERROR_LOG_CAPACITY)
}

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: `${value.name}: ${value.message}`, stack: value.stack }
  if (typeof value === 'string') return { message: value }
  try {
    return { message: JSON.stringify(value) ?? String(value) }
  } catch {
    return { message: String(value) }
  }
}

function onError(event: ErrorEvent): void {
  const detail = event.error !== undefined && event.error !== null ? describe(event.error) : { message: event.message }
  record('error', detail.message || event.message, detail.stack)
}

function onRejection(event: PromiseRejectionEvent): void {
  const detail = describe(event.reason)
  record('unhandledrejection', detail.message, detail.stack)
}

export function installErrorCapture(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  originalConsoleError = console.error
  wrappedConsoleError = (...args: unknown[]) => {
    try {
      record('console.error', args.map((arg) => describe(arg).message).join(' '))
    } catch {
      // Capture must never break the app's own logging.
    }
    originalConsoleError?.apply(console, args)
  }
  console.error = wrappedConsoleError
}

export function uninstallErrorCapture(): void {
  if (!installed) return
  installed = false
  window.removeEventListener('error', onError)
  window.removeEventListener('unhandledrejection', onRejection)
  // Only restore when nobody wrapped console.error after us; otherwise leave their wrapper intact.
  if (console.error === wrappedConsoleError && originalConsoleError) console.error = originalConsoleError
  originalConsoleError = null
  wrappedConsoleError = null
}

export function isErrorCaptureInstalled(): boolean {
  return installed
}

export function getErrorLog(): readonly ErrorLogEntry[] {
  return entries
}

export function clearErrorLog(): void {
  entries = []
}
