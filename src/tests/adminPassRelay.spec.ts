import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  ADMIN_PASS_PREFIX,
  adminPassSigningBytes,
  bytesToBase64Url,
} from '../../server/adminPassVerify.mjs'

const testRoot = path.join(tmpdir(), `drone-admin-relay-${process.pid}`)
mkdirSync(path.join(testRoot, 'secrets'), { recursive: true })
mkdirSync(path.join(testRoot, 'runs'), { recursive: true })
process.env.CLASSROOM_SECRETS_DIR = path.join(testRoot, 'secrets')
process.env.CLASSROOM_RUNS_DIR = path.join(testRoot, 'runs')
process.env.CLASSROOM_ADMIN_TOKEN = 'ADMIN-PASS-RELAY-TOKEN'

interface Relay {
  handleInstructorAccessHttp(req: unknown, res: unknown): Promise<boolean>
  setAdminPassTrustForTests(trust: { trustedPublicKeys: string[]; revokedPassIds: string[] } | null): void
  resetRelayState(): void
}

const relayUrl = new URL('../../server/classroom.mjs', import.meta.url).href
let relay: Relay

const trusted = ed25519.keygen()
const stranger = ed25519.keygen()

function sign(payload: Record<string, unknown>, secretKey = trusted.secretKey) {
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = ed25519.sign(adminPassSigningBytes(payloadB64), secretKey)
  return `${ADMIN_PASS_PREFIX}.${payloadB64}.${bytesToBase64Url(sig)}`
}

const claims = { v: 1, email: 'owner@example.com', name: 'Owner', passId: 'adm-relay-1', issuedAt: Date.now() - 1000 }

function mockRes() {
  let status = 0
  let body = ''
  let headers: Record<string, string> = {}
  return {
    get status() { return status },
    get parsed() { return body ? JSON.parse(body) as Record<string, unknown> : null },
    get headers() { return headers },
    writeHead(code: number, next: Record<string, string> = {}) { status = code; headers = next },
    end(data?: string) { body = data ?? '' },
  }
}

function mockReq(body: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(body))
  const req = {
    method: 'POST',
    url: '/api/instructor-access/session',
    headers: { 'content-type': 'application/json', 'content-length': String(raw.length) },
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    async *[Symbol.asyncIterator]() { yield raw },
  }
  return req
}

async function post(body: Record<string, unknown>) {
  const res = mockRes()
  await relay.handleInstructorAccessHttp(mockReq(body), res)
  return res
}

beforeAll(async () => {
  relay = await import(/* @vite-ignore */ relayUrl) as unknown as Relay
})

afterEach(() => {
  relay.resetRelayState()
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
  delete process.env.CLASSROOM_SECRETS_DIR
  delete process.env.CLASSROOM_RUNS_DIR
  delete process.env.CLASSROOM_ADMIN_TOKEN
})

describe('relay accepts signed admin passes', () => {
  it('issues the instructor session cookie for a valid pass, with no access code', async () => {
    relay.setAdminPassTrustForTests({ trustedPublicKeys: [bytesToBase64Url(trusted.publicKey)], revokedPassIds: [] })
    const res = await post({ adminPass: sign(claims) })
    expect(res.status).toBe(200)
    expect(res.parsed).toEqual({ ok: true })
    expect(res.headers['set-cookie']).toMatch(/HttpOnly/)
  })

  it('rejects a forged pass (other key) and an edited payload', async () => {
    relay.setAdminPassTrustForTests({ trustedPublicKeys: [bytesToBase64Url(trusted.publicKey)], revokedPassIds: [] })
    const forged = await post({ adminPass: sign(claims, stranger.secretKey) })
    expect(forged.status).toBe(401)
    expect(forged.headers['set-cookie']).toBeUndefined()
    const [prefix, , sig] = sign(claims).split('.')
    const edited = await post({
      adminPass: `${prefix}.${bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ ...claims, email: 'x@y.zz' })))}.${sig}`,
    })
    expect(edited.status).toBe(401)
  })

  it('rejects a revoked pass and an expired pass', async () => {
    relay.setAdminPassTrustForTests({ trustedPublicKeys: [bytesToBase64Url(trusted.publicKey)], revokedPassIds: ['adm-relay-1'] })
    expect((await post({ adminPass: sign(claims) })).status).toBe(401)
    relay.setAdminPassTrustForTests({ trustedPublicKeys: [bytesToBase64Url(trusted.publicKey)], revokedPassIds: [] })
    expect((await post({ adminPass: sign({ ...claims, expiresAt: Date.now() - 1 }) })).status).toBe(401)
  })

  it('rejects a throwaway-signed pass under the shipped production trust', async () => {
    relay.setAdminPassTrustForTests(null)
    expect((await post({ adminPass: sign(claims) })).status).toBe(401)
  })

  it('rate-limits repeated bad passes on the same limiter as the access code', async () => {
    relay.setAdminPassTrustForTests({ trustedPublicKeys: [bytesToBase64Url(trusted.publicKey)], revokedPassIds: [] })
    let last = 0
    for (let i = 0; i < 12; i += 1) last = (await post({ adminPass: 'DSA1.bad.bad' })).status
    expect(last).toBe(429)
    expect((await post({ adminPass: sign(claims) })).status).toBe(429)
  })
})
