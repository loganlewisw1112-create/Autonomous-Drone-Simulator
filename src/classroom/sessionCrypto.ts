import { gcm } from '@noble/ciphers/aes.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { toBase64, fromBase64 } from '@/account/crypto'
import {
  PROTOCOL_VERSION,
  type ClassId,
  type Sealed,
  type SealedDirection,
  type SealedMsgType,
} from '@/classroom/protocol'

// Version-2 session encryption carried by classroom protocol v3. The shared key is bound to the class and both
// X25519 public keys. Every AES-GCM frame additionally authenticates its protocol
// version, class, direction and semantic message type as AAD, so ciphertext cannot
// be replayed into another room, reversed, or relabelled by the relay.

export interface KeyPair {
  publicKey: string
  secretKey: Uint8Array
}

export interface SealedContext {
  direction: SealedDirection
  type: SealedMsgType
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const INFO_PREFIX = `dsim-class-v${PROTOCOL_VERSION}`

export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen()
  return { publicKey: toBase64(publicKey), secretKey }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** Stable out-of-band fingerprint used in the student join URL fragment. */
export function publicKeyFingerprint(publicKeyB64: string): string {
  return base64Url(sha256(fromBase64(publicKeyB64)))
}

export function deriveSharedKey(
  secretKey: Uint8Array,
  peerPublicKeyB64: string,
  classId: ClassId,
): Uint8Array {
  const ownPublic = x25519.getPublicKey(secretKey)
  const peerPublic = fromBase64(peerPublicKeyB64)
  const shared = x25519.getSharedSecret(secretKey, peerPublic)
  const ordered = compareBytes(ownPublic, peerPublic) <= 0
    ? [base64Url(ownPublic), base64Url(peerPublic)]
    : [base64Url(peerPublic), base64Url(ownPublic)]
  const info = enc.encode(`${INFO_PREFIX}\0${ordered[0]}\0${ordered[1]}`)
  return hkdf(sha256, shared, enc.encode(classId), info, 32)
}

function additionalData(classId: ClassId, context: SealedContext): Uint8Array {
  return enc.encode([
    `v=${PROTOCOL_VERSION}`,
    `class=${classId}`,
    `direction=${context.direction}`,
    `type=${context.type}`,
  ].join('\0'))
}

export class SessionCipher {
  private constructor(
    private readonly key: Uint8Array,
    private readonly classId: ClassId,
  ) {}

  static forInstructor(
    instructorSecret: Uint8Array,
    studentPubKeyB64: string,
    classId: ClassId,
  ): SessionCipher {
    return new SessionCipher(
      deriveSharedKey(instructorSecret, studentPubKeyB64, classId),
      classId,
    )
  }

  static forStudent(
    studentSecret: Uint8Array,
    classPubKeyB64: string,
    classId: ClassId,
  ): SessionCipher {
    return new SessionCipher(
      deriveSharedKey(studentSecret, classPubKeyB64, classId),
      classId,
    )
  }

  seal(value: unknown, context: SealedContext): Sealed {
    const iv = randomBytes(12)
    const ct = gcm(this.key, iv, additionalData(this.classId, context))
      .encrypt(enc.encode(JSON.stringify(value)))
    return { iv: toBase64(iv), ct: toBase64(ct) }
  }

  open<T>(sealed: Sealed, context: SealedContext): T {
    const pt = gcm(
      this.key,
      fromBase64(sealed.iv),
      additionalData(this.classId, context),
    ).decrypt(fromBase64(sealed.ct))
    return JSON.parse(dec.decode(pt)) as T
  }
}
