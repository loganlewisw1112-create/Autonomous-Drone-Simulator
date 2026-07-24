import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

// Client-side instructor unlock. Expected digest may come from:
//   1) Build-time env / vite define (Vercel dashboard or local-secrets at build)
//   2) Device localStorage after first-typed-code provision (Option A)
// Honest friction — not DRM. Anyone who patches the bundle can bypass it.

const enc = new TextEncoder()

/** Device-local school unlock digest. Gitignored disk copy is written by the LAN relay. */
export const DEVICE_INSTRUCTOR_ACCESS_HASH_KEY = 'drone-sim:instructor-access-hash:v1'

/** Strip spaces/newlines/zero-width chars from pasted unlock material. */
export function normalizeUnlockInput(code: string): string {
  return code
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

export function hashInstructorAccessCode(code: string): string {
  return bytesToHex(sha256(enc.encode(normalizeUnlockInput(code))))
}

/** Constant-time hex compare (equal length required). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function parseHash(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(trimmed)) return null
  return trimmed
}

/**
 * Build-time digest. Prefer the explicit Vite `define` symbol (reliable across
 * chunks) and fall back to import.meta.env for older / test stubs.
 */
function buildTimeInstructorAccessHash(): string | undefined {
  try {
    // Replaced at build time by vite.config `define.__INSTRUCTOR_ACCESS_HASH__`.
    if (typeof __INSTRUCTOR_ACCESS_HASH__ === 'string' && __INSTRUCTOR_ACCESS_HASH__.trim()) {
      return __INSTRUCTOR_ACCESS_HASH__
    }
  } catch { /* ignore when define is absent (unit tests) */ }
  const fromEnv = import.meta.env.VITE_INSTRUCTOR_ACCESS_HASH
  return typeof fromEnv === 'string' ? fromEnv : undefined
}

function resolveStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/** Runtime hash saved on this browser after first-typed-code setup. */
export function readDeviceInstructorAccessHash(): string | null {
  const storage = resolveStorage()
  if (!storage) return null
  try {
    return parseHash(storage.getItem(DEVICE_INSTRUCTOR_ACCESS_HASH_KEY))
  } catch {
    return null
  }
}

/** Persist school unlock digest on this device. Does not overwrite an existing digest. */
export function writeDeviceInstructorAccessHash(hash: string): boolean {
  const parsed = parseHash(hash)
  if (!parsed) return false
  const existing = readDeviceInstructorAccessHash()
  if (existing && !timingSafeEqualHex(existing, parsed)) return false
  const storage = resolveStorage()
  if (!storage) return false
  try {
    storage.setItem(DEVICE_INSTRUCTOR_ACCESS_HASH_KEY, parsed)
    return true
  } catch {
    return false
  }
}

/**
 * Intentional admin reset for this browser only. Does not delete LAN
 * `local-secrets/` — use the classroom relay DELETE endpoint or remove the
 * files on the instructor machine (see README).
 */
export function clearDeviceInstructorAccessHash(): void {
  const storage = resolveStorage()
  if (!storage) return
  try {
    storage.removeItem(DEVICE_INSTRUCTOR_ACCESS_HASH_KEY)
  } catch { /* private mode */ }
}

/**
 * Effective expected digest for unlock checks.
 * Priority: explicit override (tests) → build-time env → device localStorage.
 * Never invents a hash; returns null when nothing is configured yet (first-code path).
 */
export function configuredInstructorAccessHash(envHash?: string): string | null {
  if (arguments.length >= 1) return parseHash(envHash)
  return parseHash(buildTimeInstructorAccessHash()) ?? readDeviceInstructorAccessHash()
}

/** True when a school unlock digest is already known on this build/device. */
export function instructorAccessIsConfigured(envHash?: string): boolean {
  return arguments.length >= 1
    ? configuredInstructorAccessHash(envHash) !== null
    : configuredInstructorAccessHash() !== null
}

export function verifyInstructorAccessCode(code: string, envHash?: string): boolean {
  const expected = arguments.length >= 2
    ? configuredInstructorAccessHash(envHash)
    : configuredInstructorAccessHash()
  if (!expected) return false
  const trimmed = normalizeUnlockInput(code)
  if (!trimmed) return false
  // Accept the agency plaintext code (hashed client-side) OR the 64-char hex hash
  // pasted directly during supervised instructor setup.
  const asHex = trimmed.toLowerCase()
  if (/^[0-9a-f]{64}$/.test(asHex) && timingSafeEqualHex(asHex, expected)) return true
  return timingSafeEqualHex(hashInstructorAccessCode(trimmed).toLowerCase(), expected)
}

/**
 * First-typed-code provision on this device (Option A).
 * Fails closed if a digest already exists — never silently overwrite.
 */
export function provisionInstructorAccessCode(code: string):
  | { ok: true; hash: string }
  | { ok: false; reason: 'empty' | 'already-configured' | 'storage-unavailable' } {
  const trimmed = normalizeUnlockInput(code)
  if (!trimmed) return { ok: false, reason: 'empty' }
  if (configuredInstructorAccessHash()) return { ok: false, reason: 'already-configured' }
  const hash = hashInstructorAccessCode(trimmed).toLowerCase()
  if (!writeDeviceInstructorAccessHash(hash)) {
    return { ok: false, reason: 'storage-unavailable' }
  }
  return { ok: true, hash }
}
