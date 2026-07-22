/**
 * Routing into the classroom build.
 *
 * This decision used to live inline in main.tsx, which calls createRoot() on import and so can
 * never be imported by a spec — it was untestable by construction, and that is how the bare
 * `?join=` bug shipped: the gate tested `params.get('join')` for truthiness, so `?join=` with no
 * code fell through to the ordinary simulator and JoinGate's code field was unreachable unless
 * the URL already carried a code. On a LAN, where the instructor reads a 6-character code aloud
 * and nothing hands students a pre-filled link, that was the whole student on-ramp.
 */
import { describe, expect, it } from 'vitest'
import { resolveClassroomRoute } from '@/platform/classroomRoute'

describe('resolveClassroomRoute', () => {
  it('renders the ordinary app when the build flag is off, whatever the URL says', () => {
    for (const search of ['', '?join=ABC123', '?coordinator=1', '?join=']) {
      expect(resolveClassroomRoute(search, false), search).toEqual({ kind: 'app' })
    }
  })

  it('renders the ordinary app on a normal load of the classroom build', () => {
    expect(resolveClassroomRoute('', true)).toEqual({ kind: 'app' })
    expect(resolveClassroomRoute('?utm_source=x', true)).toEqual({ kind: 'app' })
  })

  it('sends ?join=<CODE> to the student flow with the code prefilled', () => {
    expect(resolveClassroomRoute('?join=ABC123', true)).toEqual({
      kind: 'classroom', mode: 'student', initialClassId: 'ABC123',
    })
  })

  it('sends a bare ?join= to the student flow with an empty code field', () => {
    // The regression. Presence must open the JoinGate so the student can type the code.
    expect(resolveClassroomRoute('?join=', true)).toEqual({
      kind: 'classroom', mode: 'student', initialClassId: undefined,
    })
  })

  it('sends ?coordinator=1 to the instructor console', () => {
    expect(resolveClassroomRoute('?coordinator=1', true)).toEqual({
      kind: 'classroom', mode: 'instructor',
    })
  })

  it('ignores a coordinator param that is not exactly 1', () => {
    expect(resolveClassroomRoute('?coordinator=true', true)).toEqual({ kind: 'app' })
    expect(resolveClassroomRoute('?coordinator=0', true)).toEqual({ kind: 'app' })
  })

  it('prefers the instructor console when both params are present', () => {
    // An instructor console mis-rendered as a student is the worse failure of the two.
    expect(resolveClassroomRoute('?join=ABC123&coordinator=1', true)).toEqual({
      kind: 'classroom', mode: 'instructor',
    })
  })
})
