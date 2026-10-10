import { getRelayDiagnostics } from '@/classroom/classroomClient'
import { useClassroomStore } from '@/classroom/classroomStore'
import { probeClassroomRelayAt } from '@/classroom/serverProbe'
import type { DebugCommand } from '@/debug/types'

// Classroom relay diagnostics for the admin debug console. Read-only: nothing here sends a
// protocol message or changes the session. Protocol v3 has no ping/pong, so `relay ping` times
// the relay's /api/health document.
//
// Lives under src/classroom (not src/debug/commands) so the mobile and Windows import graphs never
// reach the relay client: ClassroomEntry registers this pack, and only the classroom edition
// loads ClassroomEntry (classroomBundleGuard.spec enforces this).

const SUBCOMMANDS = ['status', 'students', 'ping', 'errors'] as const

function inClass(): boolean {
  return useClassroomStore.getState().role !== 'idle'
}

function formatAt(ms: number | null | undefined): string {
  return typeof ms === 'number' ? new Date(ms).toLocaleTimeString() : 'never'
}

export const classroomDebugCommands: DebugCommand[] = [
  {
    name: 'relay',
    group: 'classroom',
    summary: 'Classroom relay diagnostics: status, students, ping, errors.',
    usage: 'relay status|students|ping|errors',
    run: async ({ args, print }) => {
      const sub = (args[0] ?? 'status').toLowerCase()
      const diag = getRelayDiagnostics()
      const cls = useClassroomStore.getState()
      switch (sub) {
        case 'status': {
          if (!inClass()) print('Not in a classroom session on this device.', 'warn')
          print(`role       ${cls.role}`)
          print(`status     ${cls.status}`)
          print(`class      ${cls.classId ?? diag.classId ?? '(none)'}`)
          print(`socket     ${diag.socket}`)
          print(`relay      ${diag.wsUrl || '(no relay URL)'}`)
          print(`protocol   v${diag.protocolVersion}`)
          print(`last close ${formatAt(diag.lastCloseAt)}`)
          print(`errors     ${diag.errors.length} recent`)
          return
        }
        case 'students': {
          if (cls.role !== 'instructor') { print('Only the instructor sees the roster. This device is not running a class.', 'warn'); return }
          print(`${cls.roster.length} student(s) connected`)
          for (const s of cls.roster) print(`${s.studentId.padEnd(10)} ${s.displayName}  joined ${formatAt(s.joinedAt)}`)
          return
        }
        case 'ping': {
          if (!diag.httpBase) { print('No relay address to ping in this environment.', 'warn'); return }
          const started = performance.now()
          const result = await probeClassroomRelayAt(diag.httpBase)
          const ms = Math.round(performance.now() - started)
          if (result.ok) print(`${diag.httpBase}/api/health answered in ${ms} ms.`, 'info')
          else print(`${diag.httpBase} did not answer (${result.reason}) after ${ms} ms.`, 'err')
          return
        }
        case 'errors': {
          if (diag.errors.length === 0) { print('No relay errors recorded.'); return }
          for (const e of diag.errors) print(`${formatAt(e.at)} [${e.source}] ${e.message}`, 'err')
          return
        }
        default:
          throw new Error(`Usage: relay ${SUBCOMMANDS.join('|')}`)
      }
    },
    complete: (args) => (args.length <= 1 ? SUBCOMMANDS.filter((c) => c.startsWith((args[0] ?? '').toLowerCase())) : []),
  },
]
