import { LicensingError } from '../contracts.js'
import type {
  ChallengeInput,
  ChallengeUse,
  CodeRecord,
  EntitlementRecord,
  IssueCodeInput,
  LicensingRepository,
  RedeemCodeInput,
  RefreshInput,
} from '../repository.js'

function key(buffer: Buffer): string {
  return buffer.toString('hex')
}

export class MemoryLicensingRepository implements LicensingRepository {
  readonly challenges = new Map<string, ChallengeInput & { consumedAt: Date | null }>()
  readonly codes = new Map<string, CodeRecord>()
  readonly entitlements = new Map<string, EntitlementRecord>()
  readonly installationHistory = new Set<string>()
  readonly rateLimitSubjects = new Set<string>()
  private queue: Promise<void> = Promise.resolve()

  private async exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const prior = this.queue
    let release!: () => void
    this.queue = new Promise<void>((resolve) => { release = resolve })
    await prior
    try {
      return await work()
    } finally {
      release()
    }
  }

  async createChallenge(input: ChallengeInput): Promise<void> {
    this.challenges.set(input.id, { ...input, digest: Buffer.from(input.digest), consumedAt: null })
  }

  async issueCode(input: IssueCodeInput): Promise<CodeRecord> {
    const digest = key(input.digest)
    if (this.codes.has(digest)) throw Object.assign(new Error('duplicate'), { code: '23505' })
    const record: CodeRecord = {
      id: input.id,
      tier: input.tier,
      status: 'issued',
      entitlementId: null,
      replacementForEntitlementId: input.replacementForEntitlementId ?? null,
      unusedExpiresAt: input.unusedExpiresAt,
      createdAt: input.now,
      consumedAt: null,
    }
    this.codes.set(digest, record)
    return record
  }

  private consumeChallenge(input: ChallengeUse): void {
    const challenge = this.challenges.get(input.id)
    if (
      !challenge || challenge.consumedAt || challenge.expiresAt <= input.now ||
      !challenge.digest.equals(input.digest) ||
      challenge.installationKeyThumbprint !== input.installationKeyThumbprint ||
      challenge.purpose !== input.purpose
    ) throw new LicensingError('invalid-proof', 'Challenge is invalid, expired, or already used.', 401)
    challenge.consumedAt = input.now
  }

  async redeemCode(input: RedeemCodeInput): Promise<EntitlementRecord> {
    return this.exclusive(() => {
      this.consumeChallenge(input.challenge)
      const code = this.codes.get(key(input.codeDigest))
      if (!code) throw new LicensingError('code-unavailable', 'The code is invalid, expired, or already used.', 409)
      if (code.status === 'consumed' && code.entitlementId) {
        const existing = this.entitlements.get(code.entitlementId)
        if (
          existing?.status === 'active' &&
          existing.installationKeyThumbprint === input.challenge.installationKeyThumbprint &&
          existing.expiresAt > input.challenge.now
        ) {
          existing.leaseSerial += 1
          return { ...existing }
        }
        throw new LicensingError('code-unavailable', 'The code is invalid, expired, or already used.', 409)
      }
      if (code.status !== 'issued' || code.unusedExpiresAt <= input.challenge.now) {
        code.status = code.status === 'issued' ? 'expired' : code.status
        throw new LicensingError('code-unavailable', 'The code is invalid, expired, or already used.', 409)
      }
      if (this.installationHistory.has(input.challenge.installationKeyThumbprint)) {
        throw new LicensingError('code-unavailable', 'The code is invalid, expired, or already used.', 409)
      }
      let entitlement: EntitlementRecord
      if (code.replacementForEntitlementId) {
        const current = this.entitlements.get(code.replacementForEntitlementId)
        if (!current || current.status !== 'replacement_pending' || current.expiresAt <= input.challenge.now) {
          throw new LicensingError('code-unavailable', 'The code is invalid, expired, or already used.', 409)
        }
        current.status = 'active'
        current.installationKeyThumbprint = input.challenge.installationKeyThumbprint
        current.leaseSerial += 1
        entitlement = current
      } else {
        entitlement = {
          id: input.entitlementId,
          tier: code.tier,
          status: 'active',
          installationKeyThumbprint: input.challenge.installationKeyThumbprint,
          activatedAt: input.challenge.now,
          expiresAt: new Date(input.challenge.now.getTime() + input.tierDurationsMs[code.tier]),
          leaseSerial: 1,
          replacementCount: 0,
          minimumVersion: input.minimumVersion,
          maximumVersionExclusive: input.maximumVersionExclusive,
        }
        this.entitlements.set(entitlement.id, entitlement)
      }
      this.installationHistory.add(input.challenge.installationKeyThumbprint)
      code.status = 'consumed'
      code.entitlementId = entitlement.id
      code.consumedAt = input.challenge.now
      return { ...entitlement }
    })
  }

  async refreshEntitlement(input: RefreshInput): Promise<EntitlementRecord> {
    return this.exclusive(() => {
      this.consumeChallenge(input.challenge)
      const entitlement = this.entitlements.get(input.entitlementId)
      if (!entitlement || entitlement.installationKeyThumbprint !== input.challenge.installationKeyThumbprint) {
        throw new LicensingError('invalid-proof', 'Entitlement does not match this installation.', 401)
      }
      if (entitlement.status !== 'active') throw new LicensingError('revoked', 'Entitlement is inactive.', 403)
      if (entitlement.expiresAt <= input.challenge.now) throw new LicensingError('expired', 'Entitlement expired.', 403)
      entitlement.leaseSerial += 1
      return { ...entitlement }
    })
  }

  async consumeRateLimit(subjectPseudonym: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    this.rateLimitSubjects.add(subjectPseudonym)
    return { allowed: true, retryAfterSeconds: 0 }
  }

  async getCodeByDigest(digest: Buffer): Promise<CodeRecord | null> {
    return this.codes.get(key(digest)) ?? null
  }

  async getEntitlement(id: string): Promise<EntitlementRecord | null> {
    return this.entitlements.get(id) ?? null
  }

  async revokeEntitlement(id: string): Promise<EntitlementRecord> {
    const record = this.entitlements.get(id)
    if (!record) throw new LicensingError('not-found', 'Not found.', 404)
    record.status = 'revoked'
    record.installationKeyThumbprint = null
    return record
  }

  async replaceEntitlement(
    id: string,
    code: Omit<IssueCodeInput, 'replacementForEntitlementId'>,
    _reason: string,
  ): Promise<{ entitlement: EntitlementRecord; code: CodeRecord }> {
    const record = this.entitlements.get(id)
    if (!record || record.replacementCount >= 1) throw new LicensingError('replacement-unavailable', 'Unavailable.', 409)
    record.status = 'replacement_pending'
    record.installationKeyThumbprint = null
    record.replacementCount += 1
    const issued = await this.issueCode({ ...code, replacementForEntitlementId: id })
    return { entitlement: record, code: issued }
  }

  async promoteEntitlement(
    id: string,
    tier: 'agency_classroom_pilot',
    _actorPseudonym: string,
    now: Date,
    durationMs: number,
  ): Promise<EntitlementRecord> {
    const record = this.entitlements.get(id)
    if (!record || record.tier !== 'selected_evaluator_demo') {
      throw new LicensingError('promotion-unavailable', 'Unavailable.', 409)
    }
    record.tier = tier
    record.activatedAt = now
    record.expiresAt = new Date(now.getTime() + durationMs)
    record.leaseSerial += 1
    return record
  }
}
