import { generateKeyPairSync, sign } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { LicensingConfig } from '../config.js'
import { TIER_DURATION_MS, UNUSED_CODE_TTL_MS, type EntitlementTier } from '../contracts.js'
import {
  base64url,
  generateRedemptionCode,
  hmacDigest,
  installationThumbprint,
  verifyCompactJws,
} from '../crypto.js'
import { LicensingService } from '../service.js'
import { MemoryLicensingRepository } from './memoryRepository.js'

const signingKeys = generateKeyPairSync('ed25519')
const codeHmacKey = Buffer.alloc(32, 1)
const rateLimitHmacKey = Buffer.alloc(32, 2)
const auditHmacKey = Buffer.alloc(32, 3)

const config: LicensingConfig = {
  databaseUrl: 'postgresql://not-used',
  codeHmacKey,
  rateLimitHmacKey,
  auditHmacKey,
  signingPrivateKey: signingKeys.privateKey,
  signingPublicKey: signingKeys.publicKey,
  signingKeyId: 'test-key-1',
  issuer: 'https://licensing.test',
  minimumVersion: '1.1.0',
  maximumVersionExclusive: '1.2.0',
  revision: 'test-sha',
}

function installation() {
  const pair = generateKeyPairSync('ed25519')
  const publicKey = base64url(pair.publicKey.export({ format: 'der', type: 'spki' }))
  return { ...pair, publicKey, thumbprint: installationThumbprint(publicKey) }
}

describe('licensing service', () => {
  let repository: MemoryLicensingRepository
  let now: Date
  let service: LicensingService

  beforeEach(() => {
    repository = new MemoryLicensingRepository()
    now = new Date('2026-08-01T12:00:00.000Z')
    service = new LicensingService({ repository, config, now: () => new Date(now) })
  })

  async function issue(tier: EntitlementTier, code = generateRedemptionCode()): Promise<string> {
    await repository.issueCode({
      id: crypto.randomUUID(),
      digest: hmacDigest(codeHmacKey, 'code', code),
      tier,
      recipientRefHash: 'pseudonym-only',
      unusedExpiresAt: new Date(now.getTime() + UNUSED_CODE_TTL_MS),
      actorPseudonym: 'publisher-pseudonym',
      now,
    })
    return code
  }

  async function challengeFor(
    install: ReturnType<typeof installation>,
    purpose: 'activation' | 'refresh',
  ) {
    const challenge = await service.createChallenge(
      { installationPublicKey: install.publicKey, purpose },
      '192.0.2.10',
    )
    return {
      ...challenge,
      installationPublicKey: install.publicKey,
      challengeSignature: base64url(sign(null, Buffer.from(challenge.challenge, 'utf8'), install.privateKey)),
      appVersion: '1.1.0',
    }
  }

  async function activate(code: string, install = installation()) {
    const proof = await challengeFor(install, 'activation')
    const response = await service.redeem({ ...proof, code }, '192.0.2.10')
    return { response, claims: verifyCompactJws(response.entitlement, signingKeys.publicKey, 'test-key-1'), install }
  }

  it.each([
    ['selected_evaluator_demo', 14],
    ['agency_classroom_pilot', 90],
  ] as const)('starts the %s term at first successful activation', async (tier, days) => {
    const code = await issue(tier)
    const { response, claims } = await activate(code)
    expect(claims.tier).toBe(tier)
    expect(claims.exp - claims.activatedAt).toBe(days * 24 * 60 * 60)
    expect(claims.offlineUntil - claims.iat).toBe(72 * 60 * 60)
    expect(claims.maxStudentsPerClass).toBe(40)
    expect(claims.maxConcurrentClasses).toBe(1)
    expect(response.serverTime).toBe(now.toISOString())
  })

  it('admits exactly one installation under simultaneous redemption', async () => {
    const code = await issue('selected_evaluator_demo')
    const first = installation()
    const second = installation()
    const firstProof = await challengeFor(first, 'activation')
    const secondProof = await challengeFor(second, 'activation')
    const attempts = await Promise.allSettled([
      service.redeem({ ...firstProof, code }, '192.0.2.11'),
      service.redeem({ ...secondProof, code }, '192.0.2.12'),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    const rejected = attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'code-unavailable' })
  })

  it('makes a lost-response retry idempotent for the same installation and licence', async () => {
    const code = await issue('selected_evaluator_demo')
    const install = installation()
    const first = await activate(code, install)
    const second = await activate(code, install)
    expect(second.claims.sub).toBe(first.claims.sub)
    expect(second.claims.serial).toBe(first.claims.serial + 1)
    expect(second.claims.exp).toBe(first.claims.exp)
  })

  it('prevents a previously activated installation from stacking another code', async () => {
    const firstCode = await issue('selected_evaluator_demo')
    const secondCode = await issue('selected_evaluator_demo')
    const install = installation()
    await activate(firstCode, install)
    await expect(activate(secondCode, install)).rejects.toMatchObject({ code: 'code-unavailable' })
  })

  it('refreshes only with a new single-use proof and rolls the lease 72 hours', async () => {
    const activated = await activate(await issue('selected_evaluator_demo'))
    now = new Date(now.getTime() + 24 * 60 * 60 * 1_000)
    const proof = await challengeFor(activated.install, 'refresh')
    const refreshed = await service.refresh(
      { ...proof, currentEntitlement: activated.response.entitlement },
      '192.0.2.10',
    )
    const claims = verifyCompactJws(refreshed.entitlement, signingKeys.publicKey, 'test-key-1')
    expect(claims.serial).toBe(activated.claims.serial + 1)
    expect(claims.offlineUntil - claims.iat).toBe(72 * 60 * 60)
    await expect(service.refresh(
      { ...proof, currentEntitlement: refreshed.entitlement },
      '192.0.2.10',
    )).rejects.toMatchObject({ code: 'invalid-proof' })
  })

  it('does not store plaintext redemption codes or raw rate-limit subjects', async () => {
    const code = await issue('selected_evaluator_demo')
    await service.createChallenge(
      { installationPublicKey: installation().publicKey, purpose: 'activation' },
      '198.51.100.77',
    )
    expect(JSON.stringify([...repository.codes.entries()])).not.toContain(code)
    expect([...repository.rateLimitSubjects]).not.toContain('198.51.100.77')
  })

  it('rejects unused codes after their 30-day issuance window', async () => {
    const code = await issue('selected_evaluator_demo')
    now = new Date(now.getTime() + UNUSED_CODE_TTL_MS + 1)
    await expect(activate(code)).rejects.toMatchObject({ code: 'code-unavailable' })
  })

  it('rejects unsupported application versions before consuming the challenge', async () => {
    const install = installation()
    const proof = await challengeFor(install, 'activation')
    await expect(service.redeem(
      { ...proof, code: await issue('selected_evaluator_demo'), appVersion: '1.2.0' },
      '192.0.2.10',
    )).rejects.toMatchObject({ code: 'unsupported-version' })
  })

  it('reports revision, schema, key and trusted UTC time from health', () => {
    expect(service.health()).toEqual({
      status: 'ok',
      service: 'adms-licensing',
      revision: 'test-sha',
      schemaVersion: 1,
      signingKeyId: 'test-key-1',
      serverTime: now.toISOString(),
    })
  })

  it('uses the exact configured duration constants', () => {
    expect(TIER_DURATION_MS.selected_evaluator_demo).toBe(14 * 86_400_000)
    expect(TIER_DURATION_MS.agency_classroom_pilot).toBe(90 * 86_400_000)
  })
})
