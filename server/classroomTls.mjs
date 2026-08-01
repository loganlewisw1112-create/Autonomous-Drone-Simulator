import 'reflect-metadata'
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate as PeculiarCertificate,
  X509CertificateGenerator,
  cryptoProvider,
} from '@peculiar/x509'
import { randomBytes, webcrypto, X509Certificate } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

// @peculiar/x509 consumes the standards-track Web Crypto interface. Node's
// declaration includes newer key usages, so its structurally compatible
// implementation needs a type-only bridge until the upstream types converge.
cryptoProvider.set(/** @type {Crypto} */ (/** @type {unknown} */ (webcrypto)))

const ALGORITHM = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 3072,
}
const CA_DAYS = 3650
const LEAF_DAYS = 397
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000

function serialNumber() {
  return randomBytes(16).toString('hex')
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function normalizeHosts(hosts) {
  const normalized = new Set(['localhost', '127.0.0.1', '::1'])
  for (const host of hosts || []) {
    const value = String(host || '').trim().toLowerCase()
    if (value) normalized.add(value)
  }
  return [...normalized].sort()
}

function isIpAddress(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':')
}

function pemPrivateKey(raw) {
  return PemConverter.encode(raw, PemConverter.PrivateKeyTag)
}

function pemToArrayBuffer(pem) {
  return PemConverter.decodeFirst(pem)
}

async function atomicWrite(filePath, contents, mode) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  await writeFile(temporary, contents, { encoding: 'utf8', mode })
  await chmod(temporary, mode).catch(() => {})
  await rename(temporary, filePath)
  await chmod(filePath, mode).catch(() => {})
}

async function readable(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function createCertificateAuthority(now) {
  const nodeKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])
  const certificateKeys = /** @type {CryptoKeyPair} */ (
    /** @type {unknown} */ (nodeKeys)
  )
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(),
    name: 'CN=Autonomous Drone Simulator School Local CA, O=Local Classroom',
    notBefore: new Date(now.getTime() - 5 * 60 * 1000),
    notAfter: addDays(now, CA_DAYS),
    signingAlgorithm: ALGORITHM,
    keys: certificateKeys,
    extensions: [
      new BasicConstraintsExtension(true, 0, true),
      new KeyUsagesExtension(
        KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign | KeyUsageFlags.digitalSignature,
        true,
      ),
      await SubjectKeyIdentifierExtension.create(certificateKeys.publicKey),
    ],
  })
  const privateKey = await webcrypto.subtle.exportKey('pkcs8', nodeKeys.privateKey)
  return {
    certificatePem: certificate.toString('pem'),
    privateKeyPem: pemPrivateKey(privateKey),
  }
}

async function importCaPrivateKey(privateKeyPem) {
  return webcrypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    ALGORITHM,
    false,
    ['sign'],
  )
}

async function createLeafCertificate(caCertificatePem, caPrivateKeyPem, hosts, now) {
  const caCertificate = new PeculiarCertificate(caCertificatePem)
  const nodeCaPrivateKey = await importCaPrivateKey(caPrivateKeyPem)
  const certificateCaPrivateKey = /** @type {CryptoKey} */ (
    /** @type {unknown} */ (nodeCaPrivateKey)
  )
  const nodeKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])
  const certificateKeys = /** @type {CryptoKeyPair} */ (
    /** @type {unknown} */ (nodeKeys)
  )
  const san = hosts.map((host) => ({
    type: isIpAddress(host) ? 'ip' : 'dns',
    value: host,
  }))
  const certificate = await X509CertificateGenerator.create({
    serialNumber: serialNumber(),
    subject: 'CN=Autonomous Drone Simulator Classroom Relay, O=Local Classroom',
    issuer: caCertificate.subject,
    notBefore: new Date(now.getTime() - 5 * 60 * 1000),
    notAfter: addDays(now, LEAF_DAYS),
    publicKey: certificateKeys.publicKey,
    signingKey: certificateCaPrivateKey,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(
        KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment,
        true,
      ),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], false),
      new SubjectAlternativeNameExtension(san, false),
      await SubjectKeyIdentifierExtension.create(certificateKeys.publicKey),
      await AuthorityKeyIdentifierExtension.create(caCertificate.publicKey),
    ],
  })
  const privateKey = await webcrypto.subtle.exportKey('pkcs8', nodeKeys.privateKey)
  return {
    certificatePem: certificate.toString('pem'),
    privateKeyPem: pemPrivateKey(privateKey),
  }
}

function leafNeedsRenewal(certificatePem, manifest, hosts, now) {
  try {
    const certificate = new X509Certificate(certificatePem)
    const expiresAt = Date.parse(certificate.validTo)
    if (!Number.isFinite(expiresAt) || expiresAt - now.getTime() <= RENEW_BEFORE_MS) return true
    return JSON.stringify(manifest?.hosts) !== JSON.stringify(hosts)
  } catch {
    return true
  }
}

/**
 * Creates a persistent school-local CA and a renewable relay leaf certificate.
 * The directory must be a user-owned application-data directory, never the repo.
 *
 * @param {{ directory: string, hosts?: string[], now?: Date }} options
 */
export async function ensureClassroomCertificates({
  directory,
  hosts = [],
  now = new Date(),
}) {
  if (!path.isAbsolute(directory)) throw new Error('TLS directory must be absolute')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700).catch(() => {})

  const caCertificatePath = path.join(directory, 'school-local-ca.crt')
  const caPrivateKeyPath = path.join(directory, 'school-local-ca.key')
  const leafCertificatePath = path.join(directory, 'classroom-relay.crt')
  const leafPrivateKeyPath = path.join(directory, 'classroom-relay.key')
  const manifestPath = path.join(directory, 'classroom-relay.json')
  const normalizedHosts = normalizeHosts(hosts)

  if (!(await readable(caCertificatePath)) || !(await readable(caPrivateKeyPath))) {
    const ca = await createCertificateAuthority(now)
    await atomicWrite(caPrivateKeyPath, ca.privateKeyPem, 0o600)
    await atomicWrite(caCertificatePath, ca.certificatePem, 0o644)
  }

  const caCertificatePem = await readFile(caCertificatePath, 'utf8')
  const caPrivateKeyPem = await readFile(caPrivateKeyPath, 'utf8')
  let leafCertificatePem = await readFile(leafCertificatePath, 'utf8').catch(() => '')
  let manifest = await readFile(manifestPath, 'utf8')
    .then((value) => JSON.parse(value))
    .catch(() => null)

  if (
    !leafCertificatePem
    || !(await readable(leafPrivateKeyPath))
    || leafNeedsRenewal(leafCertificatePem, manifest, normalizedHosts, now)
  ) {
    const leaf = await createLeafCertificate(
      caCertificatePem,
      caPrivateKeyPem,
      normalizedHosts,
      now,
    )
    await atomicWrite(leafPrivateKeyPath, leaf.privateKeyPem, 0o600)
    await atomicWrite(leafCertificatePath, leaf.certificatePem, 0o644)
    manifest = {
      version: 1,
      hosts: normalizedHosts,
      renewedAt: now.toISOString(),
    }
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600)
    leafCertificatePem = leaf.certificatePem
  }

  const leafPrivateKeyPem = await readFile(leafPrivateKeyPath, 'utf8')
  const leafCertificate = new X509Certificate(leafCertificatePem)
  return {
    caCertificatePath,
    caCertificatePem,
    leafCertificatePath,
    leafCertificatePem,
    leafPrivateKeyPath,
    leafPrivateKeyPem,
    fingerprint256: leafCertificate.fingerprint256,
    hosts: normalizedHosts,
  }
}
