import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TIER_DURATION_MS } from '../contracts.js'
import { PostgresLicensingRepository } from '../repository.js'
import { purgeLicensingRetention } from '../retention.js'

const databaseUrl = process.env.LICENSING_TEST_DATABASE_URL?.trim()
const schema = `licensing_test_${process.pid}_${Date.now()}`
let adminPool: Pool
let pool: Pool
let repository: PostgresLicensingRepository

describe.skipIf(!databaseUrl)('PostgreSQL licensing transactions', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema}` })
    const migration = await readFile(resolve(import.meta.dirname, '../../migrations/001_initial.sql'), 'utf8')
    await pool.query(migration)
    repository = new PostgresLicensingRepository(pool)
  })

  afterAll(async () => {
    await pool?.end()
    await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool?.end()
  })

  it('atomically permits one installation across concurrent redemptions', async () => {
    const now = new Date('2026-08-01T12:00:00.000Z')
    const codeDigest = randomBytes(32)
    await repository.issueCode({
      id: randomUUID(),
      digest: codeDigest,
      tier: 'selected_evaluator_demo',
      recipientRefHash: 'recipient-test',
      unusedExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      actorPseudonym: 'publisher-test',
      now,
    })

    const attempts = await Promise.allSettled(Array.from({ length: 12 }, async (_, index) => {
      const challengeId = randomUUID()
      const challengeDigest = randomBytes(32)
      const thumbprint = `installation-${index}`
      await repository.createChallenge({
        id: challengeId,
        digest: challengeDigest,
        installationKeyThumbprint: thumbprint,
        purpose: 'activation',
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      })
      return repository.redeemCode({
        challenge: {
          id: challengeId,
          digest: challengeDigest,
          installationKeyThumbprint: thumbprint,
          purpose: 'activation',
          now,
        },
        codeDigest,
        entitlementId: randomUUID(),
        installationHistoryId: randomUUID(),
        tierDurationsMs: TIER_DURATION_MS,
        minimumVersion: '1.1.0',
        maximumVersionExclusive: '1.2.0',
        actorPseudonym: 'activation-test',
      })
    }))

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(11)
    const winner = attempts.find((attempt) => attempt.status === 'fulfilled')
    expect(winner?.status === 'fulfilled' ? winner.value.tier : null).toBe('selected_evaluator_demo')
  })

  it('returns the same entitlement for a committed same-installation retry', async () => {
    const now = new Date('2026-08-02T12:00:00.000Z')
    const codeDigest = randomBytes(32)
    const thumbprint = 'retry-installation'
    await repository.issueCode({
      id: randomUUID(),
      digest: codeDigest,
      tier: 'selected_evaluator_demo',
      recipientRefHash: 'recipient-retry',
      unusedExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      actorPseudonym: 'publisher-test',
      now,
    })

    const redeem = async (challengeNow: Date) => {
      const challengeId = randomUUID()
      const challengeDigest = randomBytes(32)
      await repository.createChallenge({
        id: challengeId,
        digest: challengeDigest,
        installationKeyThumbprint: thumbprint,
        purpose: 'activation',
        expiresAt: new Date(challengeNow.getTime() + 5 * 60_000),
      })
      return repository.redeemCode({
        challenge: {
          id: challengeId,
          digest: challengeDigest,
          installationKeyThumbprint: thumbprint,
          purpose: 'activation',
          now: challengeNow,
        },
        codeDigest,
        entitlementId: randomUUID(),
        installationHistoryId: randomUUID(),
        tierDurationsMs: TIER_DURATION_MS,
        minimumVersion: '1.1.0',
        maximumVersionExclusive: '1.2.0',
        actorPseudonym: 'activation-test',
      })
    }

    const first = await redeem(now)
    const retry = await redeem(new Date(now.getTime() + 1_000))
    expect(retry.id).toBe(first.id)
    expect(retry.activatedAt.toISOString()).toBe(first.activatedAt.toISOString())
    expect(retry.expiresAt.toISOString()).toBe(first.expiresAt.toISOString())
    expect(retry.leaseSerial).toBe(first.leaseSerial + 1)
  })

  it('purges limits immediately and licensing records only after the 90-day boundary', async () => {
    const activatedAt = new Date('2025-01-01T00:00:00.000Z')
    const codeDigest = randomBytes(32)
    const challengeDigest = randomBytes(32)
    const challengeId = randomUUID()
    await repository.issueCode({
      id: randomUUID(),
      digest: codeDigest,
      tier: 'selected_evaluator_demo',
      recipientRefHash: 'recipient-retention',
      unusedExpiresAt: new Date(activatedAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
      actorPseudonym: 'publisher-test',
      now: activatedAt,
    })
    await repository.createChallenge({
      id: challengeId,
      digest: challengeDigest,
      installationKeyThumbprint: 'retention-installation',
      purpose: 'activation',
      expiresAt: new Date(activatedAt.getTime() + 5 * 60_000),
    })
    const entitlement = await repository.redeemCode({
      challenge: {
        id: challengeId,
        digest: challengeDigest,
        installationKeyThumbprint: 'retention-installation',
        purpose: 'activation',
        now: activatedAt,
      },
      codeDigest,
      entitlementId: randomUUID(),
      installationHistoryId: randomUUID(),
      tierDurationsMs: TIER_DURATION_MS,
      minimumVersion: '1.1.0',
      maximumVersionExclusive: '1.2.0',
      actorPseudonym: 'activation-test',
    })
    await repository.consumeRateLimit('retention-subject', 'redeem', 10, 60_000, activatedAt)

    const beforeCutoff = await purgeLicensingRetention(
      pool,
      new Date(entitlement.expiresAt.getTime() + 90 * 24 * 60 * 60 * 1_000 - 1),
    )
    expect(beforeCutoff.entitlements).toBe(0)
    expect(beforeCutoff.rateLimits).toBe(1)
    expect(await repository.getEntitlement(entitlement.id)).not.toBeNull()

    const afterCutoff = await purgeLicensingRetention(
      pool,
      new Date(entitlement.expiresAt.getTime() + 90 * 24 * 60 * 60 * 1_000),
    )
    expect(afterCutoff.entitlements).toBe(1)
    expect(afterCutoff.installationHistory).toBe(1)
    expect(afterCutoff.codes).toBeGreaterThanOrEqual(1)
    expect(await repository.getEntitlement(entitlement.id)).toBeNull()
  })
})
