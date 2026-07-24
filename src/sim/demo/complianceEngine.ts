import { airspaceCeilingCaption, airspaceForScenario, plannedRoutePoints, worstCeilingBreach } from '@/sim/mission/airspace'
import { buildAuthorizationFromProfile } from '@/sim/mission/authorizationTraining'
import type {
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

const SIM_DISCLAIMER = 'simulation-only compliance readiness for demonstration use; no real FAA, LAANC, USS, or drone broadcast integration is performed.'

// Remote ID is an independent onboard broadcast (ASTM F3411): it keeps transmitting even when
// the C2 command link degrades or drops. Only a drone that is down/failed stops broadcasting —
// so RID status is derived from mission state, NOT from signalDbm. (C2-link health is still
// surfaced separately via the BVLOS waiver flag below.)
const RID_SILENT_STATES = new Set<DroneState['missionState']>([
  'idle', 'preflight', 'stranded', 'remote_landed', 'recovery_requested',
  'recovery_enroute', 'recovered', 'unrecoverable_sim',
])

export function buildComplianceState(input: BuildComplianceStateInput): ComplianceState {
  const broadcastingDroneIds = input.drones
    .filter((drone) => !RID_SILENT_STATES.has(drone.missionState))
    .map((drone) => drone.id)
  // A grounded/failed airframe is the only modeled way to lose the RID broadcast.
  const degradedDroneIds = input.drones
    .filter((drone) => ['stranded', 'unrecoverable_sim'].includes(drone.missionState))
    .map((drone) => drone.id)
  const maxObservedAltitudeFt = input.drones.reduce((max, drone) => Math.max(max, drone.altitudeFt), 0)
  const authorization = buildAuthorizationFromProfile(input.scenario)
  const waiverFlags = buildWaiverFlags(input, maxObservedAltitudeFt)
  const ceilingCaption = airspaceCeilingCaption(airspaceForScenario(input.scenario?.id))

  return {
    remoteId: {
      status: broadcastingDroneIds.length === 0
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
          ? `${degradedDroneIds.length} downed airframe(s) no longer broadcasting.`
          : `${broadcastingDroneIds.length} simulated airframes broadcasting (independent of C2 link).`
      },
      {
        kind: 'laanc',
        severity: authorization.status === 'ready' ? 'routine' : 'advisory',
        label: authorization.label,
        detail: authorization.reference,
      },
      // WP-3's acceptance criterion asks for MAP_EFF to be visible "so a stale fixture is
      // visible rather than silently wrong". Putting it on the checklist rather than only in
      // the panel means the edition date also travels into the exported after-action package,
      // which is where a reviewer would go looking for it months later.
      ...(ceilingCaption ? [{
        kind: 'laanc' as const,
        severity: 'routine' as const,
        label: 'Published UAS Facility Map ceilings',
        detail: `${ceilingCaption}. Real FAA published data; authorization remains simulated.`,
      }] : []),
      ...waiverFlags,
    ],
    disclaimer: SIM_DISCLAIMER,
  }
}

function buildWaiverFlags(input: BuildComplianceStateInput, maxObservedAltitudeFt: number): ComplianceFlag[] {
  const flags: ComplianceFlag[] = []
  const text = `${input.scenario?.id ?? ''} ${input.scenario?.name ?? ''} ${input.scenario?.description ?? ''}`.toLowerCase()
  const profile = input.scenario?.authorizationProfile

  if (maxObservedAltitudeFt > 400) {
    flags.push({
      kind: 'altitude_limit',
      severity: 'critical',
      label: 'Altitude limit attention',
      detail: `Max observed altitude is ${Math.round(maxObservedAltitudeFt)}ft AGL; demo should show mitigation below 400ft.`,
    })
  }

  // REALISM_ROADMAP WP-3 — the real published ceiling, not the blanket 400ft.
  //
  // The 400ft check above is Part 107's ceiling in the general case. Inside a charted facility
  // map the FAA publishes a *lower* automatic-authorisation ceiling per 30 x 30 arc-second cell,
  // and a route can sit comfortably under 400ft while still being above the ceiling actually
  // published for the ground it is over — Times Square's 260ft aviation relay sits over cells
  // published at 0ft. So the same existing Part 107 flag is raised against the published figure
  // wherever one exists.
  //
  // 'urgent', not 'critical', and deliberately: a published ceiling of 0 means "not
  // automatically authorisable via LAANC", not "flight is impossible" — the further-safety-
  // analysis path still exists, and these scenarios run under simulated incident-command
  // coordination. 'urgent' drives authorization.status to 'attention' (the roadmap's own word
  // for this criterion) rather than to 'blocked'. Scenarios with no published grid — 11 of the
  // 21 — produce no flag and behave bit-identically to pre-WP-3.
  //
  // Checked against the planned route as well as live telemetry: the criterion is that a
  // *route* exceeding the published ceiling is flagged, which means the operator is told before
  // launch rather than after the aircraft is already up there.
  const ceilingBreach = worstCeilingBreach(airspaceForScenario(input.scenario?.id), [
    ...input.drones.map((drone) => ({ position: drone.position, altitudeFt: drone.altitudeFt })),
    ...plannedRoutePoints(input.scenario),
  ])
  if (ceilingBreach) {
    flags.push({
      kind: 'altitude_limit',
      severity: 'urgent',
      label: 'Published ceiling attention',
      detail: `${Math.round(ceilingBreach.altitudeFt)}ft AGL over a cell the FAA publishes at ${ceilingBreach.publishedCeilingFt}ft (UAS Facility Map eff ${ceilingBreach.mapEffective}); real published data, simulated authorization only.`,
    })
  }

  if (input.drones.some((drone) => drone.signalDbm <= -90 || drone.bvlosFlag) || profile?.bvlosExpected) {
    flags.push({
      kind: 'bvlos',
      severity: 'urgent',
      label: 'BVLOS / command-link attention',
      detail: profile?.bvlosExpected && !input.drones.some((drone) => drone.signalDbm <= -90 || drone.bvlosFlag)
        ? 'Scenario authorization profile expects simulated BVLOS / lost-link mitigations before launch.'
        : 'At least one drone has simulated command-link loss or BVLOS flag active.',
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

  if (profile?.opsOverPeopleExpected || /crowd|concert|stadium|city|urban|times square|bowl/.test(text)) {
    flags.push({
      kind: 'operations_over_people',
      severity: 'advisory',
      label: 'Operations over people review',
      detail: 'Scenario includes populated-area risk; standoff and geofence controls should be highlighted.',
    })
  }

  return flags
}
