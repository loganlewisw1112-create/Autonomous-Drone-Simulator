import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EntitlementManager } from '../../../../desktop/licensing/entitlement.mjs'
import { UNUSED_CODE_TTL_MS } from '../contracts.js'
import { base64url, generateRedemptionCode, hmacDigest } from '../crypto.js'
import { LicensingError } from '../contracts.js'
import { LicensingService } from '../service.js'
import { MemoryLicensingRepository } from './memoryRepository.js'

const temporaryDirectories = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`windows-user:${value}`, 'utf8'),
  decryptString: (value) => Buffer.from(value).toString('utf8').replace(/^windows-user:/, ''),
}

describe('licensing service and Electron contract', () => {
  it('activates and refreshes the exact desktop protocol end to end', async () => {
    const repository = new MemoryLicensingRepository()
    const signing = generateKeyPairSync('ed25519')
    const codeHmacKey = Buffer.alloc(32, 11)
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const service = new LicensingService({
      repository,
      now: () => new Date(now),
      config: {
        databaseUrl: 'not-used',
        codeHmacKey,
        rateLimitHmacKey: Buffer.alloc(32, 12),
        auditHmacKey: Buffer.alloc(32, 13),
        signingPrivateKey: signing.privateKey,
        signingPublicKey: signing.publicKey,
        signingKeyId: 'contract-key',
        issuer: 'https://licensing.test',
        minimumVersion: '1.1.0',
        maximumVersionExclusive: '1.2.0',
        revision: 'contract-test',
      },
    })
    const code = generateRedemptionCode()
    await repository.issueCode({
      id: randomUUID(),
      digest: hmacDigest(codeHmacKey, 'code', code),
      tier: 'selected_evaluator_demo',
      recipientRefHash: 'recipient-test',
      unusedExpiresAt: new Date(now + UNUSED_CODE_TTL_MS),
      actorPseudonym: 'publisher-test',
      now: new Date(now),
    })

    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body)
      try {
        const payload = url.endsWith('/v1/challenges')
          ? await service.createChallenge(body, '198.51.100.1')
          : url.endsWith('/v1/activations/redeem')
            ? await service.redeem(body, '198.51.100.1')
            : await service.refresh(body, '198.51.100.1')
        return Response.json(payload, { status: url.endsWith('/v1/challenges') ? 201 : 200 })
      } catch (error) {
        const known = error instanceof LicensingError
          ? error
          : new LicensingError('service-unavailable', 'Unavailable.', 503, true)
        return Response.json({ error: {
          code: known.code,
          message: known.message,
          retryable: known.retryable,
          ...(known.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: known.retryAfterSeconds }),
        } }, { status: known.status })
      }
    }

    const directory = await mkdtemp(path.join(os.tmpdir(), 'adms-contract-'))
    temporaryDirectories.push(directory)
    const publicSpki = base64url(signing.publicKey.export({ format: 'der', type: 'spki' }))
    const manager = new EntitlementManager({
      safeStorage,
      userDataPath: directory,
      config: {
        apiUrl: 'https://licensing.test',
        issuer: 'https://licensing.test',
        audience: 'adms-windows-classroom',
        publicKeys: { 'contract-key': publicSpki },
        configured: true,
      },
      appVersion: '1.1.0',
      fetchImpl,
      now: () => now,
    })

    expect((await manager.initialize()).status).toBe('activation_required')
    expect((await manager.activate(code)).ok).toBe(true)
    expect(manager.getState()).toMatchObject({
      status: 'active',
      tier: 'selected_evaluator_demo',
      maxStudentsPerClass: 40,
      maxConcurrentClasses: 1,
    })

    now += 72 * 60 * 60 * 1_000
    expect((await manager.reevaluate()).status).toBe('verification_required')
    expect((await manager.refresh()).ok).toBe(true)
    expect(manager.getState().status).toBe('active')
  })
})
