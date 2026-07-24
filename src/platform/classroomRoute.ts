// Which root the app renders for a given URL, when the classroom build flag is on.
//
// Lives in src/platform/ (next to appTarget.ts), NOT in src/classroom/. main.tsx imports this
// statically, and a static import reaching into src/classroom/ would pull that module — and its
// WebSocket client — into the base bundle, defeating the tree-shaking the whole feature flag
// exists for (COORDINATOR_BUILD_PLAN §7, asserted by scripts/assert-bundle-isolation.mjs).
//
// Extracted so the decision is testable at all: it previously lived inline in main.tsx, which
// calls createRoot() on import and therefore cannot be imported by a spec. That is precisely how
// the bare-`?join=` bug below survived.

export type ClassroomRoute =
  | { kind: 'app' }
  | { kind: 'classroom'; mode: 'home' | 'instructor' | 'student'; initialClassId?: string }

/**
 * @param search `location.search`, e.g. `?join=ABC123`
 * @param enabled whether the build carries VITE_CLASSROOM_ENABLED
 */
export function resolveClassroomRoute(search: string, enabled: boolean): ClassroomRoute {
  if (!enabled) return { kind: 'app' }

  const params = new URLSearchParams(search)
  // Maintainer escape hatch: classroom builds still need a way to open the ordinary Ops Center
  // (LAN smoke of the shared App shell without instructor/student chrome).
  if (params.get('app') === '1') return { kind: 'app' }

  const coordinator = params.get('coordinator') === '1'
  // Presence, not truthiness. `?join=` with no code is how a student reaches the JoinGate to
  // type a code read aloud — the normal LAN flow, since nothing hands them a pre-filled link.
  const hasJoin = params.has('join')

  // ?coordinator=1 wins if somehow both are present: an instructor console mis-rendered as a
  // student is a far worse failure than the reverse.
  if (coordinator) return { kind: 'classroom', mode: 'instructor' }
  if (hasJoin) {
    const code = params.get('join') || undefined
    return { kind: 'classroom', mode: 'student', initialClassId: code }
  }

  // Dedicated classroom deploys (and `npm run classroom`) open on `/` with no params. That used
  // to fall through to the ordinary desktop Ops Center, which made the classroom Vercel URL look
  // identical to the Windows build. Home is a chooser — no WebSocket until the user picks a role.
  return { kind: 'classroom', mode: 'home' }
}
