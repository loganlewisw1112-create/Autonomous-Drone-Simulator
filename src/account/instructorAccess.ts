import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

// Client-side instructor unlock check. The expected digest is injected at build
// time from deployment configuration or the gitignored local-secrets folder.
// Honest friction — not DRM. Anyone who patches the bundle can bypass it.

const enc = new TextEncoder()

export function hashInstructorAccessCode(code: string): string {
  return bytesToHex(sha256(enc.encode(code.trim())))
}

/** Constant-time hex compare (equal length required). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function configuredInstructorAccessHash(
  envHash: string | undefined = import.meta.env.VITE_INSTRUCTOR_ACCESS_HASH,
): string | null {
  if (typeof envHash !== 'string') return null
  const trimmed = envHash.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(trimmed)) return null
  return trimmed
}

export function verifyInstructorAccessCode(
  code: string,
  envHash: string | undefined = import.meta.env.VITE_INSTRUCTOR_ACCESS_HASH,
): boolean {
  const expected = configuredInstructorAccessHash(envHash)
  if (!expected) return false
  const trimmed = code.trim()
  if (!trimmed) return false
  // Accept the agency plaintext code (hashed client-side) OR the 64-char hex hash
  // pasted directly during supervised instructor setup.
  const asHex = trimmed.toLowerCase()
  if (/^[0-9a-f]{64}$/.test(asHex) && timingSafeEqualHex(asHex, expected)) return true
  return timingSafeEqualHex(hashInstructorAccessCode(trimmed).toLowerCase(), expected)
}
