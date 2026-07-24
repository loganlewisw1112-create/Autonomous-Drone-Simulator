import { describe, expect, it, vi } from 'vitest'
import {
  buildProbeCandidateList,
  CLASSROOM_SERVER_PROMPT_SESSION_KEY,
  isClassroomServerPromptResolved,
  markClassroomServerPromptResolved,
  probeClassroomRelay,
  probeClassroomRelayAt,
} from '@/classroom/serverProbe'

describe('classroom serverProbe (web)', () => {
  it('orders probe candidates: configured → LAN origin → localhost → hosted origin last', () => {
    expect(
      buildProbeCandidateList({
        configuredBase: 'http://10.0.0.5:8080/',
        locationOrigin: 'http://192.168.1.20:8080',
      }),
    ).toEqual([
      'http://10.0.0.5:8080',
      'http://192.168.1.20:8080',
      'http://127.0.0.1:8080',
      'http://localhost:8080',
    ])

    expect(
      buildProbeCandidateList({
        locationOrigin: 'https://autonomous-drone-simulator-classroom.vercel.app',
      }),
    ).toEqual([
      'http://127.0.0.1:8080',
      'http://localhost:8080',
      'https://autonomous-drone-simulator-classroom.vercel.app',
    ])
  })

  it('accepts only healthy classroom-relay responses', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, service: 'classroom-relay' }),
    }))
    await expect(
      probeClassroomRelayAt('http://127.0.0.1:8080', { fetchFn: fetchFn as never }),
    ).resolves.toEqual({ ok: true, baseUrl: 'http://127.0.0.1:8080' })

    const miss = vi.fn(async () => {
      throw new Error('down')
    })
    await expect(
      probeClassroomRelay({
        locationOrigin: 'https://example.vercel.app',
        fetchFn: miss as never,
        timeoutMs: 50,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'unreachable' })
    expect(miss.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('persists prompt resolution in session storage', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
    }
    expect(isClassroomServerPromptResolved(storage)).toBe(false)
    markClassroomServerPromptResolved(storage)
    expect(store.get(CLASSROOM_SERVER_PROMPT_SESSION_KEY)).toBe('1')
    expect(isClassroomServerPromptResolved(storage)).toBe(true)
  })
})
