import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureClassroomCertificates } from '../../server/classroomTls.mjs'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('school-local classroom TLS', () => {
  it('persists a CA, reuses a valid leaf, and renews the leaf without replacing the CA', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'drone-classroom-tls-'))
    cleanup.push(directory)
    const now = new Date('2026-07-27T12:00:00.000Z')

    const first = await ensureClassroomCertificates({
      directory,
      hosts: ['192.168.86.120'],
      now,
    })
    const second = await ensureClassroomCertificates({
      directory,
      hosts: ['192.168.86.120'],
      now: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    })

    expect(second.fingerprint256).toBe(first.fingerprint256)
    expect(second.hosts).toEqual(['127.0.0.1', '192.168.86.120', '::1', 'localhost'])
    expect(path.isAbsolute(first.caCertificatePath)).toBe(true)
    expect(path.isAbsolute(first.leafPrivateKeyPath)).toBe(true)

    const ca = new X509Certificate(first.caCertificatePem)
    const leaf = new X509Certificate(first.leafCertificatePem)
    expect(ca.ca).toBe(true)
    expect(leaf.ca).toBe(false)
    expect(leaf.checkHost('localhost')).toBe('localhost')
    expect(leaf.checkIP('192.168.86.120')).toBe('192.168.86.120')
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(await readFile(first.caCertificatePath, 'utf8')).not.toContain('PRIVATE KEY')

    const renewed = await ensureClassroomCertificates({
      directory,
      hosts: ['192.168.86.120'],
      now: new Date(now.getTime() + 380 * 24 * 60 * 60 * 1000),
    })
    expect(renewed.fingerprint256).not.toBe(first.fingerprint256)
    expect(renewed.caCertificatePem).toBe(first.caCertificatePem)
    expect(new X509Certificate(renewed.leafCertificatePem).verify(ca.publicKey)).toBe(true)
  }, 30_000)
})
