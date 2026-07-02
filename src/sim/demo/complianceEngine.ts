import type {
  AirspaceAuthorization,
  ComplianceFlag,
  ComplianceState,
  DroneState,
  ScenarioConfig,
  ScenarioVariantConfig,
} from '@/types'

interface BuildComplianceStateInput {
  scenario: ScenarioConfig | null
  drones: DroneState[]
  scenarioVariant: ScenarioVariantConfig
  elapsedSec: number
}

const SIM_DISCLAIMER = 'simulation-only compliance readiness for investor demo use; no real FAA, LAANC, USS, or drone broadcast integration is performed.'

export function buildComplianceState(input: BuildComplianceStateInput): ComplianceState {
  const degradedDroneIds = input.drones
    .filter((drone) => drone.signalDbm <= -90 || drone.bvlosFlag)
    .map((drone) => drone.id)
  const broadcastingDroneIds = input.drones
    .filter((drone) => drone.signalDbm > -90)
    .map((drone) => drone.id)
  const maxObservedAltitudeFt = input.drones.reduce((max, drone) => Math.max(max, drone.altitudeFt), 0)
  const authorization = buildAuthorization(input.scenario)
  const waiverFlags = buildWaiverFlags(input, maxObservedAltitudeFt)

  return {
    remoteId: {
      status: input.drones.length === 0
        ? 'offline'
        : degradedDroneIds.length > 0 ? 'degraded' : 'broadcasting',
      broadcastingDroneIds,
      degradedDroneIds,
    },
    airspace: {
      authorization: {
        ...authorization,
        status: waiverFlags.some((flag) => flag.severity === 'critical') ? 'blocked'
          : waiverFlags.length > 0 ? 'attention'
          : authorization.status,
      },
      maxObservedAltitudeFt,
    },
    waiverFlags,
    checklist: [
      {
        kind: 'remote_id',
        severity: degradedDroneIds.length > 0 ? 'advisory' : 'routine',
        label: 'Remote ID broadcast',
        detail: degradedDroneIds.length > 0
          ? `${degradedDroneIds.length} simulated broadcast links degraded.`
          : `${broadcastingDroneIds.length} simulated drones broadcasting.`
      },
      {
        kind: 'laanc',
        severity: authorization.status === 'ready' ? 'routine' : 'advisory',
        label: authorization.label,
        detail: authorization.reference,
      },
      ...waiverFlags,
    ],
    disclaimer: SIM_DISCLAIMER,
  }
}

function buildAuthorization(scenario: ScenarioConfig | null): AirspaceAuthorization {
  if (!scenario) {
    return {
      kind: 'not_required',
      status: 'attention',
      label: 'No active airspace request',
      reference: 'Load a scenario to derive simulated airspace readiness.',
    }
  }

  const text = `${scenario.id} ${scenario.name} ${scenario.description}`.toLowerCase()
  if (/urban|city|port|airport|harbor|coastal|pursuit|perimeter/.test(text)) {
    return {
      kind: 'simulated_laanc',
      status: 'ready',
      label: 'Simulated LAANC / USS authorization',
      reference: 'Authorization state is derived locally from scenario metadata and visible constraints.',
    }
  }

  if (/wildfire|fema|hurricane|usar|border|mountain|hazmat/.test(text)) {
    return {
      kind: 'field_incident_command',
      status: 'ready',
      label: 'Incident command airspace coordination',
      reference: 'Scenario assumes an incident command airspace cell with simulated UAS coordination.',
    }
  }

  return {
    kind: 'not_required',
    status: 'ready',
    label: 'Uncontrolled simulated airspace',
    reference: 'No controlled-airspace authorization is modeled for this scenario.',
  }
}

function buildWaiverFlags(input: BuildComplianceStateInput, maxObservedAltitudeFt: number): ComplianceFlag[] {
  const flags: ComplianceFlag[] = []
  const text = `${input.scenario?.id ?? ''} ${input.scenario?.name ?? ''} ${input.scenario?.description ?? ''}`.toLowerCase()

  if (maxObservedAltitudeFt > 400) {
    flags.push({
      kind: 'altitude_limit',
      severity: 'critical',
      label: 'Altitude limit attention',
      detail: `Max observed altitude is ${Math.round(maxObservedAltitudeFt)}ft AGL; demo should show mitigation below 400ft.`,
    })
  }

  if (input.drones.some((drone) => drone.signalDbm <= -90 || drone.bvlosFlag)) {
    flags.push({
      kind: 'bvlos',
      severity: 'urgent',
      label: 'BVLOS / command-link attention',
      detail: 'At least one drone has simulated command-link loss or BVLOS flag active.',
    })
  }

  if (input.scenarioVariant.timeOfDay === 'night') {
    flags.push({
      kind: 'night_ops',
      severity: 'advisory',
      label: 'Night operation readiness',
      detail: 'Night scenario requires simulated lighting, observer, and PIC approval checks.',
    })
  }

  if (/crowd|concert|stadium|city|urban|times square|hollywood/.test(text)) {
    flags.push({
      kind: 'operations_over_people',
      severity: 'advisory',
      label: 'Operations over people review',
      detail: 'Scenario includes populated-area risk; standoff and geofence controls should be highlighted.',
    })
  }

  return flags
}
