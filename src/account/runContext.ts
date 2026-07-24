/** Tiny cross-feature seam: classroom sets this; runRecorder reads it. No classroom imports. */
let classroomTag: { classId?: string; classroomId?: string } | null = null

export function setClassroomRunTag(tag: { classId?: string; classroomId?: string } | null): void {
  classroomTag = tag
}

export function getClassroomRunTag(): { classId?: string; classroomId?: string } | null {
  return classroomTag
}
