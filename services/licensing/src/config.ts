import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'

export interface LicensingConfig {
  databaseUrl: string
  codeHmacKey: Buffer
  rateLimitHmacKey: Buffer
  auditHmacKey: Buffer
  signingPrivateKey: KeyObject
  signingPublicKey: KeyObject
  signingKeyId: string
  issuer: string
  allowedOrigin?: string
  minimumVersion: string
  maximumVersionExclusive: string
  revision: string
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function base64Secret(name: string, env: NodeJS.ProcessEnv, minimumBytes = 32): Buffer {
  const encoded = required(name, env)
  const value = Buffer.from(encoded, 'base64')
  if (value.length < minimumBytes) {
    throw new Error(`${name} must decode to at least ${minimumBytes} bytes`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LicensingConfig {
  const privateDer = Buffer.from(required('LICENSING_JWS_PRIVATE_KEY_PKCS8_BASE64', env), 'base64')
  const privateKey = createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' })
  const configuredPublic = env.LICENSING_JWS_PUBLIC_KEY_SPKI_BASE64?.trim()
  const publicKey = configuredPublic
    ? createPublicKey({ key: Buffer.from(configuredPublic, 'base64'), format: 'der', type: 'spki' })
    : createPublicKey(privateKey)

  return {
    databaseUrl: required('DATABASE_URL', env),
    codeHmacKey: base64Secret('LICENSING_CODE_HMAC_KEY_BASE64', env),
    rateLimitHmacKey: base64Secret('LICENSING_RATE_LIMIT_HMAC_KEY_BASE64', env),
    auditHmacKey: base64Secret('LICENSING_AUDIT_HMAC_KEY_BASE64', env),
    signingPrivateKey: privateKey,
    signingPublicKey: publicKey,
    signingKeyId: required('LICENSING_JWS_KEY_ID', env),
    issuer: required('LICENSING_ISSUER', env),
    ...(env.LICENSING_ALLOWED_ORIGIN?.trim()
      ? { allowedOrigin: env.LICENSING_ALLOWED_ORIGIN.trim() }
      : {}),
    minimumVersion: env.LICENSING_MINIMUM_VERSION?.trim() || '1.1.0',
    maximumVersionExclusive: env.LICENSING_MAXIMUM_VERSION_EXCLUSIVE?.trim() || '1.2.0',
    revision: env.LICENSING_REVISION?.trim() || env.VERCEL_GIT_COMMIT_SHA?.trim() || 'unknown',
  }
}
