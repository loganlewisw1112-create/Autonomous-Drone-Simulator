export const LICENSING_SCHEMA_VERSION = 1 as const
export const LICENSING_AUDIENCE = 'adms-windows-classroom' as const
export const SERVICE_NAME = 'adms-licensing' as const

export type EntitlementTier =
  | 'selected_evaluator_demo'
  | 'agency_classroom_pilot'

export const ENTITLEMENT_FEATURES = [
  'simulator',
  'custom-missions',
  'classroom-host',
  'replay',
  'export',
] as const

export interface EntitlementClaims {
  schemaVersion: 1
  iss: string
  aud: typeof LICENSING_AUDIENCE
  sub: string
  jti: string
  iat: number
  nbf: number
  exp: number
  activatedAt: number
  offlineUntil: number
  serial: number
  tier: EntitlementTier
  installationKeyThumbprint: string
  features: typeof ENTITLEMENT_FEATURES
  maxStudentsPerClass: 40
  maxConcurrentClasses: 1
  minimumVersion: string
  maximumVersionExclusive: string
}

export interface ChallengeRequest {
  installationPublicKey: string
  purpose: 'activation' | 'refresh'
}

export interface ChallengeResponse {
  challengeId: string
  challenge: string
  expiresAt: string
  serverTime: string
}

export interface ChallengeProof {
  challengeId: string
  challenge: string
  challengeSignature: string
  installationPublicKey: string
  appVersion: string
}

export interface RedeemRequest extends ChallengeProof {
  code: string
}

export interface RefreshRequest extends ChallengeProof {
  currentEntitlement: string
}

export interface EntitlementResponse {
  entitlement: string
  serverTime: string
  expiresAt: string
  offlineUntil: string
}

export interface HealthResponse {
  status: 'ok'
  service: typeof SERVICE_NAME
  revision: string
  schemaVersion: 1
  signingKeyId: string
  serverTime: string
}

export interface ErrorResponse {
  error: {
    code: string
    message: string
    retryable: boolean
    retryAfterSeconds?: number
  }
}

export const TIER_DURATION_MS: Readonly<Record<EntitlementTier, number>> = {
  selected_evaluator_demo: 14 * 24 * 60 * 60 * 1_000,
  agency_classroom_pilot: 90 * 24 * 60 * 60 * 1_000,
}

export const OFFLINE_LEASE_MS = 72 * 60 * 60 * 1_000
export const UNUSED_CODE_TTL_MS = 30 * 24 * 60 * 60 * 1_000
export const CHALLENGE_TTL_MS = 5 * 60 * 1_000

export class LicensingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'LicensingError'
  }
}
