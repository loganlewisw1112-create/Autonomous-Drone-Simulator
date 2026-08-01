import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const fail = (message) => {
  throw new Error(`Licensed Windows packaging refused: ${message}`)
}

if (process.env.VITE_DISTRIBUTION_CHANNEL !== 'licensed_windows') {
  fail('VITE_DISTRIBUTION_CHANNEL must equal licensed_windows')
}

for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WINDOWS_SIGNER_SUBJECT']) {
  if (!process.env[name]?.trim()) fail(`${name} is required`)
}

const configPath = path.resolve('desktop/licensing/public-config.generated.json')
let config
try {
  config = JSON.parse(await readFile(configPath, 'utf8'))
} catch {
  fail('generate desktop/licensing/public-config.generated.json first')
}

if (config.schemaVersion !== 1 || config.audience !== 'adms-windows-classroom') {
  fail('public entitlement schema or audience is invalid')
}
for (const [name, value] of [['apiUrl', config.apiUrl], ['issuer', config.issuer]]) {
  let parsed
  try { parsed = new URL(value) } catch { fail(`${name} is not a valid URL`) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    fail(`${name} must be a credential-free HTTPS URL`)
  }
}

const keys = Object.entries(config.publicKeys || {})
if (keys.length < 1) fail('at least one public entitlement verification key is required')
for (const [keyId, encoded] of keys) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId) || typeof encoded !== 'string') {
    fail('public key ring contains an invalid key identifier or value')
  }
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') fail(`key ${keyId} is not Ed25519`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Licensed Windows packaging refused:')) throw error
    fail(`key ${keyId} is not valid DER SPKI`)
  }
}

process.stdout.write(`Licensed packaging configuration accepted (${keys.length} Ed25519 key${keys.length === 1 ? '' : 's'}).\n`)
