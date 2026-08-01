import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto'
import { LicensingError, type EntitlementClaims } from './contracts.js'

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function base64url(input: Uint8Array | string): string {
  return Buffer.from(input).toString('base64url')
}

export function decodeBase64url(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new LicensingError('invalid-request', 'Malformed base64url value.', 400)
  }
  return Buffer.from(input, 'base64url')
}

export function normalizeCode(input: string): string {
  const compact = input.toUpperCase().replace(/[\s-]/g, '')
  const body = compact.startsWith('ADMS') ? compact.slice(4) : compact
  if (body.length !== 32 || !/^[0-9A-HJKMNP-TV-Z]{32}$/.test(body)) {
    throw new LicensingError('code-unavailable', 'The code is invalid, expired, or already used.', 409)
  }
  return `ADMS-${body.match(/.{1,4}/g)!.join('-')}`
}

export function generateRedemptionCode(bytes: Uint8Array = randomBytes(20)): string {
  if (bytes.length !== 20) throw new Error('Redemption codes require exactly 160 random bits')
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`)
  let encoded = ''
  for (let index = 0; index < 32; index += 1) {
    encoded = CROCKFORD_ALPHABET[Number(value & 31n)] + encoded
    value >>= 5n
  }
  return `ADMS-${encoded.match(/.{1,4}/g)!.join('-')}`
}

export function hmacDigest(key: Uint8Array, purpose: string, value: string): Buffer {
  return createHmac('sha256', key).update(`${purpose}\0${value}`, 'utf8').digest()
}

export function pseudonym(key: Uint8Array, purpose: string, value: string): string {
  return base64url(hmacDigest(key, purpose, value)).slice(0, 22)
}

export function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

export function importInstallationPublicKey(spkiBase64url: string): KeyObject {
  const der = decodeBase64url(spkiBase64url)
  if (der.length > 128) throw new LicensingError('invalid-request', 'Installation key is too large.', 400)
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
    return key
  } catch {
    throw new LicensingError('invalid-request', 'Installation key must be an Ed25519 SPKI key.', 400)
  }
}

export function installationThumbprint(spkiBase64url: string): string {
  const key = importInstallationPublicKey(spkiBase64url)
  const canonical = key.export({ format: 'der', type: 'spki' })
  return base64url(createHash('sha256').update(canonical).digest())
}

export function verifyChallengeSignature(
  publicKeyBase64url: string,
  challenge: string,
  signatureBase64url: string,
): void {
  const key = importInstallationPublicKey(publicKeyBase64url)
  const signature = decodeBase64url(signatureBase64url)
  if (signature.length !== 64 || !verify(null, Buffer.from(challenge, 'utf8'), key, signature)) {
    throw new LicensingError('invalid-proof', 'Installation proof could not be verified.', 401)
  }
}

export function signCompactJws(
  claims: EntitlementClaims,
  privateKey: KeyObject,
  keyId: string,
): string {
  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: keyId }))
  const payload = base64url(JSON.stringify(claims))
  const signingInput = `${header}.${payload}`
  const signature = sign(null, Buffer.from(signingInput, 'ascii'), privateKey)
  return `${signingInput}.${base64url(signature)}`
}

export function verifyCompactJws(
  compact: string,
  publicKey: KeyObject,
  expectedKeyId: string,
): EntitlementClaims {
  const parts = compact.split('.')
  if (parts.length !== 3) throw new LicensingError('invalid-proof', 'Entitlement is malformed.', 401)
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]
  let header: unknown
  let claims: unknown
  try {
    header = JSON.parse(decodeBase64url(encodedHeader).toString('utf8'))
    claims = JSON.parse(decodeBase64url(encodedPayload).toString('utf8'))
  } catch {
    throw new LicensingError('invalid-proof', 'Entitlement is malformed.', 401)
  }
  if (
    typeof header !== 'object' || header === null ||
    (header as Record<string, unknown>).alg !== 'EdDSA' ||
    (header as Record<string, unknown>).kid !== expectedKeyId
  ) {
    throw new LicensingError('invalid-proof', 'Entitlement signing key is not trusted.', 401)
  }
  const valid = verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
    publicKey,
    decodeBase64url(encodedSignature),
  )
  if (!valid) throw new LicensingError('invalid-proof', 'Entitlement signature could not be verified.', 401)
  return claims as EntitlementClaims
}
