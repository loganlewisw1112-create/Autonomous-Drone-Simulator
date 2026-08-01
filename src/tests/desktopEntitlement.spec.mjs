import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EntitlementManager,
  installationKeyThumbprint,
  verifyEntitlementJws,
} from '../../desktop/licensing/entitlement.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function encoded(value) {
  return Buffer.from(value).toString('base64url')
}

function signedEntitlement(privateKey, claims, kid = 'test-key') {
  const header = encoded(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }))
  const payload = encoded(JSON.stringify(claims))
  const signature = sign(null, Buffer.from(`${header}.${payload}`, 'ascii'), privateKey).toString('base64url')
  return `${header}.${payload}.${signature}`
}

function fakeSafeStorage(identity) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`${identity}:${value}`, 'utf8'),
    decryptString: (value) => {
      const clear = Buffer.from(value).toString('utf8')
      if (!clear.startsWith(`${identity}:`)) throw new Error('wrong-windows-account')
      return clear.slice(identity.length + 1)
    },
  }
}

async function createHarness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adms-entitlement-'))
  temporaryDirectories.push(directory)
  const serviceKeys = generateKeyPairSync('ed25519')
  const spki = serviceKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  let now = Date.parse('2026-08-01T12:00:00.000Z')
  let activationPublicKey = null
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body)
    if (url.endsWith('/v1/challenges')) {
      activationPublicKey = body.installationPublicKey
      return Response.json({
        challengeId: 'challenge-1',
        challenge: 'signed-once-challenge',
        expiresAt: new Date(now + 300_000).toISOString(),
        serverTime: new Date(now).toISOString(),
      }, { status: 201 })
    }
    const nowSeconds = Math.floor(now / 1_000)
    const entitlement = signedEntitlement(serviceKeys.privateKey, {
      schemaVersion: 1,
      iss: 'https://publisher.example',
      aud: 'adms-windows-classroom',
      sub: 'licence-12345678',
      jti: `lease-${nowSeconds}`,
      iat: nowSeconds,
      nbf: nowSeconds - 1,
      exp: nowSeconds + 14 * 86_400,
      activatedAt: nowSeconds,
      offlineUntil: nowSeconds + 72 * 3_600,
      serial: 1,
      tier: 'selected_evaluator_demo',
      installationKeyThumbprint: installationKeyThumbprint(activationPublicKey),
      features: ['simulator', 'custom-missions', 'classroom-host', 'replay', 'export'],
      maxStudentsPerClass: 40,
      maxConcurrentClasses: 1,
      minimumVersion: '1.1.0',
      maximumVersionExclusive: '1.2.0',
    })
    return Response.json({
      entitlement,
      serverTime: new Date(now).toISOString(),
      expiresAt: new Date((nowSeconds + 14 * 86_400) * 1_000).toISOString(),
      offlineUntil: new Date((nowSeconds + 72 * 3_600) * 1_000).toISOString(),
    })
  }
  const config = {
    apiUrl: 'https://licensing.example',
    issuer: 'https://publisher.example',
    audience: 'adms-windows-classroom',
    publicKeys: { 'test-key': spki },
    configured: true,
  }
  return {
    directory,
    config,
    fetchImpl,
    get now() { return now },
    set now(value) { now = value },
  }
}

describe('desktop evaluator entitlement', () => {
  it('activates once, survives a new renderer/session, and enforces the 72-hour offline lease', async () => {
    const harness = await createHarness()
    const manager = new EntitlementManager({
      safeStorage: fakeSafeStorage('teacher-a'),
      userDataPath: harness.directory,
      config: harness.config,
      appVersion: '1.1.0',
      fetchImpl: harness.fetchImpl,
      now: () => harness.now,
    })
    expect((await manager.initialize()).status).toBe('activation_required')
    const activated = await manager.activate('ADMS-0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ')
    expect(activated.ok).toBe(true)
    expect(manager.getState()).toMatchObject({ status: 'active', maxStudentsPerClass: 40, maxConcurrentClasses: 1 })

    const relaunched = new EntitlementManager({
      safeStorage: fakeSafeStorage('teacher-a'),
      userDataPath: harness.directory,
      config: harness.config,
      appVersion: '1.1.0',
      fetchImpl: harness.fetchImpl,
      now: () => harness.now,
    })
    expect((await relaunched.initialize()).status).toBe('active')
    harness.now += 72 * 60 * 60 * 1_000
    expect((await relaunched.reevaluate()).status).toBe('verification_required')
  })

  it('fails closed when protected state is copied to another Windows identity', async () => {
    const harness = await createHarness()
    const original = new EntitlementManager({
      safeStorage: fakeSafeStorage('teacher-a'),
      userDataPath: harness.directory,
      config: harness.config,
      appVersion: '1.1.0',
      fetchImpl: harness.fetchImpl,
      now: () => harness.now,
    })
    await original.initialize()
    const copied = new EntitlementManager({
      safeStorage: fakeSafeStorage('teacher-b'),
      userDataPath: harness.directory,
      config: harness.config,
      appVersion: '1.1.0',
      fetchImpl: harness.fetchImpl,
      now: () => harness.now,
    })
    expect(await copied.initialize()).toMatchObject({ status: 'corrupt', canBeginNewActivity: false })
  })

  it('detects a clock rollback greater than five minutes', async () => {
    const harness = await createHarness()
    const manager = new EntitlementManager({
      safeStorage: fakeSafeStorage('teacher-a'),
      userDataPath: harness.directory,
      config: harness.config,
      appVersion: '1.1.0',
      fetchImpl: harness.fetchImpl,
      now: () => harness.now,
    })
    await manager.initialize()
    await manager.activate('ADMS-0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ')
    harness.now += 60 * 60 * 1_000
    await manager.reevaluate(true)
    harness.now -= 30 * 60 * 1_000
    expect((await manager.reevaluate()).status).toBe('clock_anomaly')
  })

  it('rejects a compact JWS whose signed payload was modified', async () => {
    const harness = await createHarness()
    const serviceKeys = generateKeyPairSync('ed25519')
    const spki = serviceKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    const compact = signedEntitlement(serviceKeys.privateKey, { schemaVersion: 1 }, 'test-key')
    const [header, payload, signature] = compact.split('.')
    const tamperedPayload = encoded(JSON.stringify({ schemaVersion: 1, tier: 'agency_classroom_pilot' }))
    expect(() => verifyEntitlementJws(`${header}.${tamperedPayload}.${signature}`, {
      issuer: 'https://publisher.example',
      audience: 'adms-windows-classroom',
      publicKeys: { 'test-key': spki },
      appVersion: '1.1.0',
    })).toThrow('invalid-entitlement-signature')
    expect(payload).not.toBe(tamperedPayload)
    expect(harness.directory).toBeTruthy()
  })
})
