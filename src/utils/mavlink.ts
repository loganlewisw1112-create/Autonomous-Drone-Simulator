import type { DroneState, MAVLinkMessage } from '@/types'

// This encodes MAVLink v2 message NAMES/FIELDS for the operator's decoded telemetry feed —
// it is NOT wire-format MAVLink (no frame header, sequence, checksum, or signing) and isn't
// meant to be parsed by real ground-control software. Field values follow MAVLink field
// semantics with one known simplification: encodeGlobalPositionInt's vx/vy below are
// east/north (matching this sim's heading convention), not MAVLink's north/east order.
//
// MAVLink v2 enumerations (MAVLink common dialect)
const MAV_TYPE_QUADROTOR = 2
const MAV_AUTOPILOT_ARDUPILOTMEGA = 3
const MAV_STATE_STANDBY = 3
const MAV_STATE_ACTIVE = 4
const MAV_STATE_EMERGENCY = 6

// Base mode flags
const MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1
const MAV_MODE_FLAG_SAFETY_ARMED = 128
const MAV_MODE_FLAG_GUIDED_ENABLED = 8

function sysId(drone: DroneState): number {
  return parseInt(drone.id.replace(/\D/g, ''), 10) || 1
}

export function encodeHeartbeat(drone: DroneState): MAVLinkMessage {
  const isActive = !['idle', 'landed', 'preflight'].includes(drone.missionState)
  const isEmergency = drone.missionState === 'emergency'
  const baseMode = MAV_MODE_FLAG_CUSTOM_MODE_ENABLED |
    MAV_MODE_FLAG_GUIDED_ENABLED |
    (isActive ? MAV_MODE_FLAG_SAFETY_ARMED : 0)
  return {
    msgId: 0,
    msgName: 'HEARTBEAT',
    systemId: sysId(drone),
    timestamp: Date.now(),
    fields: {
      type: MAV_TYPE_QUADROTOR,
      autopilot: MAV_AUTOPILOT_ARDUPILOTMEGA,
      base_mode: baseMode,
      custom_mode: 4,  // GUIDED
      system_status: isEmergency ? MAV_STATE_EMERGENCY : isActive ? MAV_STATE_ACTIVE : MAV_STATE_STANDBY,
      mavlink_version: 3,
    },
  }
}

export function encodeGlobalPositionInt(drone: DroneState): MAVLinkMessage {
  const headingRad = (drone.headingDeg * Math.PI) / 180
  return {
    msgId: 33,
    msgName: 'GLOBAL_POSITION_INT',
    systemId: sysId(drone),
    timestamp: Date.now(),
    fields: {
      time_boot_ms: Date.now() & 0xffffffff,
      lat: Math.round(drone.position.lat * 1e7),          // degE7
      lon: Math.round(drone.position.lng * 1e7),          // degE7
      alt: Math.round(drone.altitudeFt * 304.8),          // mm ASL
      relative_alt: Math.round(drone.altitudeFt * 304.8), // mm AGL
      vx: Math.round(drone.speedMs * Math.sin(headingRad) * 100), // cm/s
      vy: Math.round(drone.speedMs * Math.cos(headingRad) * 100), // cm/s
      vz: 0,
      hdg: Math.round(drone.headingDeg * 100),            // cdeg
    },
  }
}

export function encodeBatteryStatus(drone: DroneState): MAVLinkMessage {
  const voltage = Math.round(16800 * (drone.batteryPct / 100)) // mV (4S LiPo)
  const currentDraw = Math.round(drone.speedMs * 100 + 200)    // cA estimated
  return {
    msgId: 147,
    msgName: 'BATTERY_STATUS',
    systemId: sysId(drone),
    timestamp: Date.now(),
    fields: {
      id: 0,
      battery_function: 0,  // BATTERY_FUNCTION_ALL
      type: 0,              // BATTERY_TYPE_LIPO
      temperature: 2500,    // 25.00°C in centidegrees
      voltages: voltage,
      current_battery: currentDraw,
      current_consumed: Math.round((100 - drone.batteryPct) * 50), // mAh estimated
      energy_consumed: -1,
      battery_remaining: Math.round(drone.batteryPct),
    },
  }
}

export function encodeSysStatus(drone: DroneState): MAVLinkMessage {
  const sensorsPresent = 0b111111111111111
  const sensorsEnabled = 0b111111111111111
  // Mark deconflict subsystem unhealthy when conflict active
  const sensorsHealth = drone.conflictFlag ? sensorsEnabled ^ 0b100000000 : sensorsEnabled
  return {
    msgId: 1,
    msgName: 'SYS_STATUS',
    systemId: sysId(drone),
    timestamp: Date.now(),
    fields: {
      onboard_control_sensors_present: sensorsPresent,
      onboard_control_sensors_enabled: sensorsEnabled,
      onboard_control_sensors_health: sensorsHealth,
      load: Math.round(drone.speedMs * 5),               // 0.1% CPU load estimate
      voltage_battery: Math.round(16800 * (drone.batteryPct / 100)),
      current_battery: Math.round(drone.speedMs * 100 + 200),
      battery_remaining: Math.round(drone.batteryPct),
      drop_rate_comm: drone.bvlosFlag ? 5000 : drone.signalDbm < -80 ? 1000 : 0, // 0.01%
      errors_comm: drone.bvlosFlag ? 1 : 0,
      errors_count1: drone.conflictFlag ? 1 : 0,
    },
  }
}

/** Returns the 4 core MAVLink v2 messages for one drone, in standard heartbeat order. */
export function encodeDroneTelemetry(drone: DroneState): MAVLinkMessage[] {
  return [
    encodeHeartbeat(drone),
    encodeGlobalPositionInt(drone),
    encodeBatteryStatus(drone),
    encodeSysStatus(drone),
  ]
}

/** Format a MAVLink message as a human-readable decoded line for the feed panel. */
export function formatMAVLinkLine(msg: MAVLinkMessage): string {
  const fields = Object.entries(msg.fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ')
  return `SYS:${String(msg.systemId).padEnd(2)} ${msg.msgName.padEnd(22)} ${fields}`
}
