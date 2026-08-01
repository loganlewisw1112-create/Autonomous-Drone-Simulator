import type { ScenarioConfig } from '@/types'

export type TrainingAssuranceMode =
  | 'synthetic_training'
  | 'recorded_training_replay'
  | 'agency_training_exercise'
  | 'geographic_familiarization'

export type EvidenceStatus = 'verified' | 'stale' | 'missing' | 'invalid' | 'not_applicable'

export type TrainingEvidenceKind =
  | 'terrain_fixture'
  | 'obstacle_fixture'
  | 'airspace_fixture'
  | 'weather_fixture'
  | 'aircraft_model'
  | 'exercise_doctrine'
  | 'identity'
  | 'integrity'

export interface TrainingEvidence {
  kind: TrainingEvidenceKind
  status: EvidenceStatus
  source: string
  observedAt?: string
  expiresAt?: string
  digest?: string
  signatureVerified?: boolean
  detail?: string
}

export interface TrainingAssuranceInput {
  mode: TrainingAssuranceMode
  evidence: TrainingEvidence[]
  now?: number
}

export type ClaimStatus = 'permitted' | 'qualified' | 'prohibited'

export interface TrainingClaimDecision {
  id:
    | 'high_fidelity_training'
    | 'repeatable_assessment'
    | 'evidence_supported_debrief'
    | 'tamper_evident_record'
    | 'digital_twin'
    | 'faa_compliance'
    | 'validates_real_missions'
    | 'safe_route'
    | 'obstacle_avoidance_guarantee'
    | 'forensic_grade'
    | 'tamper_proof'
    | 'full_compliance'
  status: ClaimStatus
  wording: string
  reason: string
}

export interface TrainingAssuranceDecision {
  mode: TrainingAssuranceMode
  launchDisposition: 'training_ready' | 'training_degraded' | 'training_blocked'
  trainingRunAllowed: boolean
  blockers: string[]
  warnings: string[]
  claims: TrainingClaimDecision[]
  disclaimer: string
}

const REQUIREMENTS: Record<TrainingAssuranceMode, TrainingEvidenceKind[]> = {
  synthetic_training: [],
  recorded_training_replay: ['identity', 'integrity'],
  agency_training_exercise: [
    'terrain_fixture', 'obstacle_fixture', 'airspace_fixture', 'weather_fixture',
    'aircraft_model', 'exercise_doctrine',
  ],
  geographic_familiarization: [],
}

const LABELS: Record<TrainingEvidenceKind, string> = {
  terrain_fixture: 'terrain training fixture',
  obstacle_fixture: 'obstacle/building training fixture',
  airspace_fixture: 'airspace training fixture',
  weather_fixture: 'weather training fixture',
  aircraft_model: 'aircraft performance model',
  exercise_doctrine: 'exercise doctrine',
  identity: 'training participant identity',
  integrity: 'debrief record integrity',
}

export function evidenceStatusAt(evidence: TrainingEvidence, now = Date.now()): EvidenceStatus {
  if (evidence.status !== 'verified') return evidence.status
  if (evidence.expiresAt) {
    const expiry = Date.parse(evidence.expiresAt)
    if (!Number.isFinite(expiry) || expiry <= now) return 'stale'
  }
  return evidence.status
}

export function evaluateTrainingAssurance(input: TrainingAssuranceInput): TrainingAssuranceDecision {
  const now = input.now ?? Date.now()
  const byKind = new Map(input.evidence.map((item) => [item.kind, item]))
  const blockers = REQUIREMENTS[input.mode].flatMap((kind) => {
    const item = byKind.get(kind)
    const status = item ? evidenceStatusAt(item, now) : 'missing'
    if (status === 'verified' || status === 'not_applicable') return []
    return [`${LABELS[kind]} is ${status}`]
  })

  for (const kind of REQUIREMENTS[input.mode]) {
    const item = byKind.get(kind)
    if (!item || evidenceStatusAt(item, now) !== 'verified') continue
    if (!item.source.trim()) blockers.push(`${LABELS[kind]} has no source provenance`)
    if (!item.digest?.trim()) blockers.push(`${LABELS[kind]} has no content digest`)
  }

  const integrity = byKind.get('integrity')
  if (integrity?.status === 'verified' && integrity.signatureVerified !== true) {
    blockers.push('debrief record integrity is not cryptographically verified')
  }

  const trainingRunAllowed = blockers.length === 0
  const replayEvidenceReady = input.mode === 'recorded_training_replay' && trainingRunAllowed
  const fixtureEvidenceReady = input.mode === 'agency_training_exercise' && trainingRunAllowed
  const warnings = [
    'Training simulation only: do not use results to authorize, plan, or conduct a real flight.',
    ...(input.mode === 'geographic_familiarization'
      ? ['Coordinates provide exercise context only; the simulator does not verify current terrain, obstacles, airspace, weather, or authorization.']
      : []),
  ]

  const prohibited = (
    id: TrainingClaimDecision['id'],
    wording: string,
    reason: string,
  ): TrainingClaimDecision => ({ id, status: 'prohibited', wording, reason })

  const claims: TrainingClaimDecision[] = [
    {
      id: 'high_fidelity_training',
      status: trainingRunAllowed ? 'qualified' : 'prohibited',
      wording: 'High-fidelity training simulation within the documented deterministic model and frozen-fixture envelope.',
      reason: trainingRunAllowed
        ? 'The claim is limited to repeatable training behavior and documented model boundaries.'
        : 'Required training inputs are unavailable, stale, or invalid.',
    },
    {
      id: 'repeatable_assessment',
      status: trainingRunAllowed ? 'permitted' : 'prohibited',
      wording: 'Repeatable scenario assessment using the same seed, inputs, scoring rules, and simulator revision.',
      reason: trainingRunAllowed ? 'The simulation and assessment path is deterministic.' : 'The training evidence envelope is incomplete.',
    },
    {
      id: 'evidence_supported_debrief',
      status: replayEvidenceReady || fixtureEvidenceReady ? 'qualified' : 'qualified',
      wording: 'Debrief supported by simulator events, replay, scores, and documented application-record integrity checks.',
      reason: replayEvidenceReady || fixtureEvidenceReady
        ? 'The named training evidence envelope is verified.'
        : 'This describes application-generated training records only, not legal or flight evidence.',
    },
    {
      id: 'tamper_evident_record',
      status: integrity?.status === 'verified' && integrity.signatureVerified === true ? 'qualified' : 'qualified',
      wording: 'Tamper-evident application event record when the exported chain verifies.',
      reason: 'Tamper evidence detects some record changes; it does not make local devices or exported files tamper-proof.',
    },
    prohibited('digital_twin', 'Do not call this product a digital twin.', 'It has no authenticated live aircraft state or live operational synchronization.'),
    prohibited('faa_compliance', 'Do not claim FAA compliance or FAA approval.', 'Regulatory workflows are scripted training exercises and no live authorization is performed.'),
    prohibited('validates_real_missions', 'Do not claim validation of real missions.', 'Coordinates and frozen fixtures are training context, not current operational data.'),
    prohibited('safe_route', 'Do not call a simulated route safe for real flight.', 'The model cannot account for all current hazards, uncertainty, aircraft behavior, or operator responsibilities.'),
    prohibited('obstacle_avoidance_guarantee', 'Never claim guaranteed obstacle avoidance.', 'Static fixtures and simulated logic cannot guarantee clearance from real static or dynamic obstacles.'),
    prohibited('forensic_grade', 'Do not claim forensic-grade evidence.', 'Forensic suitability requires controlled acquisition, custody, retention, tools, and independent validation outside this product.'),
    prohibited('tamper_proof', 'Never claim tamper-proof records.', 'Locally stored software records cannot provide an absolute tamper-proof guarantee.'),
    prohibited('full_compliance', 'Never claim blanket or full compliance.', 'The product is a training simulator and does not determine real-world legal compliance.'),
  ]

  return {
    mode: input.mode,
    launchDisposition: trainingRunAllowed
      ? input.mode === 'geographic_familiarization' ? 'training_degraded' : 'training_ready'
      : 'training_blocked',
    trainingRunAllowed,
    blockers,
    warnings,
    claims,
    disclaimer: 'Agency training simulator only. Results are instructional and are not flight authorization, regulatory approval, real-mission validation, a safe-route determination, or an obstacle-avoidance guarantee.',
  }
}

export function assuranceForScenario(scenario: ScenarioConfig | null): TrainingAssuranceDecision {
  return evaluateTrainingAssurance({
    mode: scenario?.assuranceMode ?? 'synthetic_training',
    evidence: scenario?.assuranceEvidence ?? [],
  })
}
