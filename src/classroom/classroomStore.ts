import { create } from 'zustand'
import type { FullMissionFrame } from '@/types'
import type { StoredRunSummary } from '@/account/types'
import type { ClassConfig, ClassId, RosterEntry, StudentId } from '@/classroom/protocol'
import type { GridFrame } from '@/classroom/gridFrame'
import type { MissionAssessment } from '@/classroom/missionAssessment'
import type { InstructorCommand } from '@/classroom/commandRegistry'

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
  accountId?: string
  summary: StoredRunSummary
  assessment: MissionAssessment
  receivedAt: number
  /** True when this came from a mid-session snapshot, not a finalized mission. */
  incomplete?: boolean
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

export type ClassroomCommandStatus = 'pending' | 'acknowledged' | 'failed'

export interface ClassroomCommandRecord {
  commandId: string
  studentId: StudentId
  command: InstructorCommand
  actorId: string
  issuedAt: number
  status: ClassroomCommandStatus
}

export interface ClassroomCommandAck {
  commandId: string
  studentId: StudentId
  actorId: string
  ok: boolean
  code?: string
  message?: string
  affectedDroneIds: string[]
  receivedAt: number
}

export interface ClassroomIntervention {
  commandId: string
  command: InstructorCommand
  actorId: string
  label: string
  executedAt: number
}

export interface TakeoverNotice extends ClassroomIntervention {
  expiresAt: number
}

interface ClassroomStore {
  role: ClassroomRole
  status: ClassroomStatus
  error: string | null
  classId: ClassId | null
  config: ClassConfig | null
  /** Durable instructor classroom (Phase 2). Live classId is separate. */
  activeClassroomId: string | null
  sessionStartedAt: number | null

  // Instructor view
  roster: RosterEntry[]
  frames: Record<StudentId, GridFrame> // latest grid frame per student only
  focusedStudentId: StudentId | null
  focusFrame: FullMissionFrame | null
  focusAssessment: MissionAssessment | null
  runs: ClassRunResult[]
  /** Students who left mid-session — retained for end-of-class archive. */
  departedStudents: import('@/account/classroomTypes').StudentSessionArchiveEntry[]
  integrity: IntegrityCounters
  commands: ClassroomCommandRecord[]
  commandAcks: ClassroomCommandAck[]

  // Student view
  studentId: StudentId | null
  beingFocused: boolean
  interventions: ClassroomIntervention[]
  takeoverNotice: TakeoverNotice | null
  commandRejects: number

  setStatus: (status: ClassroomStatus, error?: string | null) => void
  setActiveClassroomId: (classroomId: string | null) => void
  setInstructorClass: (classId: ClassId, config: ClassConfig) => void
  setStudentJoined: (classId: ClassId, studentId: StudentId, config: ClassConfig) => void
  setRoster: (roster: RosterEntry[]) => void
  setFrame: (studentId: StudentId, frame: GridFrame) => void
  removeStudent: (studentId: StudentId) => void
  rememberDeparted: (entry: import('@/account/classroomTypes').StudentSessionArchiveEntry) => void
  setFocused: (studentId: StudentId | null) => void
  setFocusFrame: (frame: FullMissionFrame | null, assessment?: MissionAssessment | null) => void
  setBeingFocused: (focused: boolean) => void
  addRun: (run: ClassRunResult) => void
  noteIntegrityFailure: (kind: 'decrypt' | 'replay') => void
  addCommand: (command: ClassroomCommandRecord) => void
  addCommandAck: (ack: ClassroomCommandAck) => void
  addIntervention: (intervention: ClassroomIntervention) => void
  showTakeover: (notice: TakeoverNotice) => void
  clearTakeover: (commandId?: string) => void
  noteCommandReject: () => void
  reset: () => void
}

const initial = {
  role: 'idle' as ClassroomRole,
  status: 'idle' as ClassroomStatus,
  error: null,
  classId: null,
  config: null,
  activeClassroomId: null as string | null,
  sessionStartedAt: null as number | null,
  roster: [] as RosterEntry[],
  frames: {} as Record<StudentId, GridFrame>,
  focusedStudentId: null,
  focusFrame: null,
  focusAssessment: null,
  runs: [] as ClassRunResult[],
  departedStudents: [] as import('@/account/classroomTypes').StudentSessionArchiveEntry[],
  integrity: { decryptFailures: 0, replayRejects: 0, lastAt: null } as IntegrityCounters,
  commands: [] as ClassroomCommandRecord[],
  commandAcks: [] as ClassroomCommandAck[],
  studentId: null,
  beingFocused: false,
  interventions: [] as ClassroomIntervention[],
  takeoverNotice: null as TakeoverNotice | null,
  commandRejects: 0,
}

export const useClassroomStore = create<ClassroomStore>((set, get) => ({
  ...initial,

  setStatus: (status, error = null) => set({ status, error }),

  setActiveClassroomId: (classroomId) => set({ activeClassroomId: classroomId }),

  setInstructorClass: (classId, config) => set({
    role: 'instructor', status: 'live', classId, config, sessionStartedAt: Date.now(),
  }),

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

  rememberDeparted: (entry) => set((s) => ({
    departedStudents: [...s.departedStudents.filter((d) => d.studentId !== entry.studentId), entry],
  })),

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

  addCommand: (command) => set((s) => ({ commands: [...s.commands, command] })),

  addCommandAck: (ack) => set((s) => ({
    commandAcks: [...s.commandAcks, ack],
    commands: s.commands.map((command) => command.commandId === ack.commandId && command.studentId === ack.studentId
      ? { ...command, status: ack.ok ? 'acknowledged' : 'failed' }
      : command),
  })),

  addIntervention: (intervention) => set((s) => ({ interventions: [...s.interventions, intervention] })),

  showTakeover: (takeoverNotice) => set({ takeoverNotice }),

  clearTakeover: (commandId) => set((s) => (
    !s.takeoverNotice || (commandId && s.takeoverNotice.commandId !== commandId)
      ? {}
      : { takeoverNotice: null }
  )),

  noteCommandReject: () => set((s) => ({ commandRejects: s.commandRejects + 1 })),

  reset: () => {
    const classroomId = get().activeClassroomId
    set({ ...initial, activeClassroomId: classroomId })
  },
}))
