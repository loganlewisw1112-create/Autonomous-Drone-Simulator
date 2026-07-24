/**
 * Routing into the classroom build.
 *
 * This decision used to live inline in main.tsx, which calls createRoot() on import and so can
 * never be imported by a spec — it was untestable by construction, and that is how the bare
 * `?join=` bug shipped: the gate tested `params.get('join')` for truthiness, so `?join=` with no
 * code fell through to the ordinary simulator and JoinGate's code field was unreachable unless
 * the URL already carried a code. On a LAN, where the instructor reads a 6-character code aloud
 * and nothing hands students a pre-filled link, that was the whole student on-ramp.
 *
 * A later regression: classroom-enabled bare `/` also fell through to the Ops Center, so the
 * dedicated classroom Vercel URL looked identical to the Windows deploy. Home is now a chooser.
 */
import { describe, expect, it } from 'vitest'
import { resolveClassroomRoute } from '@/platform/classroomRoute'

describe('resolveClassroomRoute', () => {
  it('renders the ordinary app when the build flag is off, whatever the URL says', () => {
    for (const search of ['', '?join=ABC123', '?coordinator=1', '?join=', '?app=1']) {
      expect(resolveClassroomRoute(search, false), search).toEqual({ kind: 'app' })
    }
  })

  it('opens the classroom home chooser on a bare load of the classroom build', () => {
    expect(resolveClassroomRoute('', true)).toEqual({ kind: 'classroom', mode: 'home' })
    expect(resolveClassroomRoute('?utm_source=x', true)).toEqual({ kind: 'classroom', mode: 'home' })
    expect(resolveClassroomRoute('?coordinator=0', true)).toEqual({ kind: 'classroom', mode: 'home' })
    expect(resolveClassroomRoute('?coordinator=true', true)).toEqual({ kind: 'classroom', mode: 'home' })
  })

  it('keeps ?app=1 as an escape hatch to the ordinary Ops Center', () => {
    expect(resolveClassroomRoute('?app=1', true)).toEqual({ kind: 'app' })
    expect(resolveClassroomRoute('?app=1&join=ABC123', true)).toEqual({ kind: 'app' })
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

  it('prefers the instructor console when both params are present', () => {
    // An instructor console mis-rendered as a student is the worse failure of the two.
    expect(resolveClassroomRoute('?join=ABC123&coordinator=1', true)).toEqual({
      kind: 'classroom', mode: 'instructor',
    })
  })
})
