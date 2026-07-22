import { create } from 'zustand'
import type { FullMissionFrame } from '@/types'
import type { StoredRunSummary } from '@/account/types'
import type { ClassConfig, ClassId, RosterEntry, StudentId } from '@/classroom/protocol'
import type { GridFrame } from '@/classroom/gridFrame'

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
  receivedAt: number
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
  runs: ClassRunResult[]

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
  setFocusFrame: (frame: FullMissionFrame | null) => void
  setBeingFocused: (focused: boolean) => void
  addRun: (run: ClassRunResult) => void
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
  runs: [] as ClassRunResult[],
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
    return {
      roster: s.roster.filter((r) => r.studentId !== studentId),
      frames, focusedStudentId, focusFrame,
    }
  }),

  setFocused: (studentId) => set((s) => ({
    focusedStudentId: studentId,
    focusFrame: studentId === null ? null : s.focusFrame,
  })),

  setFocusFrame: (frame) => set({ focusFrame: frame }),

  setBeingFocused: (focused) => set({ beingFocused: focused }),

  addRun: (run) => set((s) => ({
    // Keep only the newest submission per student — a re-flight supersedes the prior run.
    runs: [...s.runs.filter((r) => r.studentId !== run.studentId), run],
  })),

  reset: () => set({ ...initial }),
}))
