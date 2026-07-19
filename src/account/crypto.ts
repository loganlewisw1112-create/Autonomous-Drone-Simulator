import { pbkdf2 } from '@noble/hashes/pbkdf2'
import { sha256 } from '@noble/hashes/sha256'
import { gcm } from '@noble/ciphers/aes.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import { CHECK_MARKER, PBKDF2_ITERATIONS } from '@/account/types'
import type { CipherBlob, KdfParams } from '@/account/types'

// All-noble crypto stack (no crypto.subtle): synchronous, testable in jsdom,
// and functional over plain-http LAN dev where SubtleCrypto is unavailable.
// PBKDF2-HMAC-SHA-256 (OWASP-level iterations) → 32-byte key → AES-256-GCM.

const enc = new TextEncoder()
const dec = new TextDecoder()

export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  bytes.forEach((b) => { bin += String.fromCharCode(b) })
  return btoa(bin)
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function makeKdfParams(): KdfParams {
  return {
    kdf: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(randomBytes(16)),
  }
}

export function deriveKey(password: string, params: KdfParams): Uint8Array {
  return pbkdf2(sha256, enc.encode(password), fromBase64(params.salt), {
    c: params.iterations,
    dkLen: 32,
  })
}

export function encryptJson(key: Uint8Array, value: unknown): CipherBlob {
  const iv = randomBytes(12)
  const ct = gcm(key, iv).encrypt(enc.encode(JSON.stringify(value)))
  return { iv: toBase64(iv), ct: toBase64(ct) }
}

// Throws on auth-tag failure (wrong key / tampered blob).
export function decryptJson<T>(key: Uint8Array, blob: CipherBlob): T {
  const pt = gcm(key, fromBase64(blob.iv)).decrypt(fromBase64(blob.ct))
  return JSON.parse(dec.decode(pt)) as T
}

export function makeCheckBlob(key: Uint8Array): CipherBlob {
  return encryptJson(key, { check: CHECK_MARKER })
}

export function verifyCheckBlob(key: Uint8Array, blob: CipherBlob): boolean {
  try {
    const parsed = decryptJson<{ check?: string }>(key, blob)
    return parsed.check === CHECK_MARKER
  } catch {
    return false
  }
}

export function makeId(): string {
  return toBase64(randomBytes(9)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c] ?? ''))
}
