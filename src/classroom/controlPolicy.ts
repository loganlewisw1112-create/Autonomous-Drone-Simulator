import { validateInstructorCommand, type InstructorCommand } from '@/classroom/commandRegistry'
import type { OperatorRole, SimSpeed } from '@/types'

export type ControlPolicyId = 'student_led' | 'command_guided' | 'observe_only' | 'accelerated_drill'

export interface ClassroomControlPolicy {
  id: ControlPolicyId
  label: string
  description: string
  operatorRole: OperatorRole
  simSpeed: SimSpeed
}

export const CONTROL_POLICY_PRESETS: Readonly<Record<ControlPolicyId, ClassroomControlPolicy>> = {
  student_led: {
    id: 'student_led',
    label: 'Student led',
    description: 'Full pilot controls at real-time speed.',
    operatorRole: 'pic',
    simSpeed: 1,
  },
  command_guided: {
    id: 'command_guided',
    label: 'Command guided',
    description: 'Mission-command controls at real-time speed.',
    operatorRole: 'mission_commander',
    simSpeed: 1,
  },
  observe_only: {
    id: 'observe_only',
    label: 'Observe only',
    description: 'Student controls are frozen for instructor demonstration.',
    operatorRole: 'observer',
    simSpeed: 1,
  },
  accelerated_drill: {
    id: 'accelerated_drill',
    label: 'Accelerated drill',
    description: 'Full pilot controls at five-times simulation speed.',
    operatorRole: 'pic',
    simSpeed: 5,
  },
}

export type PolicyCommandKind = 'set_operator_role' | 'set_sim_speed'
export type PolicyCommandIdFactory = (kind: PolicyCommandKind, index: number) => string

/** Pure, stable expansion. Class-wide application fans these same two commands to each student. */
export function commandsForPolicy(
  policy: ClassroomControlPolicy | ControlPolicyId,
  commandIdFactory: PolicyCommandIdFactory,
): InstructorCommand[] {
  const resolved = typeof policy === 'string' ? CONTROL_POLICY_PRESETS[policy] : policy
  const candidates: unknown[] = [
    {
      commandId: commandIdFactory('set_operator_role', 0),
      kind: 'set_operator_role',
      role: resolved.operatorRole,
    },
    {
      commandId: commandIdFactory('set_sim_speed', 1),
      kind: 'set_sim_speed',
      speed: resolved.simSpeed,
    },
  ]

  return candidates.map((candidate) => {
    const checked = validateInstructorCommand(candidate)
    if (!checked.ok) throw new Error(`Invalid control policy command: ${checked.message}`)
    return checked.command
  })
}
