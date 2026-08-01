import { mkdir, writeFile } from 'node:fs/promises'
import { createPublicKey } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required public licence configuration: ${name}`)
  return value
}

const apiUrl = new URL(required('LICENSING_API_URL'))
const issuer = new URL(required('LICENSING_ISSUER'))
if (apiUrl.protocol !== 'https:' || issuer.protocol !== 'https:') {
  throw new Error('LICENSING_API_URL and LICENSING_ISSUER must use HTTPS')
}

const keyId = required('LICENSING_JWS_KEY_ID')
if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId)) throw new Error('Invalid LICENSING_JWS_KEY_ID')
const publicKey = required('LICENSING_JWS_PUBLIC_KEY_SPKI_BASE64')
let publicKeyDer
try {
  publicKeyDer = Buffer.from(publicKey, 'base64')
  const parsedKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' })
  if (parsedKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
} catch {
  throw new Error('LICENSING_JWS_PUBLIC_KEY_SPKI_BASE64 must be base64 Ed25519 DER SPKI')
}

const output = path.resolve('desktop/licensing/public-config.generated.json')
await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify({
  schemaVersion: 1,
  apiUrl: apiUrl.toString().replace(/\/$/, ''),
  issuer: issuer.toString().replace(/\/$/, ''),
  audience: 'adms-windows-classroom',
  publicKeys: { [keyId]: publicKeyDer.toString('base64url') },
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
console.log(`Wrote public licence configuration for kid=${keyId}`)
