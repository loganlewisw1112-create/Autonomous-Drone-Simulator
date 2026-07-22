import { beforeEach, describe, expect, it } from 'vitest'
import { CLASSROOM_INTERVENTION_ACTOR_PREFIX } from '@/classroom/commandAttribution'
import { executeInstructorCommand, validateInstructorCommand } from '@/classroom/commandRegistry'
import { commandsForPolicy, CONTROL_POLICY_PRESETS } from '@/classroom/controlPolicy'
import { useDroneStore } from '@/store/droneStore'

beforeEach(() => {
  useDroneStore.getState().resetMission()
  useDroneStore.getState().setOperatorRole('pic')
  useDroneStore.getState().setSimSpeed(1)
})

describe('classroom control policy presets', () => {
  it('expands a policy into the same validated commands in a stable order', () => {
    const commands = commandsForPolicy('observe_only', (kind, index) => `policy-${index}-${kind}`)

    expect(commands).toEqual([
      { commandId: 'policy-0-set_operator_role', kind: 'set_operator_role', role: 'observer' },
      { commandId: 'policy-1-set_sim_speed', kind: 'set_sim_speed', speed: 1 },
    ])
    commands.forEach((command) => expect(validateInstructorCommand(command)).toEqual({ ok: true, command }))
  })

  it('uses only role and speed controls that the simulator can enforce', () => {
    for (const policy of Object.values(CONTROL_POLICY_PRESETS)) {
      const commands = commandsForPolicy(policy, (kind, index) => `${policy.id}-${index}-${kind}`)
      expect(commands.map((command) => command.kind)).toEqual(['set_operator_role', 'set_sim_speed'])
    }
  })

  it('applies a policy with attributed evidence', () => {
    const commands = commandsForPolicy('accelerated_drill', (kind, index) => `apply-${index}-${kind}`)
    const results = commands.map((command) => executeInstructorCommand(command, { actorSessionId: '7KX3M2' }))

    expect(results.every((result) => result.ok)).toBe(true)
    expect(useDroneStore.getState().operatorRole).toBe('pic')
    expect(useDroneStore.getState().ui.simSpeed).toBe(5)
    expect(useDroneStore.getState().events.slice(-2).map((event) => event.operatorId)).toEqual([
      `${CLASSROOM_INTERVENTION_ACTOR_PREFIX}7KX3M2`,
      `${CLASSROOM_INTERVENTION_ACTOR_PREFIX}7KX3M2`,
    ])
  })

  it('fails closed when the command-id factory produces an invalid id', () => {
    expect(() => commandsForPolicy('student_led', () => 'bad id')).toThrow('Invalid control policy command')
  })
})
