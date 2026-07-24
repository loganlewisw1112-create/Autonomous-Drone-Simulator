import { describe, expect, it, vi } from 'vitest'
import {
  buildServerEnv,
  classroomBaseUrl,
  probeClassroomServer,
  spawnClassroomServer,
  stopClassroomServer,
  waitForClassroomServer,
} from '../../desktop/classroom/serverLifecycle.mjs'

describe('classroom serverLifecycle', () => {
  it('builds classroom base URL and Electron-as-Node env', () => {
    expect(classroomBaseUrl(8080)).toBe('http://127.0.0.1:8080')
    const withFlag = buildServerEnv({ PATH: '/x' }, { electronAsNode: true })
    expect(withFlag.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(withFlag.PATH).toBe('/x')
    const without = buildServerEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/x' }, { electronAsNode: false })
    expect(without.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('spawns the classroom script with the expected args', () => {
    const spawnFn = vi.fn(() => ({ pid: 42 }))
    spawnClassroomServer({
      command: 'node',
      scriptPath: 'server/classroom.mjs',
      args: ['8080'],
      cwd: '/repo',
      env: { A: '1' },
      spawnFn: spawnFn as never,
    })
    expect(spawnFn).toHaveBeenCalledWith(
      'node',
      ['server/classroom.mjs', '8080'],
      expect.objectContaining({
        cwd: '/repo',
        env: { A: '1' },
        windowsHide: true,
      }),
    )
  })

  it('probes health and accepts only classroom-relay bodies', async () => {
    const okFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, service: 'classroom-relay' }),
    }))
    await expect(
      probeClassroomServer('http://127.0.0.1:8080', { fetchFn: okFetch as never }),
    ).resolves.toEqual({ ok: true, baseUrl: 'http://127.0.0.1:8080' })
    expect(okFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/api/health',
      expect.objectContaining({ method: 'GET' }),
    )

    const badFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, service: 'other' }),
    }))
    await expect(
      probeClassroomServer('http://127.0.0.1:8080/', { fetchFn: badFetch as never }),
    ).resolves.toEqual({ ok: false, reason: 'unexpected-body' })

    const downFetch = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(
      probeClassroomServer('http://127.0.0.1:8080', { fetchFn: downFetch as never }),
    ).resolves.toEqual({ ok: false, reason: 'unreachable' })
  })

  it('waits until probe succeeds or times out', async () => {
    let n = 0
    const probe = vi.fn(async () => {
      n += 1
      if (n < 3) return { ok: false as const, reason: 'unreachable' }
      return { ok: true as const, baseUrl: 'http://127.0.0.1:8080' }
    })
    const sleep = vi.fn(async () => {})
    await expect(
      waitForClassroomServer('http://127.0.0.1:8080', {
        timeoutMs: 5_000,
        intervalMs: 1,
        probe: probe as never,
        sleep,
      }),
    ).resolves.toEqual({ ok: true, baseUrl: 'http://127.0.0.1:8080' })
    expect(probe).toHaveBeenCalledTimes(3)

    const alwaysDown = vi.fn(async () => ({ ok: false as const, reason: 'unreachable' }))
    const sleep2 = vi.fn(async () => {})
    // Fake clock via exhausting timeout quickly: timeoutMs 0 means one failed pass then stop
    await expect(
      waitForClassroomServer('http://127.0.0.1:9', {
        timeoutMs: 0,
        intervalMs: 1,
        probe: alwaysDown as never,
        sleep: sleep2,
      }),
    ).resolves.toMatchObject({ ok: false })
  })

  it('stops an owned child and treats already-dead as stopped', () => {
    expect(stopClassroomServer(null)).toEqual({ stopped: true, alreadyDead: true })
    expect(stopClassroomServer({ killed: true } as never)).toEqual({ stopped: true, alreadyDead: true })

    const killTreeFn = vi.fn()
    const child = { pid: 99, killed: false, exitCode: null }
    expect(
      stopClassroomServer(child as never, { platform: 'win32', killTreeFn }),
    ).toEqual({ stopped: true, alreadyDead: false })
    expect(killTreeFn).toHaveBeenCalledWith(99)

    const killFn = vi.fn()
    const unixChild = { pid: 7, killed: false, exitCode: null }
    expect(
      stopClassroomServer(unixChild as never, { platform: 'linux', killFn }),
    ).toEqual({ stopped: true, alreadyDead: false })
    expect(killFn).toHaveBeenCalledWith(unixChild, 'SIGTERM')
  })
})
