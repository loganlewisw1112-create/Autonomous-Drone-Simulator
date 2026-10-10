#!/usr/bin/env node
// Generates the offline Ed25519 ADMIN signing key.
//   node tools/admin/admin-keygen.mjs
// Writes local-secrets/admin-signing-key.json (gitignored) and prints ONLY the
// public key (base64url). Refuses to overwrite an existing key: rotate by
// moving the old file aside deliberately.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToBase64Url } from '../../server/adminPassVerify.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const secretsDir = path.join(root, 'local-secrets')
const keyPath = path.join(secretsDir, 'admin-signing-key.json')

if (existsSync(keyPath)) {
  console.error('Refusing to overwrite the existing signing key at local-secrets/admin-signing-key.json.')
  console.error('To rotate, move that file somewhere safe first, then run this again.')
  process.exit(1)
}

const { secretKey, publicKey } = ed25519.keygen()
mkdirSync(secretsDir, { recursive: true })
writeFileSync(
  keyPath,
  `${JSON.stringify({
    v: 1,
    alg: 'ed25519',
    createdAt: new Date().toISOString(),
    privateKey: bytesToBase64Url(secretKey),
    publicKey: bytesToBase64Url(publicKey),
  }, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 },
)

console.log(bytesToBase64Url(publicKey))
