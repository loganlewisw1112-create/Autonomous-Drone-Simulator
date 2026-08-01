import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const main = readFileSync(path.join(root, 'desktop/classroom/main.mjs'), 'utf8')
const preload = readFileSync(path.join(root, 'desktop/classroom/preload.cjs'), 'utf8')
const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as {
  headers: Array<{ headers: Array<{ key: string; value: string }> }>
}

describe('desktop and hosted browser hardening', () => {
  it('keeps Electron sandboxed and denies untrusted navigation, permissions, and URL schemes', () => {
    expect(main).toContain('contextIsolation: true')
    expect(main).toContain('nodeIntegration: false')
    expect(main).toContain('sandbox: true')
    expect(main).toContain('webSecurity: true')
    expect(main).toContain("target.protocol === 'https:'")
    expect(main).toContain('setPermissionRequestHandler')
    expect(main).toContain('setPermissionCheckHandler')
    expect(main).toContain('relayJoinBaseUrl')
    expect(preload).toContain('relayJoinBaseUrl')
    expect(main).not.toContain('loadFile(')
    expect(main).not.toContain('executeJavaScript')
  })

  it('keeps the relay administrator token in the main/child boundary', () => {
    expect(main).toContain('CLASSROOM_ADMIN_TOKEN: administratorToken')
    expect(main).toContain("dialog.showMessageBox")
    expect(preload).toContain('provisionInstructorAccess')
    expect(preload).not.toContain('CLASSROOM_ADMIN_TOKEN')
    expect(preload).not.toContain('administratorToken')
  })

  it('ships CSP, frame, permission, opener, and transport headers', () => {
    const all = vercel.headers.flatMap((entry) => entry.headers)
    const keys = new Set(all.map((header) => header.key.toLowerCase()))
    expect([...keys]).toEqual(expect.arrayContaining([
      'content-security-policy',
      'x-frame-options',
      'permissions-policy',
      'cross-origin-opener-policy',
      'strict-transport-security',
    ]))
    const csp = all.find((header) => header.key.toLowerCase() === 'content-security-policy')?.value
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })
})
