import { CLASSROOM_INTERVENTION_ACTOR_PREFIX } from '@/classroom/commandAttribution'
import { endMission, startSimLoop, stopTicking } from '@/sim/SimulationLoop'
import { MAX_WAYPOINTS_PER_DRONE } from '@/sim/mission/routeLimits'
import { useDroneStore } from '@/store/droneStore'
import type { LatLng, OperatorRole, OperatorRouteCommand, SimSpeed, Waypoint } from '@/types'

const ROUTE_COMMANDS = [
  'deep_scan', 'street_sweep', 'perimeter_orbit', 'expanding_search', 'standoff_observe', 'route_lkl',
] as const satisfies readonly OperatorRouteCommand[]
const ROLES = ['pic', 'mission_commander', 'observer'] as const satisfies readonly OperatorRole[]
const SIM_SPEEDS = [1, 5, 10, 20] as const satisfies readonly SimSpeed[]

interface CommandBase { commandId: string }

export type InstructorCommand =
  | (CommandBase & { kind: 'pause' | 'resume_session' | 'end_mission' | 'restart' | 'rtb_all' | 'hold_all' | 'retask_fleet' | 'undo_retask' })
  | (CommandBase & { kind: 'hover' | 'resume' | 'rtb' | 'remote_land' | 'abort_recovery'; droneId: string })
  | (CommandBase & { kind: 'command_route'; droneId: string; routeCommand: typeof ROUTE_COMMANDS[number]; center?: LatLng })
  | (CommandBase & { kind: 'set_route'; droneId: string; waypoints: Waypoint[] })
  | (CommandBase & { kind: 'set_operator_role'; role: OperatorRole })
  | (CommandBase & { kind: 'set_sim_speed'; speed: SimSpeed })
  | (CommandBase & { kind: 'directive'; text: string })
  | (CommandBase & { kind: 'reposition_site'; siteId: string; position: LatLng })

export type CommandValidation =
  | { ok: true; command: InstructorCommand }
  | { ok: false; code: 'malformed' | 'unknown_command'; message: string }

export type CommandExecution =
  | { ok: true; commandId: string; affectedDroneIds: string[] }
  | { ok: false; commandId: string; code: 'invalid_state' | 'unknown_drone' | 'rejected'; message: string }

export function validateInstructorCommand(value: unknown): CommandValidation {
  if (!isRecord(value) || !isCommandId(value.commandId) || typeof value.kind !== 'string') {
    return invalid('malformed', 'Command must include a valid commandId and kind.')
  }
  const base = { commandId: value.commandId }
  switch (value.kind) {
    case 'pause': case 'resume_session': case 'end_mission': case 'restart':
    case 'rtb_all': case 'hold_all': case 'retask_fleet': case 'undo_retask':
      return only(value, ['commandId', 'kind'])
        ? { ok: true, command: { ...base, kind: value.kind } }
        : invalid('malformed', 'Command contains unsupported fields.')
    case 'hover': case 'resume': case 'rtb': case 'remote_land': case 'abort_recovery':
      return only(value, ['commandId', 'kind', 'droneId']) && isId(value.droneId)
        ? { ok: true, command: { ...base, kind: value.kind, droneId: value.droneId } }
        : invalid('malformed', 'Drone command requires a valid droneId.')
    case 'command_route': {
      if (!only(value, ['commandId', 'kind', 'droneId', 'routeCommand', 'center'])
        || !isId(value.droneId) || !includes(ROUTE_COMMANDS, value.routeCommand)
        || (value.center !== undefined && !isLatLng(value.center))) {
        return invalid('malformed', 'Route command payload is invalid.')
      }
      return { ok: true, command: { ...base, kind: value.kind, droneId: value.droneId, routeCommand: value.routeCommand, ...(value.center ? { center: value.center } : {}) } }
    }
    case 'set_route':
      return only(value, ['commandId', 'kind', 'droneId', 'waypoints'])
        && isId(value.droneId) && isWaypoints(value.waypoints)
        ? { ok: true, command: { ...base, kind: value.kind, droneId: value.droneId, waypoints: value.waypoints } }
        : invalid('malformed', `Route must contain at most ${MAX_WAYPOINTS_PER_DRONE} valid waypoints.`)
    case 'set_operator_role':
      return only(value, ['commandId', 'kind', 'role']) && includes(ROLES, value.role)
        ? { ok: true, command: { ...base, kind: value.kind, role: value.role } }
        : invalid('malformed', 'Operator role is invalid.')
    case 'set_sim_speed':
      return only(value, ['commandId', 'kind', 'speed']) && includes(SIM_SPEEDS, value.speed)
        ? { ok: true, command: { ...base, kind: value.kind, speed: value.speed } }
        : invalid('malformed', 'Simulation speed is invalid.')
    case 'directive':
      return only(value, ['commandId', 'kind', 'text']) && typeof value.text === 'string'
        && value.text.trim().length > 0 && value.text.length <= 500
        ? { ok: true, command: { ...base, kind: value.kind, text: value.text.trim() } }
        : invalid('malformed', 'Directive text must be 1-500 characters.')
    case 'reposition_site':
      return only(value, ['commandId', 'kind', 'siteId', 'position']) && isId(value.siteId) && isLatLng(value.position)
        ? { ok: true, command: { ...base, kind: value.kind, siteId: value.siteId, position: value.position } }
        : invalid('malformed', 'Site reposition payload is invalid.')
    default:
      return invalid('unknown_command', `Unknown command kind: ${value.kind}`)
  }
}

export function executeInstructorCommand(
  command: InstructorCommand,
  context: { actorSessionId: string },
): CommandExecution {
  const state = useDroneStore.getState()
  const actorId = `${CLASSROOM_INTERVENTION_ACTOR_PREFIX}${context.actorSessionId}`
  const droneId = 'droneId' in command ? command.droneId : null
  if (droneId && !state.drones.some((drone) => drone.id === droneId)) {
    return failed(command, 'unknown_drone', `Unknown drone: ${droneId}`)
  }

  return state.withCommandActor(actorId, () => {
    switch (command.kind) {
      case 'hover': state.hoverDrone(command.droneId); return success(command, [command.droneId])
      case 'resume': state.resumeDrone(command.droneId); return success(command, [command.droneId])
      case 'rtb': state.returnDroneToBase(command.droneId); return success(command, [command.droneId])
      case 'remote_land': state.remoteLandDrone(command.droneId); return success(command, [command.droneId])
      case 'abort_recovery': state.abortRecovery(command.droneId); return success(command, [command.droneId])
      case 'command_route':
        return state.commandDroneRoute(command.droneId, command.routeCommand, command.center)
          ? success(command, [command.droneId]) : failed(command, 'rejected', 'Simulator route guards rejected the command.')
      case 'set_route':
        return state.setDroneRoute(command.droneId, command.waypoints)
          ? success(command, [command.droneId]) : failed(command, 'rejected', 'Simulator route guards rejected the route.')
      case 'pause':
        if (state.lifecycle !== 'running') return failed(command, 'invalid_state', 'Mission is not running.')
        state.setRunning(false); stopTicking(); state.setLifecycle('paused'); record(actorId, command.kind)
        return success(command, state.drones.map((drone) => drone.id))
      case 'resume_session':
        if (state.lifecycle !== 'paused') return failed(command, 'invalid_state', 'Mission is not paused.')
        state.setRunning(true); state.setLifecycle('running'); startSimLoop(); record(actorId, command.kind)
        return success(command, state.drones.map((drone) => drone.id))
      case 'end_mission':
        if (!['running', 'paused'].includes(state.lifecycle)) return failed(command, 'invalid_state', 'Mission is not active.')
        record(actorId, command.kind); endMission(); return success(command, state.drones.map((drone) => drone.id))
      case 'restart':
        stopTicking(); state.setRunning(false); state.resetMission(); record(actorId, command.kind)
        return success(command, state.drones.map((drone) => drone.id))
      case 'rtb_all': {
        const affected = activeDroneIds()
        affected.forEach((id) => useDroneStore.getState().returnDroneToBase(id))
        return success(command, affected)
      }
      case 'hold_all': {
        const affected = activeDroneIds()
        affected.forEach((id) => useDroneStore.getState().hoverDrone(id))
        return success(command, affected)
      }
      case 'retask_fleet': {
        const result = state.retaskFleet()
        return result.changedDroneIds.length > 0
          ? success(command, result.changedDroneIds)
          : failed(command, 'rejected', result.message ?? 'No fleet routes were changed.')
      }
      case 'undo_retask':
        return state.undoFleetRetask() ? success(command, state.drones.map((drone) => drone.id))
          : failed(command, 'rejected', 'No fleet retask is available to undo.')
      case 'set_operator_role':
        state.setOperatorRole(command.role); record(actorId, command.kind, { role: command.role })
        return success(command, [])
      case 'set_sim_speed':
        state.setSimSpeed(command.speed); record(actorId, command.kind, { speed: command.speed })
        return success(command, [])
      case 'directive':
        record(actorId, command.kind, { text: command.text }); return success(command, [])
      case 'reposition_site': {
        const result = state.repositionLaunchSite(command.siteId, command.position)
        return result.ok ? success(command, result.affectedDrones)
          : failed(command, 'rejected', result.reason ?? result.message)
      }
    }
  })
}

function activeDroneIds(): string[] {
  return useDroneStore.getState().drones
    .filter((drone) => !['idle', 'landed', 'remote_landed', 'recovered', 'unrecoverable_sim'].includes(drone.missionState))
    .map((drone) => drone.id)
}

function record(actorId: string, command: string, payload: Record<string, unknown> = {}): void {
  const state = useDroneStore.getState()
  state.emitEvent({
    eventType: 'operator_command',
    droneId: state.drones[0]?.id ?? 'class-session',
    operatorId: actorId,
    role: state.operatorRole,
    payload: { command, ...payload },
  })
}

function success(command: InstructorCommand, affectedDroneIds: string[]): CommandExecution {
  return { ok: true, commandId: command.commandId, affectedDroneIds }
}

function failed(command: Pick<InstructorCommand, 'commandId'>, code: 'invalid_state' | 'unknown_drone' | 'rejected', message: string): CommandExecution {
  return { ok: false, commandId: command.commandId, code, message }
}

function invalid(code: 'malformed' | 'unknown_command', message: string): CommandValidation {
  return { ok: false, code, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function isCommandId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function isLatLng(value: unknown): value is LatLng {
  if (!isRecord(value) || !only(value, ['lat', 'lng'])) return false
  return typeof value.lat === 'number' && Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90
    && typeof value.lng === 'number' && Number.isFinite(value.lng) && value.lng >= -180 && value.lng <= 180
}

function isWaypoints(value: unknown): value is Waypoint[] {
  return Array.isArray(value) && value.length <= MAX_WAYPOINTS_PER_DRONE && value.every((waypoint) => (
    isRecord(waypoint)
    && only(waypoint, ['id', 'position', 'altitudeFt', 'label', 'dwellTimeSec'])
    && isId(waypoint.id)
    && isLatLng(waypoint.position)
    && typeof waypoint.altitudeFt === 'number' && Number.isFinite(waypoint.altitudeFt)
    && (waypoint.label === undefined || typeof waypoint.label === 'string')
    && (waypoint.dwellTimeSec === undefined || (typeof waypoint.dwellTimeSec === 'number' && Number.isFinite(waypoint.dwellTimeSec) && waypoint.dwellTimeSec >= 0))
  ))
}

function includes<const T extends readonly unknown[]>(values: T, value: unknown): value is T[number] {
  return values.includes(value as never)
}
