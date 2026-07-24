import type { LatLng, MissionEvent } from '@/types'

// NIST standard test-method lane scoring (REALISM_ROADMAP WP-9).
//
// NIST publishes Standard Test Methods for small Unmanned Aircraft Systems, developed with DHS
// Science & Technology support, and they are referenced as Job Performance Requirements in
// NFPA 2400 (sUAS for Public Safety Operations) and ASTM F38.03 (Training for Remote Pilot in
// Command endorsement). The rubric this file implements is the published one:
//
//   20 targets × 5 increasingly small features = up to 100 points per trial,
//   inside a 15–20 minute limit set so a trial fits one battery charge.
//
// WHY THIS IS THE ONE AUTO-SCORABLE NUMBER. Auto-grading operator *judgment* would be torn apart
// by a real training officer, and rightly. A lane score is not a judgment call — it is published,
// standardised and agency-recognised, so it is the only score here that can carry a procurement
// conversation. Everything else the assessment produces stays advisory.
//
// HOW A FEATURE IS "IDENTIFIED". Not by proximity, and not by a scripted trigger: the aircraft
// must be close enough for the feature to be *resolvable*, and it must have clear line of sight
// to it (WP-4). Both come from geometry the simulator already computes exactly.
//
// DETERMINISM (§3). Pure. Identification is recorded as evidence events by the loop, and scoring
// is a fold over those events — so a replay scores identically by construction, and the score is
// backed by the same tamper-evident chain as the rest of the after-action package.

/**
 * One arcminute in radians — the standard definition of normal (20/20) visual acuity, and the
 * basis on which acuity targets like the Landolt C are dimensioned. A feature is resolvable at
 * the range where it subtends this angle.
 *
 * Using the acuity standard rather than a per-airframe camera spec is deliberate: the repo has
 * sourced *thermal* payload specs but no published EO specs, and inventing focal lengths for six
 * airframes to score a visual-acuity lane would be exactly the kind of fabricated number WP-5 and
 * WP-6 removed. The lane is scored on the standard it is dimensioned against.
 */
export const ARCMIN_RAD = Math.PI / (180 * 60)

/** NIST's stated trial limit, sized so one trial fits a single battery charge. */
export const LANE_TIME_LIMIT_SEC = 20 * 60

/** Published rubric: 20 targets × 5 features, one point each. */
export const LANE_TARGET_COUNT = 20
export const FEATURES_PER_TARGET = 5
export const LANE_MAX_SCORE = LANE_TARGET_COUNT * FEATURES_PER_TARGET

/**
 * The five feature sizes on a target, largest first, each half the previous — "increasingly
 * small features" made concrete. Sizes are in metres.
 */
export const FEATURE_SIZES_M = [0.08, 0.04, 0.02, 0.01, 0.005] as const

export interface NistLaneTarget {
  id: string
  position: LatLng
  /** Height of the target face above local ground, m. */
  heightAglM: number
  label: string
}

export type NistLaneKind = 'open' | 'obstructed' | 'confined' | 'night' | 'maritime' | 'urban'

export interface NistLaneDefinition {
  id: string
  kind: NistLaneKind
  label: string
  /** Scenario this lane scores. */
  scenarioId: string
  targets: NistLaneTarget[]
  timeLimitSec: number
  /** Citation surfaced in the after-action package; never a bare number without provenance. */
  standardRef: string
}

/**
 * Range at which a feature of `sizeM` subtends `acuityArcmin`. Beyond this the feature is not
 * resolvable and cannot be scored.
 */
export function resolvableRangeM(sizeM: number, acuityArcmin = 1): number {
  const angle = Math.max(1e-9, acuityArcmin) * ARCMIN_RAD
  return sizeM / angle
}

/** Required standoff for each feature index, largest feature (index 0) first. */
export function featureRangesM(acuityArcmin = 1): number[] {
  return FEATURE_SIZES_M.map((size) => resolvableRangeM(size, acuityArcmin))
}

export interface LaneFeatureScore {
  targetId: string
  featureIndex: number
  tick: number
  elapsedSec: number
}

export interface LaneScore {
  laneId: string
  kind: NistLaneKind
  /** 0–100 against the published rubric. */
  score: number
  maxScore: number
  targetsAttempted: number
  targetsComplete: number
  featuresIdentified: number
  /** Identifications that fell outside the time limit and were therefore not counted. */
  featuresRejectedLate: number
  timeLimitSec: number
  withinTimeLimit: boolean
  standardRef: string
  perTarget: Array<{ targetId: string; label: string; featuresIdentified: number }>
}

export const LANE_FEATURE_EVENT = 'lane_feature_identified' as const

/**
 * Score a trial from its evidence events.
 *
 * A fold over `lane_feature_identified` events rather than over live state: the events are
 * already in the tamper-evident chain, already replayed, and already the thing the after-action
 * package is built from, so the score inherits all of that instead of needing its own bookkeeping.
 *
 * Late identifications are counted and reported separately rather than silently dropped — a
 * trainee who found everything but ran over time should see that, not an unexplained low score.
 */
export function scoreLane(
  lane: NistLaneDefinition,
  events: readonly MissionEvent[],
  elapsedSec: number,
): LaneScore {
  const targetIds = new Set(lane.targets.map((target) => target.id))
  const identified = new Map<string, LaneFeatureScore>()
  let rejectedLate = 0

  for (const event of events) {
    if (event.eventType !== LANE_FEATURE_EVENT) continue
    const targetId = event.payload.targetId
    const featureIndex = event.payload.featureIndex
    const at = event.payload.elapsedSec
    if (typeof targetId !== 'string' || typeof featureIndex !== 'number') continue
    if (!targetIds.has(targetId)) continue
    if (featureIndex < 0 || featureIndex >= FEATURES_PER_TARGET) continue

    const atSec = typeof at === 'number' ? at : event.tick / 20
    const key = `${targetId}#${featureIndex}`
    if (identified.has(key)) continue

    if (atSec > lane.timeLimitSec) {
      rejectedLate += 1
      continue
    }
    identified.set(key, { targetId, featureIndex, tick: event.tick, elapsedSec: atSec })
  }

  const perTarget = lane.targets.map((target) => ({
    targetId: target.id,
    label: target.label,
    featuresIdentified: [...identified.values()].filter((f) => f.targetId === target.id).length,
  }))

  return {
    laneId: lane.id,
    kind: lane.kind,
    // One point per feature is the published rubric, and 20 × 5 is already 100 — so the score is
    // the raw count. Scaling would only obscure that.
    score: identified.size,
    maxScore: LANE_MAX_SCORE,
    targetsAttempted: perTarget.filter((t) => t.featuresIdentified > 0).length,
    targetsComplete: perTarget.filter((t) => t.featuresIdentified === FEATURES_PER_TARGET).length,
    featuresIdentified: identified.size,
    featuresRejectedLate: rejectedLate,
    timeLimitSec: lane.timeLimitSec,
    withinTimeLimit: elapsedSec <= lane.timeLimitSec,
    standardRef: lane.standardRef,
    perTarget,
  }
}

export interface LaneObserver {
  position: LatLng
  altMslM: number
}

export interface FeatureCheckInput {
  observer: LaneObserver
  target: NistLaneTarget
  /** Target face altitude, m MSL. */
  targetMslM: number
  acuityArcmin?: number
  /** Clear line of sight from observer to target face (WP-4). */
  hasLineOfSight: boolean
  /** Slant range, m. */
  slantRangeM: number
}

/**
 * Highest-resolution feature index resolvable right now, or -1 for none.
 *
 * Features are cumulative by construction: anything at this range that resolves the smallest
 * feature also resolves every larger one, which is what "increasingly small features" means and
 * why closing the range is the trained behaviour.
 */
export function resolvableFeatureIndex(input: FeatureCheckInput): number {
  if (!input.hasLineOfSight) return -1
  const ranges = featureRangesM(input.acuityArcmin)
  let best = -1
  for (let i = 0; i < ranges.length; i += 1) {
    if (input.slantRangeM <= ranges[i]) best = i
  }
  return best
}
