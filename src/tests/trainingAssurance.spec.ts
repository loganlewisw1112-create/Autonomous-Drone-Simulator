import { describe, expect, it } from 'vitest'
import {
  evaluateTrainingAssurance,
  type TrainingEvidence,
  type TrainingEvidenceKind,
} from '@/assurance/trainingAssurance'

function verified(kind: TrainingEvidenceKind): TrainingEvidence {
  return {
    kind,
    status: 'verified',
    source: `test:${kind}`,
    digest: `sha256:${kind}`,
    signatureVerified: kind === 'integrity',
  }
}

describe('agency training assurance claim gate', () => {
  it('permits qualified high-fidelity training language and prohibits operational claims', () => {
    const result = evaluateTrainingAssurance({ mode: 'synthetic_training', evidence: [] })
    expect(result.launchDisposition).toBe('training_ready')
    expect(result.trainingRunAllowed).toBe(true)
    expect(result.claims.find((claim) => claim.id === 'high_fidelity_training')?.status).toBe('qualified')
    expect(result.claims.find((claim) => claim.id === 'digital_twin')?.status).toBe('prohibited')
    expect(result.claims.find((claim) => claim.id === 'faa_compliance')?.status).toBe('prohibited')
    expect(result.claims.find((claim) => claim.id === 'obstacle_avoidance_guarantee')?.status).toBe('prohibited')
    expect(result.claims.find((claim) => claim.id === 'tamper_proof')?.status).toBe('prohibited')
    expect(result.claims.find((claim) => claim.id === 'full_compliance')?.status).toBe('prohibited')
  })

  it('labels real-coordinate exercises as degraded geographic familiarization', () => {
    const result = evaluateTrainingAssurance({ mode: 'geographic_familiarization', evidence: [] })
    expect(result.trainingRunAllowed).toBe(true)
    expect(result.launchDisposition).toBe('training_degraded')
    expect(result.warnings.join(' ')).toContain('Coordinates provide exercise context only')
    expect(result.claims.find((claim) => claim.id === 'validates_real_missions')?.status).toBe('prohibited')
  })

  it('blocks an agency exercise when declared training fixtures are absent', () => {
    const result = evaluateTrainingAssurance({ mode: 'agency_training_exercise', evidence: [] })
    expect(result.trainingRunAllowed).toBe(false)
    expect(result.launchDisposition).toBe('training_blocked')
    expect(result.blockers).toContain('terrain training fixture is missing')
  })

  it('qualifies a replay only when identity and integrity records verify', () => {
    const result = evaluateTrainingAssurance({
      mode: 'recorded_training_replay',
      evidence: [verified('identity'), verified('integrity')],
    })
    expect(result.trainingRunAllowed).toBe(true)
    expect(result.launchDisposition).toBe('training_ready')
  })
})
