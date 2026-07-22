import { describe, it, expect } from 'vitest'
import { generateKeyPair, SessionCipher } from '@/classroom/sessionCrypto'
import { buildGridFrame, parseGridFrame, type GridFrame } from '@/classroom/gridFrame'
import { encodeEnvelope, decodeEnvelope, isSealedPayload, PROTOCOL_VERSION } from '@/classroom/protocol'
import type { SealedPayload } from '@/classroom/protocol'
import type { DroneState } from '@/types'

const CLASS_ID = 'B2CD3F'

function drone(id: string, over: Partial<DroneState> = {}): DroneState {
  return {
    id, label: id.toUpperCase(), color: '#39d98a', position: { lat: 37.77, lng: -122.41 },
    altitudeFt: 200, headingDeg: 45, speedMs: 10, batteryPct: 72, signalDbm: -60,
    missionState: 'navigate', currentWaypointIndex: 1,
    conflictFlag: false, geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0, ...over,
  }
}

// The full wire path a grid frame travels, with no socket: student seals → wrap in
// an envelope → JSON → server relays the string verbatim → instructor decodes the
// envelope and opens the sealed frame. What the instructor gets must deep-equal what
// the student published, and no plaintext must appear in the relayed string.
describe('classroom end-to-end wire path', () => {
  it('student → (relay) → instructor round-trips a grid frame', () => {
    const instructor = generateKeyPair()
    const student = generateKeyPair()
    const sCipher = SessionCipher.forStudent(student.secretKey, instructor.publicKey, CLASS_ID)
    const iCipher = SessionCipher.forInstructor(instructor.secretKey, student.publicKey, CLASS_ID)

    const frame = buildGridFrame({
      elapsedSec: 130, status: 1,
      drones: [drone('alpha', { batteryPct: 8 }), drone('bravo', { geofenceBreachFlag: true })],
      thermalContactCount: 1, eventCount: 4,
    })

    // Student side: seal + envelope + serialize.
    const onWire = encodeEnvelope({ v: PROTOCOL_VERSION, type: 'student.grid', classId: CLASS_ID, sealed: sCipher.seal(frame) })

    // The relay only ever sees this string. It must carry no plaintext telemetry.
    expect(onWire).not.toContain('alpha')
    expect(onWire).not.toContain('navigate')

    // Instructor side: server injected `from`; decode + open + parse.
    const relayed = encodeEnvelope({ ...JSON.parse(onWire), from: 'stu-1' })
    const env = decodeEnvelope(relayed)
    expect(env.type).toBe('student.grid')
    if (env.type !== 'student.grid') throw new Error('unreachable')
    const received = parseGridFrame(iCipher.open<GridFrame>(env.sealed))
    expect(received).toEqual(frame)
  })

  it('carries the replay counter under the auth tag, not on the envelope', () => {
    const instructor = generateKeyPair()
    const student = generateKeyPair()
    const sCipher = SessionCipher.forStudent(student.secretKey, instructor.publicKey, CLASS_ID)
    const iCipher = SessionCipher.forInstructor(instructor.secretKey, student.publicKey, CLASS_ID)
    const frame = buildGridFrame({ elapsedSec: 42, status: 1, drones: [drone('alpha')], thermalContactCount: 0, eventCount: 0 })

    const payload: SealedPayload<GridFrame> = { seq: 7, body: frame }
    const onWire = encodeEnvelope({ v: PROTOCOL_VERSION, type: 'student.grid', classId: CLASS_ID, sealed: sCipher.seal(payload) })

    // Nothing on the relay-visible envelope reveals or exposes the counter, so a LAN
    // eavesdropper has no plaintext field to rewrite before re-injecting the frame.
    const cleartext = JSON.parse(onWire) as Record<string, unknown>
    expect(cleartext).not.toHaveProperty('seq')
    expect(onWire).not.toContain('"seq"')

    const env = decodeEnvelope(onWire)
    if (env.type !== 'student.grid') throw new Error('unreachable')
    const opened = iCipher.open<SealedPayload<GridFrame>>(env.sealed)
    expect(isSealedPayload(opened)).toBe(true)
    expect(opened.seq).toBe(7)
    expect(parseGridFrame(opened.body)).toEqual(frame)

    // Flipping any ciphertext byte fails the GCM tag, so the counter cannot be edited
    // in place either — a replay can only ever repeat the seq it was captured with.
    const tampered = { iv: env.sealed.iv, ct: `${env.sealed.ct.slice(0, -4)}AAAA` }
    expect(() => iCipher.open<SealedPayload<GridFrame>>(tampered)).toThrow()
  })
})
