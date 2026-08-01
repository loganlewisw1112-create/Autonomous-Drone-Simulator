import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const ENTITLEMENT_AUDIENCE = 'adms-windows-classroom'
export const OFFLINE_LEASE_MS = 72 * 60 * 60 * 1_000
export const DEBRIEF_MS = 15 * 60 * 1_000
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1_000
const PERSIST_CLOCK_INTERVAL_MS = 60_000
const REQUIRED_FEATURES = Object.freeze([
  'simulator',
  'custom-missions',
  'classroom-host',
  'replay',
  'export',
])

/** @typedef {'selected_evaluator_demo'|'agency_classroom_pilot'} EntitlementTier */
/** @typedef {'activation_required'|'active'|'warning'|'verification_required'|'clock_anomaly'|'debrief'|'expired'|'revoked'|'unsupported_version'|'corrupt'} EntitlementStatus */

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

function decodeBase64url(input) {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('invalid-base64url')
  return Buffer.from(input, 'base64url')
}

function finiteEpochSeconds(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid-claim-${field}`)
  return value
}

function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  return match ? match.slice(1, 4).map(Number) : null
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

export function installationKeyThumbprint(publicKeySpki) {
  return base64url(createHash('sha256').update(decodeBase64url(publicKeySpki)).digest())
}

export function normalizeEvaluatorCode(value) {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim().toUpperCase().replace(/[\s_]+/g, '-')
  if (normalized.length < 20 || normalized.length > 80) return null
  if (!/^ADMS-[0-9A-HJKMNP-TV-Z-]+$/.test(normalized)) return null
  return normalized
}

/**
 * Verify a compact Ed25519 JWS and return its entitlement claims.
 * @param {string} compact
 * @param {{issuer:string,audience:string,publicKeys:Record<string,string>,appVersion:string}} config
 */
export function verifyEntitlementJws(compact, config) {
  if (typeof compact !== 'string' || compact.length > 24_000) throw new Error('invalid-entitlement')
  const segments = compact.split('.')
  if (segments.length !== 3) throw new Error('invalid-entitlement')
  const [encodedHeader, encodedPayload, encodedSignature] = segments
  let header
  let claims
  try {
    header = JSON.parse(decodeBase64url(encodedHeader).toString('utf8'))
    claims = JSON.parse(decodeBase64url(encodedPayload).toString('utf8'))
  } catch {
    throw new Error('invalid-entitlement')
  }
  if (header?.alg !== 'EdDSA' || header?.typ !== 'JWT' || typeof header?.kid !== 'string') {
    throw new Error('invalid-entitlement-header')
  }
  const spki = config.publicKeys[header.kid]
  if (typeof spki !== 'string' || spki.length < 40) throw new Error('unknown-signing-key')
  const publicKey = createPublicKey({ key: decodeBase64url(spki), format: 'der', type: 'spki' })
  const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii')
  if (!verifyBytes(null, signed, publicKey, decodeBase64url(encodedSignature))) {
    throw new Error('invalid-entitlement-signature')
  }
  if (claims?.schemaVersion !== 1
    || claims?.iss !== config.issuer
    || claims?.aud !== config.audience
    || typeof claims?.sub !== 'string'
    || typeof claims?.jti !== 'string') throw new Error('invalid-entitlement-claims')
  const integerClaims = ['iat', 'nbf', 'exp', 'activatedAt', 'offlineUntil', 'serial']
  for (const field of integerClaims) finiteEpochSeconds(claims[field], field)
  if (claims.nbf > claims.exp || claims.activatedAt > claims.exp || claims.offlineUntil > claims.exp) {
    throw new Error('invalid-entitlement-time-range')
  }
  if (!['selected_evaluator_demo', 'agency_classroom_pilot'].includes(claims.tier)) {
    throw new Error('invalid-entitlement-tier')
  }
  if (typeof claims.installationKeyThumbprint !== 'string' || claims.installationKeyThumbprint.length < 20) {
    throw new Error('invalid-installation-binding')
  }
  if (!Array.isArray(claims.features)
    || REQUIRED_FEATURES.some((feature) => !claims.features.includes(feature))) {
    throw new Error('invalid-entitlement-features')
  }
  if (!Number.isSafeInteger(claims.maxStudentsPerClass)
    || claims.maxStudentsPerClass < 1
    || claims.maxStudentsPerClass > 40
    || claims.maxConcurrentClasses !== 1) throw new Error('invalid-entitlement-limits')
  if (typeof claims.minimumVersion !== 'string' || typeof claims.maximumVersionExclusive !== 'string') {
    throw new Error('invalid-entitlement-version-range')
  }
  const minimumComparison = compareVersions(config.appVersion, claims.minimumVersion)
  const maximumComparison = compareVersions(config.appVersion, claims.maximumVersionExclusive)
  claims.versionSupported = minimumComparison !== null
    && maximumComparison !== null
    && minimumComparison >= 0
    && maximumComparison < 0
  return claims
}

export function evaluateEntitlement(claims, protectedState, nowMs) {
  const nowSeconds = Math.floor(nowMs / 1_000)
  const highestWallClock = Number(protectedState?.highestWallClock) || 0
  if (nowMs + CLOCK_ROLLBACK_TOLERANCE_MS < highestWallClock) {
    return { status: 'clock_anomaly', remainingMs: 0, canBeginNewActivity: false }
  }
  if (claims.versionSupported !== true) {
    return { status: 'unsupported_version', remainingMs: 0, canBeginNewActivity: false }
  }
  const expiresAt = claims.exp * 1_000
  const offlineUntil = claims.offlineUntil * 1_000
  if (nowSeconds < claims.nbf) {
    return { status: 'clock_anomaly', remainingMs: 0, canBeginNewActivity: false }
  }
  if (nowMs >= expiresAt) {
    const debriefRemaining = expiresAt + DEBRIEF_MS - nowMs
    return debriefRemaining > 0
      ? { status: 'debrief', remainingMs: debriefRemaining, canBeginNewActivity: false }
      : { status: 'expired', remainingMs: 0, canBeginNewActivity: false }
  }
  if (nowMs >= offlineUntil) {
    return { status: 'verification_required', remainingMs: 0, canBeginNewActivity: false }
  }
  const remainingMs = Math.min(expiresAt, offlineUntil) - nowMs
  return {
    status: remainingMs <= 24 * 60 * 60 * 1_000 ? 'warning' : 'active',
    remainingMs,
    canBeginNewActivity: true,
  }
}

export function loadEntitlementConfig(environment = process.env) {
  const keyId = environment.LICENSING_JWS_KEY_ID?.trim()
  const publicKey = environment.LICENSING_JWS_PUBLIC_KEY_SPKI_BASE64?.trim()
  const apiUrl = environment.LICENSING_API_URL?.trim()
  const issuer = environment.LICENSING_ISSUER?.trim()
  let parsedApi = null
  try {
    parsedApi = apiUrl ? new URL(apiUrl) : null
  } catch { /* invalid production configuration fails closed below */ }
  let normalizedPublicKey = null
  try {
    if (publicKey) {
      const publicKeyDer = Buffer.from(publicKey, 'base64')
      if (createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519') {
        normalizedPublicKey = publicKeyDer.toString('base64url')
      }
    }
  } catch { /* invalid public key fails closed below */ }
  return {
    apiUrl: parsedApi?.protocol === 'https:' ? parsedApi.toString().replace(/\/$/, '') : null,
    issuer: issuer || null,
    audience: ENTITLEMENT_AUDIENCE,
    publicKeys: keyId && normalizedPublicKey ? { [keyId]: normalizedPublicKey } : {},
    configured: Boolean(parsedApi?.protocol === 'https:' && issuer && keyId && normalizedPublicKey),
  }
}

class LicensingServiceError extends Error {
  constructor(code, retryable = false, retryAfterSeconds = null) {
    super(code)
    this.code = code
    this.retryable = retryable
    this.retryAfterSeconds = retryAfterSeconds
  }
}

async function atomicWrite(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, value, { mode: 0o600 })
  await rename(temporary, filename)
}

async function readOptional(filename) {
  try {
    return await readFile(filename)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Electron-main-only entitlement owner. Electron dependencies are injected so the
 * cryptographic and clock behavior can be verified without starting a renderer.
 */
export class EntitlementManager {
  constructor({ safeStorage, userDataPath, config, appVersion, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.safeStorage = safeStorage
    this.directory = path.join(userDataPath, 'licensing')
    this.protectedPath = path.join(this.directory, 'installation-state.bin')
    this.entitlementPath = path.join(this.directory, 'entitlement.jws')
    this.config = { ...config, appVersion }
    this.appVersion = appVersion
    this.fetchImpl = fetchImpl
    this.now = now
    this.protectedState = null
    this.claims = null
    this.entitlement = null
    this.lastServiceReachableAt = null
    this.lastError = null
    this.current = this.makePublicState('activation_required')
    this.listeners = new Set()
    this.lastPersistedClock = 0
  }

  makePublicState(status, evaluation = null) {
    const claims = this.claims
    return Object.freeze({
      status,
      tier: claims?.tier ?? null,
      activatedAt: claims ? claims.activatedAt * 1_000 : null,
      expiresAt: claims ? claims.exp * 1_000 : null,
      offlineUntil: claims ? claims.offlineUntil * 1_000 : null,
      remainingMs: evaluation?.remainingMs ?? null,
      canBeginNewActivity: evaluation?.canBeginNewActivity === true,
      maxStudentsPerClass: claims?.maxStudentsPerClass ?? 0,
      maxConcurrentClasses: claims?.maxConcurrentClasses ?? 0,
      lastTrustedAt: this.protectedState?.lastTrustedAt ?? null,
      lastError: this.lastError,
    })
  }

  getState() {
    return this.current
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    for (const listener of this.listeners) {
      try { listener(this.current) } catch { /* one renderer cannot break entitlement evaluation */ }
    }
  }

  async initialize() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      this.lastError = 'secure-storage-unavailable'
      this.current = this.makePublicState('corrupt')
      return this.current
    }
    try {
      const encrypted = await readOptional(this.protectedPath)
      if (encrypted) {
        const decrypted = this.safeStorage.decryptString(encrypted)
        const parsed = JSON.parse(decrypted)
        if (parsed?.schemaVersion !== 1
          || typeof parsed?.installationPrivateKey !== 'string'
          || typeof parsed?.installationPublicKey !== 'string'
          || installationKeyThumbprint(parsed.installationPublicKey) !== parsed.installationKeyThumbprint) {
          throw new Error('invalid-protected-state')
        }
        this.protectedState = parsed
      } else {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519')
        const installationPrivateKey = base64url(privateKey.export({ format: 'der', type: 'pkcs8' }))
        const installationPublicKey = base64url(publicKey.export({ format: 'der', type: 'spki' }))
        const now = this.now()
        this.protectedState = {
          schemaVersion: 1,
          installationPrivateKey,
          installationPublicKey,
          installationKeyThumbprint: installationKeyThumbprint(installationPublicKey),
          lastTrustedAt: null,
          highestWallClock: now,
        }
        await this.persistProtected()
      }
      const compact = await readOptional(this.entitlementPath)
      if (!compact) {
        this.current = this.makePublicState('activation_required')
        return this.current
      }
      this.installEntitlement(compact.toString('utf8').trim())
      await this.reevaluate(true)
      return this.current
    } catch (error) {
      if (error?.message === 'known-revoked-entitlement') {
        this.lastError = 'revoked'
        this.current = this.makePublicState('revoked')
        return this.current
      }
      this.claims = null
      this.entitlement = null
      this.lastError = error?.message === 'stale-entitlement-serial'
        ? 'stale-entitlement-serial'
        : 'installation-state-corrupt'
      this.current = this.makePublicState('corrupt')
      return this.current
    }
  }

  installEntitlement(compact) {
    const claims = verifyEntitlementJws(compact, this.config)
    if (claims.installationKeyThumbprint !== this.protectedState?.installationKeyThumbprint) {
      throw new Error('wrong-installation')
    }
    const terminal = this.protectedState?.terminalEntitlement
    if (terminal?.licenceId === claims.sub) {
      this.entitlement = compact
      this.claims = claims
      throw new Error('known-revoked-entitlement')
    }
    const knownLicenceId = this.protectedState?.highestLeaseLicenceId
    const knownSerial = this.protectedState?.highestLeaseSerial
    const knownLeaseId = this.protectedState?.highestLeaseId
    if (knownLicenceId && knownLicenceId !== claims.sub) throw new Error('unexpected-entitlement-identity')
    if (Number.isSafeInteger(knownSerial)) {
      if (claims.serial < knownSerial
        || (claims.serial === knownSerial && knownLeaseId && claims.jti !== knownLeaseId)) {
        throw new Error('stale-entitlement-serial')
      }
    }
    this.entitlement = compact
    this.claims = claims
    this.signingKeyId = JSON.parse(decodeBase64url(compact.split('.')[0]).toString('utf8')).kid
    this.protectedState.highestLeaseLicenceId = claims.sub
    this.protectedState.highestLeaseSerial = claims.serial
    this.protectedState.highestLeaseId = claims.jti
  }

  async persistProtected() {
    const encrypted = this.safeStorage.encryptString(JSON.stringify(this.protectedState))
    await atomicWrite(this.protectedPath, encrypted)
    this.lastPersistedClock = this.protectedState.highestWallClock
  }

  async reevaluate(forcePersist = false) {
    if (!this.claims || !this.protectedState) return this.current
    const now = this.now()
    const evaluation = evaluateEntitlement(this.claims, this.protectedState, now)
    if (evaluation.status !== 'clock_anomaly') {
      this.protectedState.highestWallClock = Math.max(this.protectedState.highestWallClock || 0, now)
      if (forcePersist || now - this.lastPersistedClock >= PERSIST_CLOCK_INTERVAL_MS) {
        await this.persistProtected()
      }
    }
    this.current = this.makePublicState(evaluation.status, evaluation)
    this.emit()
    return this.current
  }

  privateKey() {
    return createPrivateKey({
      key: decodeBase64url(this.protectedState.installationPrivateKey),
      format: 'der',
      type: 'pkcs8',
    })
  }

  async requestJson(pathname, body) {
    if (!this.config.configured || !this.config.apiUrl || typeof this.fetchImpl !== 'function') {
      throw new LicensingServiceError('service-not-configured')
    }
    let response
    try {
      response = await this.fetchImpl(`${this.config.apiUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      throw new LicensingServiceError('service-unavailable', true)
    }
    let payload = null
    try { payload = await response.json() } catch { /* handled as invalid response */ }
    if (!response.ok) {
      const error = payload?.error
      throw new LicensingServiceError(
        typeof error?.code === 'string' ? error.code : 'service-unavailable',
        error?.retryable === true,
        Number.isFinite(error?.retryAfterSeconds) ? error.retryAfterSeconds : null,
      )
    }
    this.lastServiceReachableAt = this.now()
    return payload
  }

  async createChallenge(purpose) {
    const installationPublicKey = this.protectedState.installationPublicKey
    const payload = await this.requestJson('/v1/challenges', { installationPublicKey, purpose })
    if (typeof payload?.challengeId !== 'string'
      || typeof payload?.challenge !== 'string'
      || typeof payload?.serverTime !== 'string') throw new LicensingServiceError('invalid-service-response')
    const challengeSignature = base64url(signBytes(null, Buffer.from(payload.challenge, 'utf8'), this.privateKey()))
    return {
      challengeId: payload.challengeId,
      challenge: payload.challenge,
      challengeSignature,
      installationPublicKey,
    }
  }

  async acceptServiceEntitlement(payload) {
    if (typeof payload?.entitlement !== 'string' || typeof payload?.serverTime !== 'string') {
      throw new LicensingServiceError('invalid-service-response')
    }
    this.installEntitlement(payload.entitlement)
    const serverTime = Date.parse(payload.serverTime)
    if (!Number.isFinite(serverTime)) throw new LicensingServiceError('invalid-service-response')
    const now = this.now()
    if (Math.abs(serverTime - now) > 24 * 60 * 60 * 1_000) {
      throw new LicensingServiceError('clock-anomaly')
    }
    this.protectedState.lastTrustedAt = serverTime
    this.protectedState.highestWallClock = Math.max(this.protectedState.highestWallClock || 0, serverTime)
    await atomicWrite(this.entitlementPath, `${payload.entitlement}\n`)
    await this.persistProtected()
    this.lastError = null
    await this.reevaluate(true)
    return { ok: true, state: this.current }
  }

  async persistTerminalEntitlement(status) {
    if (!this.protectedState || !this.claims) return
    this.protectedState.terminalEntitlement = {
      licenceId: this.claims.sub,
      status,
      serial: this.claims.serial,
      recordedAt: this.now(),
    }
    try {
      await this.persistProtected()
    } catch {
      await unlink(this.entitlementPath).catch(() => {})
      this.entitlement = null
      this.claims = null
      throw new Error('terminal-state-persistence-failed')
    }
  }

  async serviceFailure(error) {
    const code = error instanceof LicensingServiceError ? error.code : 'service-unavailable'
    this.lastError = code
    if (code === 'revoked' || code === 'replaced') {
      try {
        await this.persistTerminalEntitlement(code)
        this.current = this.makePublicState('revoked')
      } catch {
        this.lastError = 'terminal-state-persistence-failed'
        this.current = this.makePublicState('corrupt')
      }
    }
    else if (code === 'expired') this.current = this.makePublicState('expired')
    else if (code === 'unsupported-version') this.current = this.makePublicState('unsupported_version')
    else if (code === 'clock-anomaly') this.current = this.makePublicState('clock_anomaly')
    this.emit()
    return {
      ok: false,
      error: code,
      retryable: error instanceof LicensingServiceError && error.retryable,
      retryAfterSeconds: error instanceof LicensingServiceError ? error.retryAfterSeconds : null,
    }
  }

  async activate(code) {
    const normalized = normalizeEvaluatorCode(code)
    if (!normalized) return { ok: false, error: 'invalid-code-format', retryable: false, retryAfterSeconds: null }
    if (!this.protectedState) return { ok: false, error: 'secure-storage-unavailable', retryable: false, retryAfterSeconds: null }
    if (this.entitlement) return { ok: false, error: 'installation-already-licensed', retryable: false, retryAfterSeconds: null }
    try {
      const proof = await this.createChallenge('activation')
      const payload = await this.requestJson('/v1/activations/redeem', {
        code: normalized,
        ...proof,
        appVersion: this.appVersion,
      })
      return await this.acceptServiceEntitlement(payload)
    } catch (error) {
      return await this.serviceFailure(error)
    }
  }

  async refresh() {
    if (!this.entitlement || !this.protectedState) {
      return { ok: false, error: 'activation-required', retryable: false, retryAfterSeconds: null }
    }
    try {
      const proof = await this.createChallenge('refresh')
      const payload = await this.requestJson('/v1/leases/refresh', {
        currentEntitlement: this.entitlement,
        ...proof,
        appVersion: this.appVersion,
      })
      return await this.acceptServiceEntitlement(payload)
    } catch (error) {
      await this.reevaluate()
      return await this.serviceFailure(error)
    }
  }

  getRelayLease() {
    if (this.protectedState?.terminalEntitlement) return null
    return ['active', 'warning'].includes(this.current.status) ? this.entitlement : null
  }

  diagnostics() {
    const signingKey = this.config.publicKeys?.[this.signingKeyId]
    const publicKeyThumbprintPrefix = typeof signingKey === 'string'
      ? base64url(createHash('sha256').update(decodeBase64url(signingKey)).digest()).slice(0, 12)
      : null
    return Object.freeze({
      schemaVersion: 1,
      generatedAt: new Date(this.now()).toISOString(),
      appVersion: this.appVersion,
      gitSha: process.env.VITE_GIT_SHA ?? process.env.GITHUB_SHA ?? 'unknown',
      licenceIdSuffix: typeof this.claims?.sub === 'string' ? this.claims.sub.slice(-8) : null,
      publicKeyThumbprintPrefix,
      state: this.current.status,
      activatedAt: this.current.activatedAt,
      expiresAt: this.current.expiresAt,
      offlineUntil: this.current.offlineUntil,
      lastTrustedAt: this.protectedState?.lastTrustedAt ?? null,
      lastServiceReachableAt: this.lastServiceReachableAt,
      serviceConfigured: this.config.configured === true,
      serviceOrigin: this.config.apiUrl ? new URL(this.config.apiUrl).origin : null,
      lastError: this.lastError,
    })
  }

  async destroyForTests() {
    await Promise.all([
      unlink(this.protectedPath).catch(() => {}),
      unlink(this.entitlementPath).catch(() => {}),
    ])
  }
}
