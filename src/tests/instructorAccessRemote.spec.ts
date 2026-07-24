// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearDeviceInstructorAccessHash,
  hashInstructorAccessCode,
  readDeviceInstructorAccessHash,
} from '@/account/instructorAccess'
import { unlockWithInstructorAccessCode } from '@/account/instructorAccessRemote'

describe('unlockWithInstructorAccessCode', () => {
  beforeEach(() => {
    clearDeviceInstructorAccessHash()
    vi.stubEnv('VITE_INSTRUCTOR_ACCESS_HASH', '')
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    clearDeviceInstructorAccessHash()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('accepts a matching code when a device hash already exists', async () => {
    const code = 'EXISTING-SCHOOL'
    const hash = hashInstructorAccessCode(code)
    localStorage.setItem('drone-sim:instructor-access-hash:v1', hash)
    const fetchMock = vi.mocked(fetch)
    const result = await unlockWithInstructorAccessCode(code)
    expect(result).toEqual({ ok: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a wrong code when a device hash already exists', async () => {
    localStorage.setItem(
      'drone-sim:instructor-access-hash:v1',
      hashInstructorAccessCode('EXISTING-SCHOOL'),
    )
    const result = await unlockWithInstructorAccessCode('wrong')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/Invalid instructor access code/)
  })

  it('provisions the first typed code when nothing is configured', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    const code = 'FIRST-CODE'
    const result = await unlockWithInstructorAccessCode(code)
    expect(result).toEqual({ ok: true })
    expect(readDeviceInstructorAccessHash()).toBe(hashInstructorAccessCode(code))
  })

  it('verifies against the LAN relay when the server already has a digest', async () => {
    const code = 'LAN-SCHOOL'
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ configured: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response)

    const result = await unlockWithInstructorAccessCode(code)
    expect(result).toEqual({ ok: true })
    expect(readDeviceInstructorAccessHash()).toBe(hashInstructorAccessCode(code))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not keep a divergent local hash when LAN provision conflicts', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ configured: false }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ ok: false, error: 'already-configured' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false }),
      } as Response)

    const result = await unlockWithInstructorAccessCode('local-attempt')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/already set/)
    expect(readDeviceInstructorAccessHash()).toBeNull()
  })
})
