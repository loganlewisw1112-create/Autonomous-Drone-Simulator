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
const AAD_PREFIX = 'drone-sim/account/v2'

export type AccountCipherKind =
  | 'check'
  | 'prefs'
  | 'run-summary'
  | 'run-detail'
  | 'custom-mission'
  | 'classroom-meta'
  | 'classroom-session'

/** Stable, record-specific identity used as AES-GCM additional authenticated data. */
export function accountCipherAad(
  kind: AccountCipherKind,
  accountId: string,
  recordId = accountId,
): string {
  if (!accountId || !recordId) throw new Error('Cipher AAD requires account and record ids')
  return `${AAD_PREFIX}/${kind}/${encodeURIComponent(accountId)}/${encodeURIComponent(recordId)}`
}

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

export function encryptJson(key: Uint8Array, value: unknown, aad: string): CipherBlob {
  if (!aad) throw new Error('AES-GCM v2 requires record-bound AAD')
  const iv = randomBytes(12)
  const ct = gcm(key, iv, enc.encode(aad)).encrypt(enc.encode(JSON.stringify(value)))
  return { version: 2, iv: toBase64(iv), ct: toBase64(ct), aad }
}

/** Test/migration helper for reproducing blobs written by v1. */
export function encryptLegacyJson(key: Uint8Array, value: unknown): CipherBlob {
  const iv = randomBytes(12)
  const ct = gcm(key, iv).encrypt(enc.encode(JSON.stringify(value)))
  return { version: 1, iv: toBase64(iv), ct: toBase64(ct) }
}

export function isLegacyCipherBlob(blob: CipherBlob): boolean {
  return blob.version !== 2
}

// Throws on auth-tag failure, wrong record context, or missing v2 context.
export function decryptJson<T>(key: Uint8Array, blob: CipherBlob, expectedAad?: string): T {
  let aad: Uint8Array | undefined
  if (blob.version === 2) {
    if (!expectedAad || blob.aad !== expectedAad) {
      throw new Error('Ciphertext record context does not match')
    }
    aad = enc.encode(expectedAad)
  }
  const pt = gcm(key, fromBase64(blob.iv), aad).decrypt(fromBase64(blob.ct))
  return JSON.parse(dec.decode(pt)) as T
}

export function makeCheckBlob(key: Uint8Array, accountId: string): CipherBlob {
  return encryptJson(key, { check: CHECK_MARKER }, accountCipherAad('check', accountId))
}

export function verifyCheckBlob(key: Uint8Array, blob: CipherBlob, accountId: string): boolean {
  try {
    const parsed = decryptJson<{ check?: string }>(key, blob, accountCipherAad('check', accountId))
    return parsed.check === CHECK_MARKER
  } catch {
    return false
  }
}

export function makeId(): string {
  return toBase64(randomBytes(9)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c] ?? ''))
}
