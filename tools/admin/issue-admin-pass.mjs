#!/usr/bin/env node
// Issues a signed ADMIN pass.
//   node tools/admin/issue-admin-pass.mjs --email <e> --name <n> [--expires <ISO>]
// Signs with local-secrets/admin-signing-key.json and writes
// local-secrets/admin-passes/<email>.txt. Prints only the file path and passId.
// A pass is a bearer credential: never paste it into chat, issues or commits.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  ADMIN_PASS_PREFIX,
  adminPassSigningBytes,
  base64UrlToBytes,
  bytesToBase64Url,
} from '../../server/adminPassVerify.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const keyPath = path.join(root, 'local-secrets', 'admin-signing-key.json')
const passDir = path.join(root, 'local-secrets', 'admin-passes')

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const email = arg('email')?.trim().toLowerCase()
const name = arg('name')?.trim()
const expires = arg('expires')
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('--email <address> is required')
if (!name) fail('--name <display name> is required')
let expiresAt
if (expires !== undefined) {
  expiresAt = Date.parse(expires)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) fail('--expires must be a future ISO date')
}
if (!existsSync(keyPath)) fail('No signing key. Run tools/admin/admin-keygen.mjs first.')

const key = JSON.parse(readFileSync(keyPath, 'utf8'))
const secretKey = base64UrlToBytes(key.privateKey)
if (!secretKey || secretKey.length !== 32) fail('local-secrets/admin-signing-key.json is not a valid key file')

const passId = `adm-${randomBytes(9).toString('base64url')}`
const payload = { v: 1, email, name, passId, issuedAt: Date.now(), ...(expiresAt ? { expiresAt } : {}) }
const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
const signature = ed25519.sign(adminPassSigningBytes(payloadB64), secretKey)
const pass = `${ADMIN_PASS_PREFIX}.${payloadB64}.${bytesToBase64Url(signature)}`

mkdirSync(passDir, { recursive: true })
const outPath = path.join(passDir, `${email.replace(/[^a-z0-9@._-]/g, '_')}.txt`)
writeFileSync(outPath, `${pass}\n`, { mode: 0o600 })
console.log(`pass file: ${path.relative(root, outPath)}`)
console.log(`passId:    ${passId}`)
