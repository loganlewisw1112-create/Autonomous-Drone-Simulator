import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

// The LAN relay is the sole instructor-access authority. This browser module
// contains normalization and pure helpers only: no configured digest, build
// secret, localStorage credential, or offline authorization path.

const enc = new TextEncoder()

/**
 * Normalize Unicode and trim only the edges. Internal spaces and case remain
 * credential material and must never be collapsed.
 */
export function normalizeUnlockInput(code: string): string {
  return code
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
}

/** Pure helper retained for legacy-migration tests; never used as browser authority. */
export function hashInstructorAccessCode(code: string): string {
  return bytesToHex(sha256(enc.encode(normalizeUnlockInput(code))))
}

/** Constant-time hex compare retained for legacy-migration tests. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
