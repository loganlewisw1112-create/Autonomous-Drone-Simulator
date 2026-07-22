import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { encryptJson, decryptJson, toBase64, fromBase64 } from '@/account/crypto'
import type { ClassId, Sealed } from '@/classroom/protocol'

// Envelope encryption to the instructor's key. x25519 ECDH gives instructor and
// student the same secret; HKDF-SHA-256 salts it by classId and stretches to a
// 32-byte AES key. Per-frame AES-256-GCM then reuses the account crypto stack
// verbatim (no crypto.subtle → works over plain-HTTP LAN). The ECDH runs ONCE per
// session; caching the AES key is what keeps 24 opens/sec free.

export interface KeyPair {
  publicKey: string // base64
  secretKey: Uint8Array
}

const enc = new TextEncoder()
const INFO = enc.encode('dsim-class-v1')

export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen()
  return { publicKey: toBase64(publicKey), secretKey }
}

// shared = ECDH(mySecret, peerPublic); key = HKDF(shared, salt=classId, info).
// Instructor(classPriv, studentPub) and student(studentPriv, classPub) land on the
// identical shared point, so both derive the identical key.
export function deriveSharedKey(secretKey: Uint8Array, peerPublicKeyB64: string, classId: ClassId): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, fromBase64(peerPublicKeyB64))
  return hkdf(sha256, shared, enc.encode(classId), INFO, 32)
}

// Holds the derived AES key for one instructor↔student session. seal/open are then
// plain per-frame GCM with a fresh IV, microseconds each.
export class SessionCipher {
  private constructor(private readonly key: Uint8Array) {}

  static forInstructor(instructorSecret: Uint8Array, studentPubKeyB64: string, classId: ClassId): SessionCipher {
    return new SessionCipher(deriveSharedKey(instructorSecret, studentPubKeyB64, classId))
  }

  static forStudent(studentSecret: Uint8Array, classPubKeyB64: string, classId: ClassId): SessionCipher {
    return new SessionCipher(deriveSharedKey(studentSecret, classPubKeyB64, classId))
  }

  seal(value: unknown): Sealed {
    return encryptJson(this.key, value)
  }

  // Throws on auth-tag failure (wrong key / tampered blob) — same contract as decryptJson.
  open<T>(sealed: Sealed): T {
    return decryptJson<T>(this.key, sealed)
  }
}
