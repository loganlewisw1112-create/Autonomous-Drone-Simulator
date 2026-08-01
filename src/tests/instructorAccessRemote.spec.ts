// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  provisionInstructorAccessRemote,
  unlockWithInstructorAccessCode,
} from '@/account/instructorAccessRemote'

describe('relay-authoritative instructor access', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('creates an HttpOnly relay session instead of trusting a browser-local hash', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ configured: true, authenticated: false }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response)

    await expect(unlockWithInstructorAccessCode('School Code 2026')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/instructor-access/session',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ code: 'School Code 2026' }),
      }),
    )
    expect(localStorage.getItem('drone-sim:instructor-access-hash:v1')).toBeNull()
  })

  it('reports invalid and rate-limited credentials without falling back locally', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ configured: true, authenticated: false }),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 429 } as Response)

    const result = await unlockWithInstructorAccessCode('Incorrect Code 2026')
    expect(result).toEqual({ ok: false, error: 'Invalid instructor access code' })
  })

  it('fails closed when the relay has not been provisioned', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: false, authenticated: false }),
    } as Response)

    const result = await unlockWithInstructorAccessCode('First School Code')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/local administrator/)
  })

  it('never falls back to browser-local authority when no relay is reachable', async () => {
    const code = 'Hosted Showcase Code'
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    const result = await unlockWithInstructorAccessCode(code)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/relay unavailable/i)
  })

  it('requires the process administrator token for provisioning', async () => {
    await expect(provisionInstructorAccessRemote('School Code 2026')).resolves.toBe('unauthorized')
    expect(fetch).not.toHaveBeenCalled()

    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 201 } as Response)
    await expect(
      provisionInstructorAccessRemote('School Code 2026', 'ADMIN'),
    ).resolves.toBe('ok')
    expect(fetch).toHaveBeenCalledWith(
      '/api/instructor-access/provision',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-classroom-admin-token': 'ADMIN' }),
      }),
    )
  })
})
