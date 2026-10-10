import { randomBytes } from '@noble/ciphers/utils.js'
import {
  accountCipherAad,
  decryptJson,
  deriveKey,
  encryptJson,
  fromBase64,
  makeKdfParams,
  toBase64,
  verifyCheckBlob,
  type AccountCipherKind,
} from '@/account/crypto'
import { base32Decode, base32Encode } from '@/account/totp'
import type { AccountRecord, CipherBlob, KdfParams, KeyWraps, TotpRecord } from '@/account/types'

// Password recovery by envelope key wraps. A random 32-byte data key K encrypts
// every account record. K is stored encrypted under the password-derived key and
// under a recovery-code-derived key, so either can unlock K and a password reset
// re-wraps K without re-encrypting any run, mission or classroom blob.
//
// Legacy accounts (no `keyWraps`) use the password-derived key AS the data key.
// They keep signing in unchanged; setting up recovery wraps that same key, so
// nothing already on disk is re-encrypted.
//
// Everything here is synchronous and uses `deriveKey` from '@/account/crypto' so
// the fast-KDF test mock applies.

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32
const CODE_CHARS = 24                                       // 24 x 5 bits = 120 bits
const CODE_BYTES = 15

/** Fresh 120-bit recovery code, e.g. `7QK2-M9XD-4TRA-W0HB-V6NE-C3JZ`. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(CODE_BYTES)
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += CODE_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return formatRecoveryCode(out)
}

function formatRecoveryCode(canonical: string): string {
  return canonical.match(/.{4}/g)!.join('-')
}

/**
 * Canonical 24-character form of user-typed input, or null when it cannot be a
 * recovery code. Case-insensitive; spaces and dashes are ignored; O reads as 0 and
 * I or L read as 1 (the Crockford confusables).
 */
export function normalizeRecoveryCode(input: string): string | null {
  const canonical = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (canonical.length !== CODE_CHARS) return null
  for (const ch of canonical) if (!CODE_ALPHABET.includes(ch)) return null
  return canonical
}

export interface RecoveryMaterial {
  /** Display form `XXXX-XXXX-…`. Shown once; never stored. */
  code: string
  key: Uint8Array
  kdf: KdfParams
}

export function newRecoveryMaterial(): RecoveryMaterial {
  const code = generateRecoveryCode()
  const kdf = makeKdfParams()
  return { code, key: deriveKey(normalizeRecoveryCode(code)!, kdf), kdf }
}

function wrapKey(
  wrappingKey: Uint8Array,
  dataKey: Uint8Array,
  kind: AccountCipherKind,
  accountId: string,
): CipherBlob {
  return encryptJson(wrappingKey, { k: toBase64(dataKey) }, accountCipherAad(kind, accountId))
}

function unwrapKey(
  wrappingKey: Uint8Array,
  blob: CipherBlob,
  kind: AccountCipherKind,
  accountId: string,
): Uint8Array | null {
  try {
    const { k } = decryptJson<{ k: string }>(wrappingKey, blob, accountCipherAad(kind, accountId))
    const key = fromBase64(k)
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

/** A brand-new random data key for a new account. */
export function newDataKey(): Uint8Array {
  return randomBytes(32)
}

export function buildKeyWraps(
  accountId: string,
  dataKey: Uint8Array,
  passwordKey: Uint8Array,
  recovery: RecoveryMaterial,
): KeyWraps {
  return {
    version: 1,
    password: wrapKey(passwordKey, dataKey, 'key-wrap-password', accountId),
    recovery: wrapKey(recovery.key, dataKey, 'key-wrap-recovery', accountId),
    recoveryKdf: recovery.kdf,
  }
}

/**
 * Sign-in: the data key for `password`, or null when the password is wrong.
 * Wrapped accounts unwrap K with the password key; legacy accounts use the
 * password key itself. Either way the check blob has the final say.
 */
export function unlockDataKey(
  record: AccountRecord,
  password: string,
): { dataKey: Uint8Array; passwordKey: Uint8Array } | null {
  const passwordKey = deriveKey(password, record.kdfParams)
  const dataKey = record.keyWraps
    ? unwrapKey(passwordKey, record.keyWraps.password, 'key-wrap-password', record.id)
    : passwordKey
  if (!dataKey || !verifyCheckBlob(dataKey, record.checkBlob, record.id)) return null
  return { dataKey, passwordKey }
}

/** Reset path: K from a recovery code, or null when the code is wrong or unusable. */
export function unlockWithRecoveryCode(
  record: AccountRecord,
  code: string,
): { dataKey: Uint8Array; recoveryKey: Uint8Array } | null {
  const canonical = normalizeRecoveryCode(code)
  if (!canonical || !record.keyWraps) return null
  const recoveryKey = deriveKey(canonical, record.keyWraps.recoveryKdf)
  const dataKey = unwrapKey(recoveryKey, record.keyWraps.recovery, 'key-wrap-recovery', record.id)
  if (!dataKey || !verifyCheckBlob(dataKey, record.checkBlob, record.id)) return null
  return { dataKey, recoveryKey }
}

/** New kdfParams plus a password wrap of K for `newPassword`. Touches no data blob. */
export function rewrapForPassword(
  record: AccountRecord,
  dataKey: Uint8Array,
  newPassword: string,
): { kdfParams: KdfParams; keyWraps: KeyWraps } | null {
  if (!record.keyWraps) return null
  const kdfParams = makeKdfParams()
  const passwordKey = deriveKey(newPassword, kdfParams)
  return {
    kdfParams,
    keyWraps: {
      ...record.keyWraps,
      password: wrapKey(passwordKey, dataKey, 'key-wrap-password', record.id),
    },
  }
}

// ── Authenticator seed storage ───────────────────────────────────────────────
// The seed lives under K, not under the recovery key: the recovery code unwraps K,
// so the reset flow can verify a code, and pairing or rotating the recovery code
// never needs the shown-once code. See the HONEST LIMITATION note in totp.ts.

export function sealTotpSeed(
  seed: Uint8Array,
  dataKey: Uint8Array,
  accountId: string,
  pairedAt: number = Date.now(),
): TotpRecord {
  return {
    seed: encryptJson(dataKey, { seed: base32Encode(seed) }, accountCipherAad('totp-seed', accountId)),
    pairedAt,
  }
}

export function openTotpSeed(
  totp: TotpRecord,
  dataKey: Uint8Array,
  accountId: string,
): Uint8Array | null {
  try {
    const { seed } = decryptJson<{ seed: string }>(dataKey, totp.seed, accountCipherAad('totp-seed', accountId))
    return base32Decode(seed)
  } catch {
    return null
  }
}

/**
 * New recovery code and wrap for an account that is signed in (or just reset).
 * Wrapped accounts keep their password wrap; a legacy account's password-derived
 * key already IS the data key, so wrapping K under itself reproduces its password
 * wrap and nothing on disk is re-encrypted. The authenticator seed (sealed under K)
 * is unaffected by rotation.
 */
export function withRotatedRecovery(
  record: AccountRecord,
  dataKey: Uint8Array,
): { keyWraps: KeyWraps; code: string } {
  const recovery = newRecoveryMaterial()
  const keyWraps: KeyWraps = record.keyWraps
    ? {
      ...record.keyWraps,
      recovery: wrapKey(recovery.key, dataKey, 'key-wrap-recovery', record.id),
      recoveryKdf: recovery.kdf,
    }
    : buildKeyWraps(record.id, dataKey, dataKey, recovery)
  return {
    keyWraps,
    code: recovery.code,
  }
}
