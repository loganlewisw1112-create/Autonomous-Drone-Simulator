// Operational authorization training — simulation-only practice workflows.
// Operators rehearse RID / LAANC-or-IC request / ceiling / TFR / BVLOS / night
// steps before launch. No real FAA, LAANC, USS, or broadcast network calls.

import type {
  AirspaceAuthorization,
  AuthorizationStepId,
  AuthorizationStepStatus,
  AuthorizationTrainingProgress,
  ScenarioAuthorizationProfile,
  ScenarioConfig,
  ScenarioVariantConfig,
} from '@/types'

export const AUTH_TRAINING_DISCLAIMER =
  'SIMULATION ONLY — authorization steps train operational readiness; no real FAA, LAANC, USS, or Remote ID network calls are performed.'

/** Stable display order for checklist UI and deterministic scoring. */
export const AUTHORIZATION_STEP_ORDER: readonly AuthorizationStepId[] = [
  'remote_id',
  'airspace_request',
  'ceiling_check',
  'tfr_conflict_ack',
  'hot_zone_ack',
  'bvlos_waiver',
  'night_ops',
  'ops_over_people',
] as const

const STEP_COPY: Record<AuthorizationStepId, { label: string; detail: string }> = {
  remote_id: {
    label: 'Remote ID broadcast readiness',
    detail: 'Confirm simulated RID transmitters are configured for every airframe before launch.',
  },
  airspace_request: {
    label: 'Airspace authorization request',
    detail: 'Submit the simulated LAANC / USS or incident-command airspace request for this AO.',
  },
  ceiling_check: {
    label: 'Altitude / published ceiling check',
    detail: 'Review Part 107 / published UAS Facility Map ceilings against planned altitudes.',
  },
  tfr_conflict_ack: {
    label: 'TFR / conflict deconfliction acknowledgment',
    detail: 'Acknowledge active TFR volumes and external traffic conflicts before entering the AO.',
  },
  hot_zone_ack: {
    label: 'Hot-zone standoff acknowledgment',
    detail: 'Acknowledge simulated hot-zone / exclusion standoff before entering the AO.',
  },
  bvlos_waiver: {
    label: 'BVLOS / command-link waiver review',
    detail: 'Confirm simulated BVLOS or degraded-link mitigations (observer, relay, lost-link doctrine).',
  },
  night_ops: {
    label: 'Night operations readiness',
    detail: 'Confirm anti-collision lighting, observer, and PIC night-ops checks for this scenario.',
  },
  ops_over_people: {
    label: 'Operations-over-people review',
    detail: 'Review populated-area standoff, geofence, and Category risk mitigations.',
  },
}

const DEFAULT_LABELS: Record<ScenarioAuthorizationProfile['kind'], { label: string; reference: string }> = {
  simulated_laanc: {
    label: 'Simulated LAANC / USS authorization',
    reference: 'Authorization state is derived locally from scenario metadata and visible constraints.',
  },
  field_incident_command: {
    label: 'Incident command airspace coordination',
    reference: 'Scenario assumes an incident command airspace cell with simulated UAS coordination.',
  },
  not_required: {
    label: 'Uncontrolled simulated airspace',
    reference: 'No controlled-airspace authorization is modeled for this scenario.',
  },
}

/**
 * Resolve the authored profile when present; otherwise infer from scenario text
 * (legacy catalog path). Explicit fields always win over regex.
 */
export function resolveAuthorizationProfile(scenario: ScenarioConfig | null): ScenarioAuthorizationProfile {
  if (!scenario) {
    return {
      kind: 'not_required',
      requiredSteps: ['remote_id', 'ceiling_check'],
      label: 'No active airspace request',
      reference: 'Load a scenario to derive simulated airspace readiness.',
    }
  }

  if (scenario.authorizationProfile) {
    return normalizeProfile(scenario.authorizationProfile)
  }

  return inferAuthorizationProfile(scenario)
}

/** Prefer scenario-authored profile; fall back to inferred kind/label/reference. */
export function buildAuthorizationFromProfile(scenario: ScenarioConfig | null): AirspaceAuthorization {
  const profile = resolveAuthorizationProfile(scenario)
  const defaults = DEFAULT_LABELS[profile.kind]
  return {
    kind: profile.kind,
    status: scenario ? 'ready' : 'attention',
    label: profile.label ?? defaults.label,
    reference: profile.reference ?? defaults.reference,
  }
}

/** Required interactive steps for this scenario + variant (deterministic). */
export function resolveRequiredAuthorizationSteps(
  scenario: ScenarioConfig | null,
  variant: ScenarioVariantConfig,
): AuthorizationStepId[] {
  const profile = resolveAuthorizationProfile(scenario)
  const steps = new Set<AuthorizationStepId>(profile.requiredSteps)

  if (profile.tfrExercise?.requireAcknowledgment) {
    steps.add('tfr_conflict_ack')
  }
  if (profile.bvlosExpected) {
    steps.add('bvlos_waiver')
  }
  if (variant.timeOfDay === 'night') {
    for (const step of profile.nightSteps ?? ['night_ops']) {
      steps.add(step)
    }
  }
  if (profile.opsOverPeopleExpected) {
    steps.add('ops_over_people')
  }

  // Coastal / geofence TFRs without an authored exercise still teach acknowledgment
  // when the scenario already models a restricted TFR-like volume.
  if (scenarioHasTfrLikeConstraint(scenario) && !steps.has('tfr_conflict_ack')) {
    // Only auto-add when the profile kind implies controlled airspace coordination.
    if (profile.kind !== 'not_required') {
      steps.add('tfr_conflict_ack')
    }
  }

  return AUTHORIZATION_STEP_ORDER.filter((id) => steps.has(id))
}

export function describeAuthorizationStep(stepId: AuthorizationStepId): { id: AuthorizationStepId; label: string; detail: string } {
  const copy = STEP_COPY[stepId]
  return { id: stepId, label: copy.label, detail: copy.detail }
}

export function buildAuthorizationStepStatuses(
  required: readonly AuthorizationStepId[],
  completed: readonly AuthorizationStepId[],
): AuthorizationStepStatus[] {
  const done = new Set(completed)
  return required.map((id) => {
    const copy = STEP_COPY[id]
    return {
      id,
      label: copy.label,
      detail: copy.detail,
      completed: done.has(id),
      required: true,
    }
  })
}

export function evaluateAuthorizationTraining(
  scenario: ScenarioConfig | null,
  variant: ScenarioVariantConfig,
  completedStepIds: readonly AuthorizationStepId[],
): AuthorizationTrainingProgress {
  const requiredStepIds = resolveRequiredAuthorizationSteps(scenario, variant)
  const completed = new Set(completedStepIds)
  const missedStepIds = requiredStepIds.filter((id) => !completed.has(id))
  const profile = resolveAuthorizationProfile(scenario)

  return {
    profileKind: profile.kind,
    requiredStepIds,
    completedStepIds: AUTHORIZATION_STEP_ORDER.filter((id) => completed.has(id)),
    missedStepIds,
    ready: missedStepIds.length === 0,
    steps: buildAuthorizationStepStatuses(requiredStepIds, completedStepIds),
    tfrExercise: profile.tfrExercise,
    disclaimer: AUTH_TRAINING_DISCLAIMER,
  }
}

/** Extract completed auth step ids from mission evidence (deterministic order). */
export function authorizationStepsFromEvents(
  events: readonly { eventType: string; payload: Record<string, unknown> }[],
): AuthorizationStepId[] {
  const found = new Set<AuthorizationStepId>()
  for (const event of events) {
    if (event.eventType === 'authorization_step_complete') {
      const stepId = event.payload.stepId
      if (typeof stepId === 'string' && isAuthorizationStepId(stepId)) found.add(stepId)
    }
    if (event.eventType === 'authorization_complete' || event.eventType === 'preflight_complete') {
      const steps = event.payload.authorizationStepsCompleted
      if (Array.isArray(steps)) {
        for (const step of steps) {
          if (typeof step === 'string' && isAuthorizationStepId(step)) found.add(step)
        }
      }
    }
  }
  return AUTHORIZATION_STEP_ORDER.filter((id) => found.has(id))
}

export function isAuthorizationStepId(value: string): value is AuthorizationStepId {
  return (AUTHORIZATION_STEP_ORDER as readonly string[]).includes(value)
}

function inferAuthorizationProfile(scenario: ScenarioConfig): ScenarioAuthorizationProfile {
  const text = `${scenario.id} ${scenario.name} ${scenario.description}`.toLowerCase()

  if (/urban|city|port|airport|harbor|coastal|pursuit|perimeter/.test(text)) {
    return normalizeProfile({
      kind: 'simulated_laanc',
      requiredSteps: ['remote_id', 'airspace_request', 'ceiling_check'],
      nightSteps: ['night_ops'],
      opsOverPeopleExpected: /crowd|concert|stadium|city|urban|times square|bowl/.test(text),
    })
  }

  if (/wildfire|fema|hurricane|usar|border|mountain|hazmat/.test(text)) {
    return normalizeProfile({
      kind: 'field_incident_command',
      requiredSteps: ['remote_id', 'airspace_request', 'ceiling_check'],
      nightSteps: ['night_ops'],
      bvlosExpected: /relay|long.?range|border|desert/.test(text),
    })
  }

  return normalizeProfile({
    kind: 'not_required',
    requiredSteps: ['remote_id', 'ceiling_check'],
  })
}

function normalizeProfile(profile: ScenarioAuthorizationProfile): ScenarioAuthorizationProfile {
  const required = uniqueOrdered(profile.requiredSteps)
  return {
    ...profile,
    requiredSteps: required.length > 0 ? required : ['remote_id', 'ceiling_check'],
    nightSteps: profile.nightSteps ? uniqueOrdered(profile.nightSteps) : profile.nightSteps,
  }
}

function uniqueOrdered(steps: readonly AuthorizationStepId[]): AuthorizationStepId[] {
  const set = new Set(steps)
  return AUTHORIZATION_STEP_ORDER.filter((id) => set.has(id))
}

function scenarioHasTfrLikeConstraint(scenario: ScenarioConfig | null): boolean {
  if (!scenario) return false
  // Explicit TFR vocabulary only — generic restricted geofences are not TFRs.
  return scenario.geofences.some((gf) => {
    const blob = `${gf.id} ${gf.label}`.toLowerCase()
    return /\btfr\b/.test(blob)
  })
}
