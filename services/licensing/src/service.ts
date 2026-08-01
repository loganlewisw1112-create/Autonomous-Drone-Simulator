import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  CHALLENGE_TTL_MS,
  ENTITLEMENT_FEATURES,
  LICENSING_AUDIENCE,
  LICENSING_SCHEMA_VERSION,
  LicensingError,
  OFFLINE_LEASE_MS,
  SERVICE_NAME,
  TIER_DURATION_MS,
  type ChallengeRequest,
  type ChallengeResponse,
  type EntitlementClaims,
  type EntitlementResponse,
  type HealthResponse,
  type RedeemRequest,
  type RefreshRequest,
} from './contracts.js'
import type { LicensingConfig } from './config.js'
import {
  base64url,
  hmacDigest,
  installationThumbprint,
  normalizeCode,
  pseudonym,
  signCompactJws,
  verifyChallengeSignature,
  verifyCompactJws,
} from './crypto.js'
import type { EntitlementRecord, LicensingRepository } from './repository.js'

export interface LicensingServiceDeps {
  repository: LicensingRepository
  config: LicensingConfig
  now?: () => Date
  random?: (bytes: number) => Buffer
  uuid?: () => string
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LicensingError('invalid-request', 'Request body must be a JSON object.', 400)
  }
  return value as Record<string, unknown>
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): string {
  const value = object[key]
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new LicensingError('invalid-request', `${key} is invalid.`, 400)
  }
  return value
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) throw new LicensingError('unsupported-version', 'Application version is not supported.', 426)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function assertSupportedVersion(version: string, minimum: string, maximumExclusive: string): void {
  if (compareVersions(version, minimum) < 0 || compareVersions(version, maximumExclusive) >= 0) {
    throw new LicensingError(
      'unsupported-version',
      `This installation requires a version from ${minimum} up to but not including ${maximumExclusive}.`,
      426,
    )
  }
}

export class LicensingService {
  private readonly now: () => Date
  private readonly random: (bytes: number) => Buffer
  private readonly uuid: () => string

  constructor(private readonly deps: LicensingServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.random = deps.random ?? randomBytes
    this.uuid = deps.uuid ?? randomUUID
  }

  private actorPseudonym(subject: string): string {
    return pseudonym(this.deps.config.auditHmacKey, 'actor', subject)
  }

  private async enforceRateLimit(subject: string, action: string, limit: number, windowMs: number): Promise<void> {
    const now = this.now()
    const subjectPseudonym = pseudonym(this.deps.config.rateLimitHmacKey, action, subject)
    const result = await this.deps.repository.consumeRateLimit(
      subjectPseudonym,
      action,
      limit,
      windowMs,
      now,
    )
    if (!result.allowed) {
      throw new LicensingError(
        'rate-limited',
        'Too many attempts. Wait before trying again.',
        429,
        true,
        result.retryAfterSeconds,
      )
    }
  }

  async createChallenge(body: unknown, remoteSubject: string): Promise<ChallengeResponse> {
    await this.enforceRateLimit(remoteSubject, 'challenge', 30, 5 * 60 * 1_000)
    const object = requireObject(body)
    const installationPublicKey = requiredString(object, 'installationPublicKey', 40, 256)
    const purpose = object.purpose
    if (purpose !== 'activation' && purpose !== 'refresh') {
      throw new LicensingError('invalid-request', 'purpose must be activation or refresh.', 400)
    }
    const parsed: ChallengeRequest = { installationPublicKey, purpose }
    const thumbprint = installationThumbprint(parsed.installationPublicKey)
    const now = this.now()
    const challenge = base64url(this.random(32))
    const id = this.uuid()
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS)
    await this.deps.repository.createChallenge({
      id,
      digest: hmacDigest(this.deps.config.codeHmacKey, 'challenge', challenge),
      installationKeyThumbprint: thumbprint,
      purpose: parsed.purpose,
      expiresAt,
    })
    return { challengeId: id, challenge, expiresAt: expiresAt.toISOString(), serverTime: now.toISOString() }
  }

  private parseProof(body: unknown): {
    object: Record<string, unknown>
    challengeId: string
    challenge: string
    challengeSignature: string
    installationPublicKey: string
    appVersion: string
    thumbprint: string
  } {
    const object = requireObject(body)
    const challengeId = requiredString(object, 'challengeId', 36, 36)
    const challenge = requiredString(object, 'challenge', 43, 43)
    const challengeSignature = requiredString(object, 'challengeSignature', 86, 86)
    const installationPublicKey = requiredString(object, 'installationPublicKey', 40, 256)
    const appVersion = requiredString(object, 'appVersion', 5, 64)
    assertSupportedVersion(
      appVersion,
      this.deps.config.minimumVersion,
      this.deps.config.maximumVersionExclusive,
    )
    const thumbprint = installationThumbprint(installationPublicKey)
    verifyChallengeSignature(installationPublicKey, challenge, challengeSignature)
    return { object, challengeId, challenge, challengeSignature, installationPublicKey, appVersion, thumbprint }
  }

  async redeem(body: unknown, remoteSubject: string): Promise<EntitlementResponse> {
    await this.enforceRateLimit(remoteSubject, 'redeem', 10, 15 * 60 * 1_000)
    const proof = this.parseProof(body)
    const code = requiredString(proof.object, 'code', 32, 80)
    const parsed: RedeemRequest = {
      code,
      challengeId: proof.challengeId,
      challenge: proof.challenge,
      challengeSignature: proof.challengeSignature,
      installationPublicKey: proof.installationPublicKey,
      appVersion: proof.appVersion,
    }
    const now = this.now()
    const normalizedCode = normalizeCode(parsed.code)
    const record = await this.deps.repository.redeemCode({
      challenge: {
        id: parsed.challengeId,
        digest: hmacDigest(this.deps.config.codeHmacKey, 'challenge', parsed.challenge),
        installationKeyThumbprint: proof.thumbprint,
        purpose: 'activation',
        now,
      },
      codeDigest: hmacDigest(this.deps.config.codeHmacKey, 'code', normalizedCode),
      entitlementId: this.uuid(),
      installationHistoryId: this.uuid(),
      tierDurationsMs: TIER_DURATION_MS,
      minimumVersion: this.deps.config.minimumVersion,
      maximumVersionExclusive: this.deps.config.maximumVersionExclusive,
      actorPseudonym: this.actorPseudonym(remoteSubject),
    })
    return this.createEntitlementResponse(record, now)
  }

  async refresh(body: unknown, remoteSubject: string): Promise<EntitlementResponse> {
    await this.enforceRateLimit(remoteSubject, 'refresh', 30, 15 * 60 * 1_000)
    const proof = this.parseProof(body)
    const currentEntitlement = requiredString(proof.object, 'currentEntitlement', 100, 8_192)
    const parsed: RefreshRequest = {
      currentEntitlement,
      challengeId: proof.challengeId,
      challenge: proof.challenge,
      challengeSignature: proof.challengeSignature,
      installationPublicKey: proof.installationPublicKey,
      appVersion: proof.appVersion,
    }
    const claims = verifyCompactJws(
      parsed.currentEntitlement,
      this.deps.config.signingPublicKey,
      this.deps.config.signingKeyId,
    )
    if (
      claims.schemaVersion !== LICENSING_SCHEMA_VERSION ||
      claims.iss !== this.deps.config.issuer ||
      claims.aud !== LICENSING_AUDIENCE ||
      claims.installationKeyThumbprint !== proof.thumbprint
    ) {
      throw new LicensingError('invalid-proof', 'Entitlement does not match this service or installation.', 401)
    }
    const now = this.now()
    const record = await this.deps.repository.refreshEntitlement({
      challenge: {
        id: parsed.challengeId,
        digest: hmacDigest(this.deps.config.codeHmacKey, 'challenge', parsed.challenge),
        installationKeyThumbprint: proof.thumbprint,
        purpose: 'refresh',
        now,
      },
      entitlementId: claims.sub,
      actorPseudonym: this.actorPseudonym(remoteSubject),
    })
    assertSupportedVersion(proof.appVersion, record.minimumVersion, record.maximumVersionExclusive)
    return this.createEntitlementResponse(record, now)
  }

  private createEntitlementResponse(record: EntitlementRecord, now: Date): EntitlementResponse {
    if (record.status !== 'active' || !record.installationKeyThumbprint) {
      throw new LicensingError('revoked', 'This entitlement is no longer active.', 403)
    }
    const offlineUntil = new Date(Math.min(record.expiresAt.getTime(), now.getTime() + OFFLINE_LEASE_MS))
    const toSeconds = (date: Date): number => Math.floor(date.getTime() / 1_000)
    const claims: EntitlementClaims = {
      schemaVersion: LICENSING_SCHEMA_VERSION,
      iss: this.deps.config.issuer,
      aud: LICENSING_AUDIENCE,
      sub: record.id,
      jti: this.uuid(),
      iat: toSeconds(now),
      nbf: toSeconds(now),
      exp: toSeconds(record.expiresAt),
      activatedAt: toSeconds(record.activatedAt),
      offlineUntil: toSeconds(offlineUntil),
      serial: record.leaseSerial,
      tier: record.tier,
      installationKeyThumbprint: record.installationKeyThumbprint,
      features: ENTITLEMENT_FEATURES,
      maxStudentsPerClass: 40,
      maxConcurrentClasses: 1,
      minimumVersion: record.minimumVersion,
      maximumVersionExclusive: record.maximumVersionExclusive,
    }
    return {
      entitlement: signCompactJws(claims, this.deps.config.signingPrivateKey, this.deps.config.signingKeyId),
      serverTime: now.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
      offlineUntil: offlineUntil.toISOString(),
    }
  }

  health(): HealthResponse {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      revision: this.deps.config.revision,
      schemaVersion: LICENSING_SCHEMA_VERSION,
      signingKeyId: this.deps.config.signingKeyId,
      issuer: this.deps.config.issuer,
      publicKeyThumbprint: createHash('sha256')
        .update(this.deps.config.signingPublicKey.export({ format: 'der', type: 'spki' }))
        .digest('base64url'),
      serverTime: this.now().toISOString(),
    }
  }
}

export function challengeDigestForTest(secret: Uint8Array, challenge: string): Buffer {
  return hmacDigest(secret, 'challenge', challenge)
}

export function opaquePayloadDigest(value: string): string {
  return base64url(createHash('sha256').update(value, 'utf8').digest())
}
