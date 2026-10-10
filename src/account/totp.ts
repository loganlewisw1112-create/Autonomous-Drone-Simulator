import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { randomBytes } from '@noble/ciphers/utils.js'

// RFC 6238 time-based one-time passwords (HMAC-SHA-1, 30 s step, 6 digits), the
// profile every authenticator app implements. Pure functions: callers pass the
// clock so tests can use the RFC vectors.
//
// HONEST LIMITATION: profiles are local-only IndexedDB records with no server, so
// the authenticator is a UI-level gate in the password-reset flow, not a second
// cryptographic factor. The seed is stored encrypted under the recovery key; the
// recovery code alone unwraps the data key. Someone holding the recovery code and
// devtools can bypass the TOTP prompt. The recovery code is the cryptographic factor.

export const TOTP_STEP_SEC = 30
export const TOTP_DIGITS = 6
export const TOTP_ISSUER = 'Drone Ops Center'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32, unpadded (what authenticator apps expect in `secret=`). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

/** Decodes unpadded or padded base32; ignores case, spaces and dashes. Throws on bad characters. */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error('Invalid base32 character')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** A fresh 160-bit authenticator seed. */
export function generateTotpSecret(): Uint8Array {
  return randomBytes(20)
}

/** HOTP (RFC 4226) dynamic truncation of HMAC-SHA-1 over an 8-byte big-endian counter. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = new Uint8Array(8)
  const view = new DataView(msg.buffer)
  view.setUint32(0, Math.floor(counter / 2 ** 32))
  view.setUint32(4, counter >>> 0)
  const mac = hmac(sha1, secret, msg)
  const offset = mac[mac.length - 1] & 0x0f
  const bin = ((mac[offset] & 0x7f) << 24)
    | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8)
    | mac[offset + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export function totpCode(secret: Uint8Array, timeMs: number, digits = TOTP_DIGITS): string {
  return hotp(secret, Math.floor(timeMs / 1000 / TOTP_STEP_SEC), digits)
}

/**
 * Accepts the current 30 s step plus/minus `window` steps (default 1) to absorb
 * clock drift. The comparison touches every candidate and every digit so timing
 * does not reveal which step matched.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  timeMs: number = Date.now(),
  window = 1,
): boolean {
  const clean = code.replace(/[\s-]/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  const step = Math.floor(timeMs / 1000 / TOTP_STEP_SEC)
  let matched = 0
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secret, step + w)
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ clean.charCodeAt(i)
    if (diff === 0) matched = 1
  }
  return matched === 1
}

/** otpauth:// provisioning URI (Key URI Format) that authenticator apps scan. */
export function buildOtpauthUri(username: string, secretBase32: string): string {
  const label = `${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(username)}`
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(TOTP_ISSUER)}`
}

/** Groups a base32 secret in fours for manual entry. */
export function formatSecretForDisplay(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, '$1 ').trim()
}
