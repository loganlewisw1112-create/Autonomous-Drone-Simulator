import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

// Client-side instructor unlock check. The expected digest is injected at build
// time from deployment configuration or the gitignored local-secrets folder.
// Honest friction — not DRM. Anyone who patches the bundle can bypass it.

const enc = new TextEncoder()

/** Strip spaces/newlines/zero-width chars from pasted unlock material. */
function normalizeUnlockInput(code: string): string {
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

/**
 * Build-time digest. Prefer the explicit Vite `define` symbol (reliable across
 * chunks) and fall back to import.meta.env for older / test stubs.
 */
function buildTimeInstructorAccessHash(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defined = (globalThis as any).__INSTRUCTOR_ACCESS_HASH__ as unknown
    if (typeof defined === 'string' && defined.trim()) return defined
  } catch { /* ignore */ }
  const fromEnv = import.meta.env.VITE_INSTRUCTOR_ACCESS_HASH
  return typeof fromEnv === 'string' ? fromEnv : undefined
}

export function configuredInstructorAccessHash(
  envHash: string | undefined = buildTimeInstructorAccessHash(),
): string | null {
  if (typeof envHash !== 'string') return null
  const trimmed = envHash.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(trimmed)) return null
  return trimmed
}

export function verifyInstructorAccessCode(
  code: string,
  envHash: string | undefined = buildTimeInstructorAccessHash(),
): boolean {
  const expected = configuredInstructorAccessHash(envHash)
  if (!expected) return false
  const trimmed = normalizeUnlockInput(code)
  if (!trimmed) return false
  // Accept the agency plaintext code (hashed client-side) OR the 64-char hex hash
  // pasted directly during supervised instructor setup.
  const asHex = trimmed.toLowerCase()
  if (/^[0-9a-f]{64}$/.test(asHex) && timingSafeEqualHex(asHex, expected)) return true
  return timingSafeEqualHex(hashInstructorAccessCode(trimmed).toLowerCase(), expected)
}
