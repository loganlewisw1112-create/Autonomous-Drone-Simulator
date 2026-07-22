import { create } from 'zustand'
import type { FullMissionFrame } from '@/types'
import type { StoredRunSummary } from '@/account/types'
import type { ClassConfig, ClassId, RosterEntry, StudentId } from '@/classroom/protocol'
import type { GridFrame } from '@/classroom/gridFrame'
import type { MissionAssessment } from '@/classroom/missionAssessment'

// Instructor- and student-side view state for the classroom. Deliberately holds
// only serializable UI state and the LATEST frame per student — never frame
// history (that is what the end-of-run submission is for) and never the crypto
// keys (those live in classroomClient, outside any store). classroomClient writes
// here; the console/tiles read here. This store never imports the client, keeping
// the store ↔ side-effect boundary the codebase already enforces for runRecorder.

export type ClassroomRole = 'idle' | 'instructor' | 'student'
export type ClassroomStatus = 'idle' | 'connecting' | 'live' | 'closed' | 'error'

export interface ClassRunResult {
  studentId: StudentId
  displayName: string
  summary: StoredRunSummary
  assessment: MissionAssessment
  receivedAt: number
}

// Aggregate integrity signal for the instructor. Every decrypt site used to swallow
// its exception into an empty catch, which made a key mismatch, a hijacked room and a
// tampered frame all look exactly like "the wifi dropped" — the one failure mode an
// E2EE product cannot afford to render as silence. Counters, not per-frame logs: at
// 1 Hz × 40 students a broken key would otherwise bury the console.
export interface IntegrityCounters {
  decryptFailures: number // ciphertext that would not open under this student's session key
  replayRejects: number // opened fine, but repeated or rewound its sealed seq
  lastAt: number | null
}

interface ClassroomStore {
  role: ClassroomRole
  status: ClassroomStatus
  error: string | null
  classId: ClassId | null
  config: ClassConfig | null

  // Instructor view
  roster: RosterEntry[]
  frames: Record<StudentId, GridFrame> // latest grid frame per student only
  focusedStudentId: StudentId | null
  focusFrame: FullMissionFrame | null
  focusAssessment: MissionAssessment | null
  runs: ClassRunResult[]
  integrity: IntegrityCounters

  // Student view
  studentId: StudentId | null
  beingFocused: boolean

  setStatus: (status: ClassroomStatus, error?: string | null) => void
  setInstructorClass: (classId: ClassId, config: ClassConfig) => void
  setStudentJoined: (classId: ClassId, studentId: StudentId, config: ClassConfig) => void
  setRoster: (roster: RosterEntry[]) => void
  setFrame: (studentId: StudentId, frame: GridFrame) => void
  removeStudent: (studentId: StudentId) => void
  setFocused: (studentId: StudentId | null) => void
  setFocusFrame: (frame: FullMissionFrame | null, assessment?: MissionAssessment | null) => void
  setBeingFocused: (focused: boolean) => void
  addRun: (run: ClassRunResult) => void
  noteIntegrityFailure: (kind: 'decrypt' | 'replay') => void
  reset: () => void
}

const initial = {
  role: 'idle' as ClassroomRole,
  status: 'idle' as ClassroomStatus,
  error: null,
  classId: null,
  config: null,
  roster: [] as RosterEntry[],
  frames: {} as Record<StudentId, GridFrame>,
  focusedStudentId: null,
  focusFrame: null,
  focusAssessment: null,
  runs: [] as ClassRunResult[],
  integrity: { decryptFailures: 0, replayRejects: 0, lastAt: null } as IntegrityCounters,
  studentId: null,
  beingFocused: false,
}

export const useClassroomStore = create<ClassroomStore>((set) => ({
  ...initial,

  setStatus: (status, error = null) => set({ status, error }),

  setInstructorClass: (classId, config) => set({ role: 'instructor', status: 'live', classId, config }),

  setStudentJoined: (classId, studentId, config) =>
    set({ role: 'student', status: 'live', classId, studentId, config }),

  setRoster: (roster) => set((s) => {
    // Drop frames for students no longer on the roster so the wall never renders a ghost tile.
    const live = new Set(roster.map((r) => r.studentId))
    const frames: Record<StudentId, GridFrame> = {}
    for (const [id, f] of Object.entries(s.frames)) if (live.has(id)) frames[id] = f
    return { roster, frames }
  }),

  setFrame: (studentId, frame) => set((s) => ({ frames: { ...s.frames, [studentId]: frame } })),

  removeStudent: (studentId) => set((s) => {
    const frames = { ...s.frames }
    delete frames[studentId]
    const focusedStudentId = s.focusedStudentId === studentId ? null : s.focusedStudentId
    const focusFrame = s.focusedStudentId === studentId ? null : s.focusFrame
    const focusAssessment = s.focusedStudentId === studentId ? null : s.focusAssessment
    return {
      roster: s.roster.filter((r) => r.studentId !== studentId),
      frames, focusedStudentId, focusFrame, focusAssessment,
    }
  }),

  setFocused: (studentId) => set((s) => ({
    focusedStudentId: studentId,
    focusFrame: studentId !== null && studentId === s.focusedStudentId ? s.focusFrame : null,
    focusAssessment: studentId !== null && studentId === s.focusedStudentId ? s.focusAssessment : null,
  })),

  setFocusFrame: (frame, assessment = null) => set({ focusFrame: frame, focusAssessment: assessment }),

  setBeingFocused: (focused) => set({ beingFocused: focused }),

  addRun: (run) => set((s) => ({
    // Keep only the newest submission per student — a re-flight supersedes the prior run.
    // Safe only because classroomClient rejects a replayed seq before calling this; an
    // attacker re-injecting a captured student.run would otherwise overwrite a newer one.
    runs: [...s.runs.filter((r) => r.studentId !== run.studentId), run],
  })),

  // Replace the object rather than mutating it — `initial` is shared across reset()s.
  noteIntegrityFailure: (kind) => set((s) => ({
    integrity: {
      decryptFailures: s.integrity.decryptFailures + (kind === 'decrypt' ? 1 : 0),
      replayRejects: s.integrity.replayRejects + (kind === 'replay' ? 1 : 0),
      lastAt: Date.now(),
    },
  })),

  reset: () => set({ ...initial }),
}))
