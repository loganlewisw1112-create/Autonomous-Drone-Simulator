import type { RechargeStation, ScenarioConfig } from '@/types'
import { mixedFleet, explicitFleet } from './platformAssignments'

// ── 1. LAPD SIS — Hollywood Bowl Active Shooter Response ──────────────────
export const lapdHollywoodBowl: ScenarioConfig = {
  id: 'extreme_lapd_hollywood_bowl',
  name: 'LAPD SIS — Hollywood Bowl Response',
  description: 'LAPD Special Investigations Section deploys a five-drone squad for active shooter response at the Hollywood Bowl amphitheater. Five sectors assigned simultaneously: shell-north, hillside seating south, VIP/press entrance, Highland Ave perimeter, and Cahuenga Pass corridor. Two sorties planned. After recharge, drones relaunch for secondary search phase. SIMULATION ONLY — all positions and contacts are synthetic.',
  seed: 20001,
  droneCount: 5,
  // Urban crowd overwatch: X10 primaries with a compact Anafi for infill.
  dronePlatforms: mixedFleet(5, 'skydio_x10', 'parrot_anafi_usa'),
  missionType: 'waypoint',
  startPosition: { lat: 34.1118, lng: -118.3375 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'hb-01-shell-n',    position: { lat: 34.1132, lng: -118.3388 }, altitudeFt: 120, label: 'Shell-North',    dwellTimeSec: 15 },
      { id: 'hb-01-stage',      position: { lat: 34.1125, lng: -118.3395 }, altitudeFt: 100, label: 'Stage-Area',     dwellTimeSec: 20 },
      { id: 'hb-01-backstage',  position: { lat: 34.1118, lng: -118.3402 }, altitudeFt: 80,  label: 'Backstage-Gate', dwellTimeSec: 20 },
      { id: 'hb-01-shell-s',    position: { lat: 34.1112, lng: -118.3398 }, altitudeFt: 100, label: 'Shell-South',    dwellTimeSec: 12 },
    ],
    'uav-02': [
      { id: 'hb-02-vip-gate',   position: { lat: 34.1128, lng: -118.3368 }, altitudeFt: 140, label: 'VIP-Gate',       dwellTimeSec: 15 },
      { id: 'hb-02-press',      position: { lat: 34.1122, lng: -118.3362 }, altitudeFt: 120, label: 'Press-Corral',   dwellTimeSec: 12 },
      { id: 'hb-02-pkg-roof',   position: { lat: 34.1134, lng: -118.3358 }, altitudeFt: 160, label: 'Parking-Roof',   dwellTimeSec: 15 },
      { id: 'hb-02-n-lot',      position: { lat: 34.1140, lng: -118.3372 }, altitudeFt: 140, label: 'North-Lot',      dwellTimeSec: 8  },
    ],
    'uav-03': [
      { id: 'hb-03-hill-s',     position: { lat: 34.1108, lng: -118.3388 }, altitudeFt: 120, label: 'Hillside-S',     dwellTimeSec: 15 },
      { id: 'hb-03-seat-mid',   position: { lat: 34.1115, lng: -118.3385 }, altitudeFt: 100, label: 'Seating-Mid',    dwellTimeSec: 18 },
      { id: 'hb-03-seat-top',   position: { lat: 34.1122, lng: -118.3382 }, altitudeFt: 120, label: 'Seating-Top',    dwellTimeSec: 15 },
      { id: 'hb-03-overflow',   position: { lat: 34.1128, lng: -118.3378 }, altitudeFt: 120, label: 'Overflow-Lawn',  dwellTimeSec: 10 },
    ],
    'uav-04': [
      { id: 'hb-04-highland-n', position: { lat: 34.1142, lng: -118.3380 }, altitudeFt: 160, label: 'Highland-N',     dwellTimeSec: 10 },
      { id: 'hb-04-highland-m', position: { lat: 34.1132, lng: -118.3375 }, altitudeFt: 160, label: 'Highland-Mid',   dwellTimeSec: 10 },
      { id: 'hb-04-highland-s', position: { lat: 34.1118, lng: -118.3370 }, altitudeFt: 160, label: 'Highland-S',     dwellTimeSec: 10 },
      { id: 'hb-04-bowl-blvd',  position: { lat: 34.1108, lng: -118.3380 }, altitudeFt: 140, label: 'BowlBlvd-Gate',  dwellTimeSec: 12 },
    ],
    'uav-05': [
      { id: 'hb-05-cahuenga-n', position: { lat: 34.1148, lng: -118.3392 }, altitudeFt: 180, label: 'Cahuenga-N',     dwellTimeSec: 12 },
      { id: 'hb-05-cahuenga-m', position: { lat: 34.1138, lng: -118.3400 }, altitudeFt: 180, label: 'Cahuenga-Mid',   dwellTimeSec: 10 },
      { id: 'hb-05-pass-exit',  position: { lat: 34.1128, lng: -118.3408 }, altitudeFt: 160, label: 'Pass-Exit',      dwellTimeSec: 15 },
    ],
  },
  geofences: [
    { id: 'gf-hb-stage',    label: 'Stage/Performers — No Fly', polygon: [{ lat: 34.1120, lng: -118.3402 }, { lat: 34.1120, lng: -118.3390 }, { lat: 34.1128, lng: -118.3390 }, { lat: 34.1128, lng: -118.3402 }], maxAltitudeFt: 0, type: 'no_fly', bypassForMission: true },
    { id: 'gf-hb-highland', label: 'Highland Ave TFR',          polygon: [{ lat: 34.1100, lng: -118.3365 }, { lat: 34.1150, lng: -118.3365 }, { lat: 34.1150, lng: -118.3358 }, { lat: 34.1100, lng: -118.3358 }], maxAltitudeFt: 0, type: 'no_fly' },
  ],
  heatSources: [
    { id: 'hs-hb-suspect',  class: 'generic-person', position: { lat: 34.1125, lng: -118.3392 }, tempC: 37,  radiusM: 1 },
    { id: 'hs-hb-crowd-a',  class: 'generic-person', position: { lat: 34.1115, lng: -118.3385 }, tempC: 36,  radiusM: 12 },
    { id: 'hs-hb-crowd-b',  class: 'generic-person', position: { lat: 34.1122, lng: -118.3380 }, tempC: 36,  radiusM: 8 },
    { id: 'hs-hb-lapd-veh', class: 'vehicle',        position: { lat: 34.1118, lng: -118.3370 }, tempC: 90,  radiusM: 3 },
    { id: 'hs-hb-swat',     class: 'vehicle',        position: { lat: 34.1108, lng: -118.3382 }, tempC: 85,  radiusM: 4 },
    { id: 'hs-hb-cmd-post', class: 'vehicle',        position: { lat: 34.1118, lng: -118.3360 }, tempC: 70,  radiusM: 6 },
    { id: 'hs-hb-ems',      class: 'vehicle',        position: { lat: 34.1108, lng: -118.3370 }, tempC: 75,  radiusM: 4 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.022,
  rechargeTimeSec: 45,
  maxSorties: 2,
  commsLossWindows: [{ startSec: 90, durationSec: 15 }],
  perDroneMissionRoles: {
    'uav-01': 'Stage / Shell Sweep — primary performer zone',
    'uav-02': 'VIP & Press Entry Control — north gate',
    'uav-03': 'Hillside Seating Grid — south amphitheater',
    'uav-04': 'Highland Ave Perimeter — vehicle threat corridor',
    'uav-05': 'Cahuenga Pass Corridor — northern egress watch',
  },
}

// ── 2. CBP Eagle Pass — Rio Grande Overnight Border Relay ──────────────────
export const cbpEaglePassBorder: ScenarioConfig = {
  id: 'extreme_cbp_eagle_pass',
  name: 'CBP Eagle Pass — Rio Grande Relay',
  description: 'U.S. Customs and Border Protection Eagle Pass Station deploys five drones under CBP Air and Marine Operations for overnight surveillance of a 2.5-km stretch of the Rio Grande. Three sorties per drone required for the full operational period. Thermal sensors detect body-temperature signatures against 85°F nighttime riverbed. SIMULATION ONLY.',
  seed: 20002,
  droneCount: 5,
  // Border doctrine: uniform weatherproof X10D line for sustained ISR.
  dronePlatforms: mixedFleet(5, 'skydio_x10d'),
  missionType: 'waypoint',
  startPosition: { lat: 28.7062, lng: -100.4965 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'ep-01-ford-n',   position: { lat: 28.7090, lng: -100.4990 }, altitudeFt: 100, label: 'Vehicle-Ford-N',  dwellTimeSec: 20 },
      { id: 'ep-01-ford-s',   position: { lat: 28.7075, lng: -100.4985 }, altitudeFt: 100, label: 'Vehicle-Ford-S',  dwellTimeSec: 25 },
      { id: 'ep-01-bend',     position: { lat: 28.7062, lng: -100.4978 }, altitudeFt: 120, label: 'River-Bend',      dwellTimeSec: 20 },
    ],
    'uav-02': [
      { id: 'ep-02-cane-n',   position: { lat: 28.7088, lng: -100.4955 }, altitudeFt: 80,  label: 'Cane-Break-N',   dwellTimeSec: 25 },
      { id: 'ep-02-cane-m',   position: { lat: 28.7075, lng: -100.4948 }, altitudeFt: 80,  label: 'Cane-Break-Mid', dwellTimeSec: 30 },
      { id: 'ep-02-cane-s',   position: { lat: 28.7062, lng: -100.4942 }, altitudeFt: 80,  label: 'Cane-Break-S',   dwellTimeSec: 20 },
    ],
    'uav-03': [
      { id: 'ep-03-bridge-n', position: { lat: 28.7090, lng: -100.4928 }, altitudeFt: 140, label: 'Bridge-Approach', dwellTimeSec: 15 },
      { id: 'ep-03-levee',    position: { lat: 28.7078, lng: -100.4922 }, altitudeFt: 120, label: 'Levee-Road',      dwellTimeSec: 20 },
      { id: 'ep-03-bridge-s', position: { lat: 28.7065, lng: -100.4918 }, altitudeFt: 140, label: 'Bridge-S',        dwellTimeSec: 15 },
    ],
    'uav-04': [
      { id: 'ep-04-oxbow-n',  position: { lat: 28.7048, lng: -100.4965 }, altitudeFt: 100, label: 'Oxbow-North',    dwellTimeSec: 25 },
      { id: 'ep-04-oxbow-m',  position: { lat: 28.7038, lng: -100.4958 }, altitudeFt: 100, label: 'Oxbow-Mid',      dwellTimeSec: 30 },
      { id: 'ep-04-oxbow-s',  position: { lat: 28.7028, lng: -100.4950 }, altitudeFt: 100, label: 'Oxbow-South',    dwellTimeSec: 20 },
    ],
    'uav-05': [
      { id: 'ep-05-relay-hi', position: { lat: 28.7065, lng: -100.4952 }, altitudeFt: 220, label: 'Relay-Hi',       dwellTimeSec: 60 },
      { id: 'ep-05-relay-s',  position: { lat: 28.7040, lng: -100.4960 }, altitudeFt: 200, label: 'Relay-South',    dwellTimeSec: 30 },
    ],
  },
  geofences: [
    { id: 'gf-ep-mexico', label: 'Mexican Territory — Absolute No Fly',    polygon: [{ lat: 28.7020, lng: -100.5010 }, { lat: 28.7020, lng: -100.4900 }, { lat: 28.7035, lng: -100.4900 }, { lat: 28.7035, lng: -100.5010 }], maxAltitudeFt: 0,   type: 'no_fly' },
    { id: 'gf-ep-bridge', label: 'Intl Bridge — Restricted Airspace',      polygon: [{ lat: 28.7060, lng: -100.4932 }, { lat: 28.7095, lng: -100.4932 }, { lat: 28.7095, lng: -100.4915 }, { lat: 28.7060, lng: -100.4915 }], maxAltitudeFt: 150, type: 'restricted' },
  ],
  heatSources: [
    { id: 'hs-ep-group-a', class: 'generic-person', position: { lat: 28.7078, lng: -100.4982 }, tempC: 37,  radiusM: 3 },
    { id: 'hs-ep-group-b', class: 'generic-person', position: { lat: 28.7068, lng: -100.4948 }, tempC: 37,  radiusM: 4 },
    { id: 'hs-ep-sensor',  class: 'heat-source',    position: { lat: 28.7055, lng: -100.4960 }, tempC: 45,  radiusM: 2 },
    { id: 'hs-ep-vehicle', class: 'vehicle',        position: { lat: 28.7062, lng: -100.4965 }, tempC: 85,  radiusM: 3 },
    { id: 'hs-ep-agent-a', class: 'generic-person', position: { lat: 28.7070, lng: -100.4962 }, tempC: 36,  radiusM: 1 },
    { id: 'hs-ep-agent-b', class: 'generic-person', position: { lat: 28.7048, lng: -100.4958 }, tempC: 36,  radiusM: 1 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.020,
  rechargeTimeSec: 60,
  maxSorties: 3,
  commsLossWindows: [{ startSec: 180, durationSec: 20 }, { startSec: 520, durationSec: 18 }],
  perDroneMissionRoles: {
    'uav-01': 'Vehicle Ford Watch — river crossing detection',
    'uav-02': 'Cane Break Scan — concealment thermal search',
    'uav-03': 'International Bridge Corridor — crossing approach',
    'uav-04': 'Oxbow Loop — low-visibility river bend sector',
    'uav-05': 'Hi-Alt Relay — sector comms link to Eagle Pass Station',
  },
}

// ── 3. FBI HRT — Suburban Compound Siege ────────────────────────────────────
export const fbiHrtCompound: ScenarioConfig = {
  id: 'extreme_fbi_hrt_compound',
  name: 'FBI HRT — Compound Siege (ISR/Entry/Extract)',
  description: 'FBI Hostage Rescue Team deploys four drones in support of a warrant execution at a fortified residential compound in the Inland Empire, CA. Three-phase mission: outer ISR, dynamic entry support, extraction corridor. Single-sortie continuous airborne presence. Thermal imaging identifies 4 heat signatures inside primary structure. SIMULATION ONLY — all details are synthetic.',
  seed: 20003,
  droneCount: 4,
  // HRT stack: two Lemur 2s make interior entry (tight turn rate, short
  // endurance), two X10s hold exterior overwatch.
  dronePlatforms: explicitFleet(['brinc_lemur_2', 'brinc_lemur_2', 'skydio_x10', 'skydio_x10']),
  missionType: 'waypoint',
  startPosition: { lat: 34.5398, lng: -117.2932 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'hrt-01-outer-n',   position: { lat: 34.5425, lng: -117.2945 }, altitudeFt: 180, label: 'Outer-Perim-N',    dwellTimeSec: 18 },
      { id: 'hrt-01-breach-a',  position: { lat: 34.5418, lng: -117.2958 }, altitudeFt: 100, label: 'Breach-Alpha',     dwellTimeSec: 25 },
      { id: 'hrt-01-ext-cor',   position: { lat: 34.5408, lng: -117.2940 }, altitudeFt: 140, label: 'Extract-Corridor', dwellTimeSec: 20 },
      { id: 'hrt-01-clear',     position: { lat: 34.5398, lng: -117.2950 }, altitudeFt: 160, label: 'Clear-Hold',       dwellTimeSec: 15 },
    ],
    'uav-02': [
      { id: 'hrt-02-outer-e',   position: { lat: 34.5412, lng: -117.2918 }, altitudeFt: 200, label: 'Outer-Perim-E',    dwellTimeSec: 18 },
      { id: 'hrt-02-breach-b',  position: { lat: 34.5420, lng: -117.2938 }, altitudeFt: 100, label: 'Breach-Bravo',     dwellTimeSec: 25 },
      { id: 'hrt-02-sec-exit',  position: { lat: 34.5428, lng: -117.2930 }, altitudeFt: 120, label: 'Secondary-Exit',   dwellTimeSec: 20 },
      { id: 'hrt-02-ext-hi',    position: { lat: 34.5415, lng: -117.2935 }, altitudeFt: 180, label: 'Extract-Hi',       dwellTimeSec: 15 },
    ],
    'uav-03': [
      { id: 'hrt-03-outer-s',   position: { lat: 34.5385, lng: -117.2942 }, altitudeFt: 180, label: 'Outer-Perim-S',    dwellTimeSec: 18 },
      { id: 'hrt-03-struct-s',  position: { lat: 34.5408, lng: -117.2950 }, altitudeFt: 120, label: 'Structure-S',      dwellTimeSec: 25 },
      { id: 'hrt-03-garage',    position: { lat: 34.5415, lng: -117.2962 }, altitudeFt: 100, label: 'Garage-Entry',     dwellTimeSec: 20 },
      { id: 'hrt-03-road-s',    position: { lat: 34.5395, lng: -117.2930 }, altitudeFt: 160, label: 'Road-South',       dwellTimeSec: 12 },
    ],
    'uav-04': [
      { id: 'hrt-04-outer-w',   position: { lat: 34.5412, lng: -117.2968 }, altitudeFt: 200, label: 'Outer-Perim-W',    dwellTimeSec: 18 },
      { id: 'hrt-04-overwatch', position: { lat: 34.5420, lng: -117.2952 }, altitudeFt: 220, label: 'Elevated-OW',      dwellTimeSec: 30 },
      { id: 'hrt-04-cmd-link',  position: { lat: 34.5400, lng: -117.2945 }, altitudeFt: 200, label: 'Command-Link',     dwellTimeSec: 25 },
    ],
  },
  geofences: [
    { id: 'gf-hrt-compound', label: 'Primary Structure — Entry Team Only', polygon: [{ lat: 34.5410, lng: -117.2962 }, { lat: 34.5428, lng: -117.2962 }, { lat: 34.5428, lng: -117.2938 }, { lat: 34.5410, lng: -117.2938 }], maxAltitudeFt: 100, type: 'restricted', bypassForMission: true },
  ],
  heatSources: [
    { id: 'hs-hrt-occ-a',   class: 'generic-person', position: { lat: 34.5418, lng: -117.2952 }, tempC: 37,  radiusM: 1 },
    { id: 'hs-hrt-occ-b',   class: 'generic-person', position: { lat: 34.5420, lng: -117.2948 }, tempC: 37,  radiusM: 1 },
    { id: 'hs-hrt-occ-c',   class: 'generic-person', position: { lat: 34.5415, lng: -117.2958 }, tempC: 36,  radiusM: 1 },
    { id: 'hs-hrt-occ-d',   class: 'generic-person', position: { lat: 34.5422, lng: -117.2955 }, tempC: 36,  radiusM: 1 },
    { id: 'hs-hrt-vehicle',  class: 'vehicle',        position: { lat: 34.5412, lng: -117.2945 }, tempC: 95,  radiusM: 3 },
    { id: 'hs-hrt-hrt-veh',  class: 'vehicle',        position: { lat: 34.5398, lng: -117.2932 }, tempC: 80,  radiusM: 4 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.018,
  commsLossWindows: [{ startSec: 120, durationSec: 12 }],
  perDroneMissionRoles: {
    'uav-01': 'Alpha Breach Overwatch — north perimeter / entry corridor',
    'uav-02': 'Bravo Breach Overwatch — east perimeter / secondary exit',
    'uav-03': 'Structure South / Garage — occupant locate & cover',
    'uav-04': 'Elevated Command Link — 220ft sustained comms relay',
  },
}

// ── 4. USCG District 1 — Atlantic Mariner SAR ──────────────────────────────
export const uscgCapeCodeSAR: ScenarioConfig = {
  id: 'extreme_uscg_cape_cod_sar',
  name: 'USCG District 1 — Atlantic Mariner SAR',
  description: 'USCG Sector Southeastern New England deploys five ScanEagle UAS from Air Station Cape Cod for an overdue 28-ft recreational vessel. EPIRB activated at 0214 local. SAROPS drift model projects two probability sectors. Primary detection: thermal — hypothermic survivors at 33–35°C vs 18°C Atlantic water. Two sorties required to cover the full probability area. SIMULATION ONLY.',
  seed: 20004,
  droneCount: 5,
  // Maritime SAR: weatherproof X10D search ships plus an Astro Max mapper.
  dronePlatforms: mixedFleet(5, 'skydio_x10d', 'freefly_astro_max'),
  missionType: 'waypoint',
  startPosition: { lat: 41.6688, lng: -70.2978 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'uscg-01-datum',  position: { lat: 41.6755, lng: -70.2845 }, altitudeFt: 120, label: 'EPIRB-Datum',  dwellTimeSec: 20 },
      { id: 'uscg-01-ne1',    position: { lat: 41.6788, lng: -70.2808 }, altitudeFt: 120, label: 'Square-NE-1',  dwellTimeSec: 15 },
      { id: 'uscg-01-ne2',    position: { lat: 41.6815, lng: -70.2772 }, altitudeFt: 120, label: 'Square-NE-2',  dwellTimeSec: 15 },
      { id: 'uscg-01-ne3',    position: { lat: 41.6842, lng: -70.2808 }, altitudeFt: 100, label: 'Square-NE-3',  dwellTimeSec: 20 },
    ],
    'uav-02': [
      { id: 'uscg-02-se1',    position: { lat: 41.6722, lng: -70.2808 }, altitudeFt: 100, label: 'Search-SE-1',  dwellTimeSec: 15 },
      { id: 'uscg-02-se2',    position: { lat: 41.6690, lng: -70.2772 }, altitudeFt: 100, label: 'Search-SE-2',  dwellTimeSec: 20 },
      { id: 'uscg-02-se3',    position: { lat: 41.6658, lng: -70.2808 }, altitudeFt: 100, label: 'Search-SE-3',  dwellTimeSec: 15 },
      { id: 'uscg-02-se4',    position: { lat: 41.6690, lng: -70.2845 }, altitudeFt: 120, label: 'Search-SE-4',  dwellTimeSec: 20 },
    ],
    'uav-03': [
      { id: 'uscg-03-e1',     position: { lat: 41.6755, lng: -70.2772 }, altitudeFt: 80,  label: 'Drift-E-1',   dwellTimeSec: 20 },
      { id: 'uscg-03-e2',     position: { lat: 41.6788, lng: -70.2738 }, altitudeFt: 80,  label: 'Drift-E-2',   dwellTimeSec: 25 },
      { id: 'uscg-03-e3',     position: { lat: 41.6722, lng: -70.2738 }, altitudeFt: 80,  label: 'Drift-E-3',   dwellTimeSec: 20 },
    ],
    'uav-04': [
      { id: 'uscg-04-w1',     position: { lat: 41.6755, lng: -70.2918 }, altitudeFt: 100, label: 'Drift-W-1',   dwellTimeSec: 15 },
      { id: 'uscg-04-w2',     position: { lat: 41.6788, lng: -70.2955 }, altitudeFt: 100, label: 'Drift-W-2',   dwellTimeSec: 15 },
      { id: 'uscg-04-w3',     position: { lat: 41.6722, lng: -70.2955 }, altitudeFt: 100, label: 'Drift-W-3',   dwellTimeSec: 20 },
    ],
    'uav-05': [
      { id: 'uscg-05-relay',   position: { lat: 41.6755, lng: -70.2845 }, altitudeFt: 250, label: 'SAR-Relay-Hi', dwellTimeSec: 60 },
      { id: 'uscg-05-contact', position: { lat: 41.6780, lng: -70.2798 }, altitudeFt: 200, label: 'Contact-Zone', dwellTimeSec: 30 },
    ],
  },
  geofences: [
    { id: 'gf-uscg-marhelo', label: 'MH-60 Approach Corridor', polygon: [{ lat: 41.6730, lng: -70.2870 }, { lat: 41.6780, lng: -70.2870 }, { lat: 41.6780, lng: -70.2818 }, { lat: 41.6730, lng: -70.2818 }], maxAltitudeFt: 200, type: 'restricted', bypassForMission: true },
  ],
  heatSources: [
    { id: 'hs-uscg-surv-a',  class: 'generic-person', position: { lat: 41.6820, lng: -70.2790 }, tempC: 34,  radiusM: 1 },
    { id: 'hs-uscg-surv-b',  class: 'generic-person', position: { lat: 41.6822, lng: -70.2792 }, tempC: 33,  radiusM: 1 },
    { id: 'hs-uscg-vessel',  class: 'vehicle',         position: { lat: 41.6818, lng: -70.2788 }, tempC: 25,  radiusM: 4 },
    { id: 'hs-uscg-cutter',  class: 'vehicle',         position: { lat: 41.6700, lng: -70.2900 }, tempC: 120, radiusM: 8 },
    { id: 'hs-uscg-water',   class: 'heat-source',     position: { lat: 41.6755, lng: -70.2845 }, tempC: 18,  radiusM: 30 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.022,
  rechargeTimeSec: 45,
  maxSorties: 2,
  commsLossWindows: [{ startSec: 220, durationSec: 25 }],
  perDroneMissionRoles: {
    'uav-01': 'NE Probability Sector — EPIRB datum expanding square',
    'uav-02': 'SE Probability Sector — SAROPS drift track south',
    'uav-03': 'Eastward Drift Track — secondary current vector',
    'uav-04': 'Westward Drift Track — counter-current back-drift',
    'uav-05': 'SAR Comms Relay / Contact — 250ft hi-alt MH-60 link',
  },
}

// ── 5. USSS JOTSC — Presidential Visit San Francisco ──────────────────────
export const usssPresidentialSF: ScenarioConfig = {
  id: 'extreme_usss_presidential_sf',
  // WP-8 §18.4: Moscone/Union Square/Nob Hill is dense-urban SF core.
  rfClutter: 'dense_urban',
  name: 'USSS — Presidential Visit SF Advance Sweep',
  description: 'USSS JOTSC deploys five drone platforms for a presidential site advance at Moscone Center. Drones sweep: Moscone exterior/docks, motorcade route on 3rd to Market, Union Square and Westin perimeter, Powell Street BART plaza, Nob Hill hotel exterior. Single-sortie advance sweep before POTUS motorcade. SIMULATION ONLY.',
  seed: 20005,
  droneCount: 5,
  // Protective detail: uniform X10 fleet for consistent overwatch timing.
  dronePlatforms: mixedFleet(5, 'skydio_x10'),
  missionType: 'waypoint',
  startPosition: { lat: 37.7838, lng: -122.4000 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'usss-01-mosc-n',    position: { lat: 37.7848, lng: -122.3998 }, altitudeFt: 140, label: 'Moscone-North',   dwellTimeSec: 15 },
      { id: 'usss-01-mosc-roof', position: { lat: 37.7838, lng: -122.4010 }, altitudeFt: 160, label: 'Moscone-Roof',    dwellTimeSec: 20 },
      { id: 'usss-01-dock',      position: { lat: 37.7828, lng: -122.4000 }, altitudeFt: 100, label: 'Loading-Dock',    dwellTimeSec: 20 },
      { id: 'usss-01-howard',    position: { lat: 37.7820, lng: -122.3992 }, altitudeFt: 120, label: 'Howard-St',       dwellTimeSec: 12 },
    ],
    'uav-02': [
      { id: 'usss-02-3rd-n',     position: { lat: 37.7862, lng: -122.4000 }, altitudeFt: 160, label: '3rd-St-N',        dwellTimeSec: 12 },
      { id: 'usss-02-market',    position: { lat: 37.7879, lng: -122.4035 }, altitudeFt: 160, label: 'Market-St',       dwellTimeSec: 15 },
      { id: 'usss-02-nob-appr',  position: { lat: 37.7918, lng: -122.4128 }, altitudeFt: 200, label: 'Nob-Approach',    dwellTimeSec: 12 },
    ],
    'uav-03': [
      { id: 'usss-03-usq-n',     position: { lat: 37.7882, lng: -122.4075 }, altitudeFt: 140, label: 'Union-Sq-N',      dwellTimeSec: 15 },
      { id: 'usss-03-westin',    position: { lat: 37.7878, lng: -122.4093 }, altitudeFt: 160, label: 'Westin-Perim',    dwellTimeSec: 20 },
      { id: 'usss-03-usq-s',     position: { lat: 37.7868, lng: -122.4078 }, altitudeFt: 120, label: 'Union-Sq-S',      dwellTimeSec: 15 },
    ],
    'uav-04': [
      { id: 'usss-04-powell',    position: { lat: 37.7843, lng: -122.4082 }, altitudeFt: 180, label: 'Powell-Turnaround', dwellTimeSec: 20 },
      { id: 'usss-04-bart',      position: { lat: 37.7849, lng: -122.4085 }, altitudeFt: 160, label: 'BART-Plaza',       dwellTimeSec: 20 },
      { id: 'usss-04-4th-st',    position: { lat: 37.7855, lng: -122.4065 }, altitudeFt: 140, label: '4th-Kearny',       dwellTimeSec: 12 },
    ],
    'uav-05': [
      { id: 'usss-05-nob-n',     position: { lat: 37.7924, lng: -122.4148 }, altitudeFt: 200, label: 'Nob-Hill-N',       dwellTimeSec: 20 },
      { id: 'usss-05-grace',     position: { lat: 37.7918, lng: -122.4160 }, altitudeFt: 180, label: 'Grace-Cathedral',  dwellTimeSec: 20 },
      { id: 'usss-05-hotel',     position: { lat: 37.7912, lng: -122.4142 }, altitudeFt: 160, label: 'Hotel-Sweep',      dwellTimeSec: 15 },
    ],
  },
  geofences: [
    { id: 'gf-usss-tfr',  label: 'POTUS TFR — USSS Authorized',  polygon: [{ lat: 37.7900, lng: -122.4160 }, { lat: 37.7950, lng: -122.4160 }, { lat: 37.7950, lng: -122.4100 }, { lat: 37.7900, lng: -122.4100 }], maxAltitudeFt: 0,   type: 'no_fly',    bypassForMission: true },
    { id: 'gf-usss-mosc', label: 'Moscone Secured Zone',          polygon: [{ lat: 37.7820, lng: -122.4020 }, { lat: 37.7858, lng: -122.4020 }, { lat: 37.7858, lng: -122.3982 }, { lat: 37.7820, lng: -122.3982 }], maxAltitudeFt: 200, type: 'restricted', bypassForMission: true },
  ],
  heatSources: [
    { id: 'hs-usss-hvac-a',  class: 'heat-source',    position: { lat: 37.7840, lng: -122.4005 }, tempC: 85,  radiusM: 5 },
    { id: 'hs-usss-crowd-a', class: 'generic-person', position: { lat: 37.7879, lng: -122.4075 }, tempC: 37,  radiusM: 8 },
    { id: 'hs-usss-crowd-b', class: 'generic-person', position: { lat: 37.7843, lng: -122.4082 }, tempC: 36,  radiusM: 6 },
    { id: 'hs-usss-veh-a',   class: 'vehicle',        position: { lat: 37.7838, lng: -122.4000 }, tempC: 75,  radiusM: 3 },
    { id: 'hs-usss-veh-b',   class: 'vehicle',        position: { lat: 37.7828, lng: -122.3998 }, tempC: 70,  radiusM: 4 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.020,
  commsLossWindows: [{ startSec: 75, durationSec: 10 }],
  perDroneMissionRoles: {
    'uav-01': 'Moscone Exterior / Loading Dock — site advance sweep',
    'uav-02': '3rd St Motorcade Route → Nob Hill Approach',
    'uav-03': 'Union Square & Westin St. Francis perimeter',
    'uav-04': 'Powell BART Plaza — crowd density / threat scan',
    'uav-05': 'Nob Hill Hotel Exterior — POTUS overnight secure sweep',
  },
}

// ── 6. FEMA USAR — Hurricane Ian Aftermath, Fort Myers Beach ──────────────
export const femaFortMyers: ScenarioConfig = {
  id: 'extreme_fema_fort_myers',
  name: 'FEMA USAR — Hurricane Ian, Fort Myers Beach',
  description: 'FEMA USAR Florida Task Force 4 deploys five DJI Matrice 300 RTK drones from a north-end staging area to grid-search the north sector of Estero Island after Hurricane Ian. Storm surge collapsed ~40% of structures. Primary survivor signature: 36–37°C trapped in void vs 88°F ambient debris. Four parallel lanes sweep north→south while a fifth drone holds high as a comms relay. SIMULATION ONLY.',
  seed: 20006,
  droneCount: 5,
  // Disaster response: X10D search ships with an Astro Max damage-mapping bird.
  dronePlatforms: mixedFleet(5, 'skydio_x10d', 'freefly_astro_max'),
  missionType: 'waypoint',
  // Staging area at the north tip (Bowditch Point vicinity) — on land and clear
  // of both the over-water limit and the USAR helo LZ no-fly. Launch bays fan out
  // automatically from here via the coordinated launch planner.
  startPosition: { lat: 26.4650, lng: -81.9550 },
  waypoints: [],
  // Four parallel search lanes (~155 m apart E–W) sweeping the ~1 km north sector
  // N→S, plus a high relay. No shared points; the helo LZ is routed around, not
  // flown through. Survivor-contact dwells sit on the actual heat signatures.
  perDroneWaypoints: {
    'uav-01': [
      { id: 'fm-01-lane-n',   position: { lat: 26.4648, lng: -81.9562 }, altitudeFt: 80,  label: 'Lane1-North',   dwellTimeSec: 14 },
      { id: 'fm-01-contact-a', position: { lat: 26.4622, lng: -81.9563 }, altitudeFt: 60,  label: 'Contact-Alpha', dwellTimeSec: 24 },
      { id: 'fm-01-lane-m',   position: { lat: 26.4602, lng: -81.9562 }, altitudeFt: 80,  label: 'Lane1-Mid',     dwellTimeSec: 14 },
      { id: 'fm-01-lane-s',   position: { lat: 26.4564, lng: -81.9562 }, altitudeFt: 80,  label: 'Lane1-South',   dwellTimeSec: 16 },
    ],
    'uav-02': [
      { id: 'fm-02-lane-n',   position: { lat: 26.4648, lng: -81.9546 }, altitudeFt: 100, label: 'Lane2-North',   dwellTimeSec: 14 },
      { id: 'fm-02-contact-b', position: { lat: 26.4638, lng: -81.9544 }, altitudeFt: 60,  label: 'Contact-Bravo', dwellTimeSec: 24 },
      { id: 'fm-02-lane-m',   position: { lat: 26.4602, lng: -81.9546 }, altitudeFt: 100, label: 'Lane2-Mid',     dwellTimeSec: 14 },
      { id: 'fm-02-lane-s',   position: { lat: 26.4564, lng: -81.9546 }, altitudeFt: 100, label: 'Lane2-South',   dwellTimeSec: 16 },
    ],
    'uav-03': [
      { id: 'fm-03-lane-n',   position: { lat: 26.4648, lng: -81.9530 }, altitudeFt: 120, label: 'Lane3-North',   dwellTimeSec: 14 },
      { id: 'fm-03-lane-m',   position: { lat: 26.4602, lng: -81.9530 }, altitudeFt: 120, label: 'Lane3-Mid',     dwellTimeSec: 14 },
      { id: 'fm-03-struct-c', position: { lat: 26.4582, lng: -81.9530 }, altitudeFt: 90,  label: 'Structure-C',   dwellTimeSec: 22 },
      { id: 'fm-03-lane-s',   position: { lat: 26.4564, lng: -81.9530 }, altitudeFt: 120, label: 'Lane3-South',   dwellTimeSec: 16 },
    ],
    'uav-04': [
      { id: 'fm-04-lane-n',   position: { lat: 26.4648, lng: -81.9514 }, altitudeFt: 140, label: 'Lane4-North',   dwellTimeSec: 14 },
      { id: 'fm-04-lane-m',   position: { lat: 26.4602, lng: -81.9514 }, altitudeFt: 140, label: 'Lane4-Mid',     dwellTimeSec: 14 },
      { id: 'fm-04-beach',    position: { lat: 26.4564, lng: -81.9512 }, altitudeFt: 110, label: 'Beach-Edge',    dwellTimeSec: 15 },
    ],
    'uav-05': [
      { id: 'fm-05-relay',    position: { lat: 26.4606, lng: -81.9538 }, altitudeFt: 220, label: 'USAR-Relay',    dwellTimeSec: 90 },
      { id: 'fm-05-relay-s',  position: { lat: 26.4576, lng: -81.9538 }, altitudeFt: 200, label: 'Relay-South',   dwellTimeSec: 40 },
    ],
  },
  geofences: [
    { id: 'gf-fm-water', label: 'Estero Bay — Over Water Limit', polygon: [{ lat: 26.4580, lng: -81.9580 }, { lat: 26.4600, lng: -81.9580 }, { lat: 26.4600, lng: -81.9610 }, { lat: 26.4580, lng: -81.9610 }], maxAltitudeFt: 0, type: 'no_fly' },
    { id: 'gf-fm-helo',  label: 'USAR Helo LZ — No Fly',        polygon: [{ lat: 26.4610, lng: -81.9548 }, { lat: 26.4622, lng: -81.9548 }, { lat: 26.4622, lng: -81.9558 }, { lat: 26.4610, lng: -81.9558 }], maxAltitudeFt: 0, type: 'no_fly' },
  ],
  heatSources: [
    { id: 'hs-fm-surv-a',   class: 'generic-person', position: { lat: 26.4622, lng: -81.9563 }, tempC: 37,  radiusM: 1 },
    { id: 'hs-fm-surv-b',   class: 'generic-person', position: { lat: 26.4638, lng: -81.9544 }, tempC: 36,  radiusM: 1 },
    { id: 'hs-fm-debris-a', class: 'heat-source',    position: { lat: 26.4630, lng: -81.9552 }, tempC: 55,  radiusM: 8 },
    { id: 'hs-fm-debris-b', class: 'heat-source',    position: { lat: 26.4618, lng: -81.9530 }, tempC: 52,  radiusM: 6 },
    { id: 'hs-fm-usar-veh', class: 'vehicle',         position: { lat: 26.4617, lng: -81.9554 }, tempC: 80,  radiusM: 4 },
    { id: 'hs-fm-helo',     class: 'vehicle',         position: { lat: 26.4615, lng: -81.9550 }, tempC: 120, radiusM: 5 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.022,
  rechargeTimeSec: 60,
  maxSorties: 2,
  commsLossWindows: [{ startSec: 95, durationSec: 18 }, { startSec: 410, durationSec: 18 }],
  perDroneMissionRoles: {
    'uav-01': 'Strip 1 — debris grid search, western island',
    'uav-02': 'Strip 2 — void space thermal, central lane',
    'uav-03': 'Strip 3 — structure collapse east, survivor detection',
    'uav-04': 'Strip 4 — beach edge and seawall collapse',
    'uav-05': 'USAR Relay — 220ft AGL, task force comms bridge',
  },
}

// ── 7. ATF Group IX — Oakland Stash House Surveillance ────────────────────
export const atfOaklandStash: ScenarioConfig = {
  id: 'extreme_atf_oakland_stash',
  name: 'ATF Group IX — Oakland Stash Surveillance',
  description: 'ATF San Francisco Field Division Group IX deploys four drones in support of a Title III surveillance operation targeting a firearms trafficking network in East Oakland. Two sorties — Sortie 1 covers pre-distribution window, Sortie 2 covers the distribution period after recharge. SIMULATION ONLY — all locations are synthetic.',
  seed: 20007,
  droneCount: 4,
  // Urban surveillance: X10 primaries with an Anafi for fast relocation.
  dronePlatforms: mixedFleet(4, 'skydio_x10', 'parrot_anafi_usa'),
  missionType: 'waypoint',
  startPosition: { lat: 37.7385, lng: -122.1935 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'atf-01-stash-a-n',   position: { lat: 37.7408, lng: -122.1952 }, altitudeFt: 100, label: 'StashA-North',   dwellTimeSec: 20 },
      { id: 'atf-01-stash-a',     position: { lat: 37.7400, lng: -122.1960 }, altitudeFt: 80,  label: 'StashA-Main',    dwellTimeSec: 30 },
      { id: 'atf-01-vehicle-stg', position: { lat: 37.7392, lng: -122.1955 }, altitudeFt: 100, label: 'VehicleStaging', dwellTimeSec: 20 },
    ],
    'uav-02': [
      { id: 'atf-02-stash-b-e',   position: { lat: 37.7415, lng: -122.1918 }, altitudeFt: 120, label: 'StashB-East',    dwellTimeSec: 20 },
      { id: 'atf-02-stash-b',     position: { lat: 37.7405, lng: -122.1925 }, altitudeFt: 80,  label: 'StashB-Main',    dwellTimeSec: 30 },
      { id: 'atf-02-alley-n',     position: { lat: 37.7418, lng: -122.1930 }, altitudeFt: 100, label: 'Alley-North',    dwellTimeSec: 15 },
    ],
    'uav-03': [
      { id: 'atf-03-corr-n',      position: { lat: 37.7418, lng: -122.1942 }, altitudeFt: 120, label: 'Corridor-N',     dwellTimeSec: 15 },
      { id: 'atf-03-handoff',     position: { lat: 37.7408, lng: -122.1938 }, altitudeFt: 100, label: 'Handoff-Point',  dwellTimeSec: 25 },
      { id: 'atf-03-corr-s',      position: { lat: 37.7395, lng: -122.1940 }, altitudeFt: 120, label: 'Corridor-S',     dwellTimeSec: 15 },
      { id: 'atf-03-alley-s',     position: { lat: 37.7390, lng: -122.1948 }, altitudeFt: 100, label: 'Alley-South',    dwellTimeSec: 15 },
    ],
    'uav-04': [
      { id: 'atf-04-relay',       position: { lat: 37.7405, lng: -122.1940 }, altitudeFt: 220, label: 'Relay-OW',       dwellTimeSec: 60 },
      { id: 'atf-04-relay-s',     position: { lat: 37.7388, lng: -122.1945 }, altitudeFt: 200, label: 'Relay-South',    dwellTimeSec: 30 },
    ],
  },
  geofences: [
    { id: 'gf-atf-bart', label: 'BART Elevated Structure — Restricted', polygon: [{ lat: 37.7378, lng: -122.1962 }, { lat: 37.7428, lng: -122.1962 }, { lat: 37.7428, lng: -122.1952 }, { lat: 37.7378, lng: -122.1952 }], maxAltitudeFt: 100, type: 'restricted' },
  ],
  heatSources: [
    { id: 'hs-atf-contact-a', class: 'generic-person', position: { lat: 37.7400, lng: -122.1958 }, tempC: 37,  radiusM: 1 },
    { id: 'hs-atf-contact-b', class: 'generic-person', position: { lat: 37.7405, lng: -122.1925 }, tempC: 37,  radiusM: 1 },
    { id: 'hs-atf-vehicle-a', class: 'vehicle',         position: { lat: 37.7395, lng: -122.1952 }, tempC: 90,  radiusM: 3 },
    { id: 'hs-atf-vehicle-b', class: 'vehicle',         position: { lat: 37.7408, lng: -122.1928 }, tempC: 85,  radiusM: 3 },
    { id: 'hs-atf-hvac',      class: 'heat-source',     position: { lat: 37.7402, lng: -122.1962 }, tempC: 65,  radiusM: 4 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.020,
  rechargeTimeSec: 45,
  maxSorties: 2,
  commsLossWindows: [{ startSec: 140, durationSec: 15 }],
  perDroneMissionRoles: {
    'uav-01': 'Stash Alpha — pre-distribution vehicle staging watch',
    'uav-02': 'Stash Bravo — east network node surveillance',
    'uav-03': 'Transit Corridor — handoff tracking between sites',
    'uav-04': 'Hi-Alt Relay / Overwatch — 220ft persistent area surveillance',
  },
}

// ── 8. DHS CIKR — Port of LA Chemical Spill Response ──────────────────────
export const dhsPortLAChemical: ScenarioConfig = {
  id: 'extreme_dhs_port_la_chemical',
  name: 'DHS CIKR — Port of LA Chemical Response',
  description: 'DHS coordinates with LAFD HazMat and USCG Marine Safety Unit for a chemical container breach at Port of LA Berth 302. Five drones deployed under LAFD ICS: source characterization, downwind plume tracking (NW at 8 knots), container yard sweep, Seaside Ave perimeter, and ICP comms relay. Single-sortie rapid response. SIMULATION ONLY.',
  seed: 20008,
  droneCount: 5,
  // Port perimeter: light Anafi patrols with an X10 for endurance overwatch.
  dronePlatforms: mixedFleet(5, 'parrot_anafi_usa', 'skydio_x10'),
  missionType: 'waypoint',
  startPosition: { lat: 33.7321, lng: -118.2699 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'dhs-01-source',     position: { lat: 33.7332, lng: -118.2715 }, altitudeFt: 100, label: 'Source-Container', dwellTimeSec: 25 },
      { id: 'dhs-01-berth',      position: { lat: 33.7325, lng: -118.2722 }, altitudeFt: 80,  label: 'Berth-302',       dwellTimeSec: 20 },
      { id: 'dhs-01-plume-orig', position: { lat: 33.7338, lng: -118.2710 }, altitudeFt: 120, label: 'Plume-Origin',    dwellTimeSec: 20 },
    ],
    'uav-02': [
      { id: 'dhs-02-plume-a',    position: { lat: 33.7345, lng: -118.2730 }, altitudeFt: 120, label: 'Plume-Track-A',   dwellTimeSec: 20 },
      { id: 'dhs-02-plume-b',    position: { lat: 33.7355, lng: -118.2748 }, altitudeFt: 140, label: 'Plume-Track-B',   dwellTimeSec: 20 },
      { id: 'dhs-02-plume-c',    position: { lat: 33.7362, lng: -118.2765 }, altitudeFt: 140, label: 'Plume-Track-C',   dwellTimeSec: 20 },
    ],
    'uav-03': [
      { id: 'dhs-03-cyard-e',    position: { lat: 33.7340, lng: -118.2700 }, altitudeFt: 100, label: 'ContainerYard-E', dwellTimeSec: 15 },
      { id: 'dhs-03-cyard-n',    position: { lat: 33.7352, lng: -118.2708 }, altitudeFt: 100, label: 'ContainerYard-N', dwellTimeSec: 15 },
      { id: 'dhs-03-residential',position: { lat: 33.7365, lng: -118.2720 }, altitudeFt: 120, label: 'Residential-Edge', dwellTimeSec: 20 },
    ],
    'uav-04': [
      { id: 'dhs-04-perim-n',    position: { lat: 33.7358, lng: -118.2690 }, altitudeFt: 160, label: 'Perim-North',     dwellTimeSec: 15 },
      { id: 'dhs-04-perim-e',    position: { lat: 33.7335, lng: -118.2675 }, altitudeFt: 160, label: 'Perim-East',      dwellTimeSec: 12 },
      { id: 'dhs-04-seaside',    position: { lat: 33.7318, lng: -118.2690 }, altitudeFt: 140, label: 'Seaside-Ave',     dwellTimeSec: 15 },
      { id: 'dhs-04-perim-w',    position: { lat: 33.7312, lng: -118.2710 }, altitudeFt: 160, label: 'Perim-West',      dwellTimeSec: 12 },
    ],
    'uav-05': [
      { id: 'dhs-05-relay',      position: { lat: 33.7335, lng: -118.2698 }, altitudeFt: 240, label: 'ICP-Relay',       dwellTimeSec: 60 },
      { id: 'dhs-05-harbour',    position: { lat: 33.7310, lng: -118.2705 }, altitudeFt: 200, label: 'Harbour-Link',    dwellTimeSec: 30 },
    ],
  },
  geofences: [
    { id: 'gf-dhs-hot-zone', label: 'Chemical Hot Zone — No Entry',     polygon: [{ lat: 33.7322, lng: -118.2728 }, { lat: 33.7345, lng: -118.2728 }, { lat: 33.7345, lng: -118.2705 }, { lat: 33.7322, lng: -118.2705 }], maxAltitudeFt: 0,   type: 'no_fly' },
    { id: 'gf-dhs-vessel',   label: 'Active Vessel Berths — Restricted', polygon: [{ lat: 33.7308, lng: -118.2725 }, { lat: 33.7325, lng: -118.2725 }, { lat: 33.7325, lng: -118.2742 }, { lat: 33.7308, lng: -118.2742 }], maxAltitudeFt: 150, type: 'restricted' },
  ],
  heatSources: [
    { id: 'hs-dhs-container', class: 'heat-source', position: { lat: 33.7332, lng: -118.2715 }, tempC: 25,  radiusM: 6 },
    { id: 'hs-dhs-plume-a',   class: 'heat-source', position: { lat: 33.7348, lng: -118.2738 }, tempC: 15,  radiusM: 12 },
    { id: 'hs-dhs-crane-a',   class: 'vehicle',     position: { lat: 33.7328, lng: -118.2720 }, tempC: 95,  radiusM: 5 },
    { id: 'hs-dhs-crane-b',   class: 'vehicle',     position: { lat: 33.7335, lng: -118.2702 }, tempC: 90,  radiusM: 5 },
    { id: 'hs-dhs-lafd-eng',  class: 'vehicle',     position: { lat: 33.7321, lng: -118.2699 }, tempC: 110, radiusM: 4 },
    { id: 'hs-dhs-uscg-ctr',  class: 'vehicle',     position: { lat: 33.7315, lng: -118.2708 }, tempC: 105, radiusM: 4 },
    { id: 'hs-dhs-decon',     class: 'heat-source', position: { lat: 33.7318, lng: -118.2695 }, tempC: 65,  radiusM: 6 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.022,
  commsLossWindows: [{ startSec: 85, durationSec: 12 }],
  perDroneMissionRoles: {
    'uav-01': 'Source Characterization — Berth 302 container plume origin',
    'uav-02': 'Plume Track — downwind dispersion NW at 8 knots',
    'uav-03': 'Container Yard Sweep — secondary exposure risk grid',
    'uav-04': 'Seaside Ave Perimeter — evacuation zone boundary watch',
    'uav-05': 'ICP Comms Relay — 240ft link to Marine Safety Unit',
  },
}

// ── 9. LAPD SkyWatch — Skid Row Welfare Grid ──────────────────────────────
export const lapdSkidRowWelfare: ScenarioConfig = {
  id: 'extreme_lapd_skid_row_welfare',
  name: 'LAPD SkyWatch — Skid Row Welfare Grid',
  description: 'LAPD Air Support Division SkyWatch deploys five drones with LA County DMH and LAHSA for a welfare check grid in Skid Row during a 112°F heat advisory. Thermal: identify individuals with elevated skin temp (>39°C hyperthermia) or motionless. Location and condition only — no identity data logged. Two staggered sorties. SIMULATION ONLY.',
  seed: 20009,
  droneCount: 5,
  // Urban welfare checks: X10 primaries with a compact Anafi.
  dronePlatforms: mixedFleet(5, 'skydio_x10', 'parrot_anafi_usa'),
  missionType: 'waypoint',
  startPosition: { lat: 34.0422, lng: -118.2472 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'sr-01-5th-e',     position: { lat: 34.0438, lng: -118.2455 }, altitudeFt: 80,  label: '5th-St-East',    dwellTimeSec: 15 },
      { id: 'sr-01-6th-e',     position: { lat: 34.0430, lng: -118.2455 }, altitudeFt: 80,  label: '6th-St-East',    dwellTimeSec: 15 },
      { id: 'sr-01-7th-e',     position: { lat: 34.0422, lng: -118.2455 }, altitudeFt: 80,  label: '7th-St-East',    dwellTimeSec: 18 },
      { id: 'sr-01-contact-a', position: { lat: 34.0428, lng: -118.2458 }, altitudeFt: 60,  label: 'Contact-A',      dwellTimeSec: 20 },
    ],
    'uav-02': [
      { id: 'sr-02-5th-c',     position: { lat: 34.0438, lng: -118.2470 }, altitudeFt: 100, label: '5th-St-Ctr',     dwellTimeSec: 15 },
      { id: 'sr-02-6th-c',     position: { lat: 34.0430, lng: -118.2470 }, altitudeFt: 100, label: '6th-St-Ctr',     dwellTimeSec: 15 },
      { id: 'sr-02-7th-c',     position: { lat: 34.0422, lng: -118.2470 }, altitudeFt: 100, label: '7th-St-Ctr',     dwellTimeSec: 18 },
      { id: 'sr-02-contact-b', position: { lat: 34.0432, lng: -118.2468 }, altitudeFt: 60,  label: 'Contact-B',      dwellTimeSec: 20 },
    ],
    'uav-03': [
      { id: 'sr-03-5th-w',     position: { lat: 34.0438, lng: -118.2485 }, altitudeFt: 120, label: '5th-St-West',    dwellTimeSec: 15 },
      { id: 'sr-03-6th-w',     position: { lat: 34.0430, lng: -118.2485 }, altitudeFt: 120, label: '6th-St-West',    dwellTimeSec: 15 },
      { id: 'sr-03-7th-w',     position: { lat: 34.0422, lng: -118.2485 }, altitudeFt: 120, label: '7th-St-West',    dwellTimeSec: 18 },
    ],
    'uav-04': [
      { id: 'sr-04-alley-n',   position: { lat: 34.0442, lng: -118.2472 }, altitudeFt: 80,  label: 'Alley-North',    dwellTimeSec: 15 },
      { id: 'sr-04-alley-m',   position: { lat: 34.0432, lng: -118.2475 }, altitudeFt: 80,  label: 'Alley-Mid',      dwellTimeSec: 18 },
      { id: 'sr-04-alley-s',   position: { lat: 34.0418, lng: -118.2478 }, altitudeFt: 80,  label: 'Alley-South',    dwellTimeSec: 15 },
    ],
    'uav-05': [
      { id: 'sr-05-relay',     position: { lat: 34.0430, lng: -118.2472 }, altitudeFt: 200, label: 'SkyWatch-Relay',  dwellTimeSec: 60 },
      { id: 'sr-05-contact-c', position: { lat: 34.0418, lng: -118.2460 }, altitudeFt: 160, label: 'Contact-C',      dwellTimeSec: 30 },
    ],
  },
  geofences: [
    { id: 'gf-sr-usc-hosp', label: 'LAC+USC Med Helo Corridor', polygon: [{ lat: 34.0410, lng: -118.2500 }, { lat: 34.0420, lng: -118.2500 }, { lat: 34.0420, lng: -118.2450 }, { lat: 34.0410, lng: -118.2450 }], maxAltitudeFt: 0, type: 'no_fly' },
  ],
  heatSources: [
    { id: 'hs-sr-person-a', class: 'generic-person', position: { lat: 34.0428, lng: -118.2457 }, tempC: 40,  radiusM: 1 },
    { id: 'hs-sr-person-b', class: 'generic-person', position: { lat: 34.0432, lng: -118.2468 }, tempC: 39,  radiusM: 1 },
    { id: 'hs-sr-person-c', class: 'generic-person', position: { lat: 34.0418, lng: -118.2460 }, tempC: 41,  radiusM: 1 },
    { id: 'hs-sr-crowd',    class: 'generic-person', position: { lat: 34.0425, lng: -118.2472 }, tempC: 37,  radiusM: 10 },
    { id: 'hs-sr-asphalt',  class: 'heat-source',    position: { lat: 34.0430, lng: -118.2470 }, tempC: 62,  radiusM: 15 },
    { id: 'hs-sr-dmh-van',  class: 'vehicle',        position: { lat: 34.0422, lng: -118.2472 }, tempC: 75,  radiusM: 3 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.020,
  rechargeTimeSec: 30,
  maxSorties: 2,
  commsLossWindows: [{ startSec: 80, durationSec: 10 }],
  perDroneMissionRoles: {
    'uav-01': 'East Grid — 5th–7th St eastern lane welfare thermal',
    'uav-02': 'Central Grid — 5th–7th St center lane contact locate',
    'uav-03': 'West Grid — 5th–7th St western lane, alley approach',
    'uav-04': 'Alley Sweep — north–south alley network between streets',
    'uav-05': 'SkyWatch Relay — 200ft persistent area link to DMH ground teams',
  },
}

// ── 10. NYPD Aviation — Times Square MCI ──────────────────────────────────
export const nypdTimesSqMCI: ScenarioConfig = {
  id: 'extreme_nypd_times_sq_mci',
  // WP-8 §18.4: Times Square is the canonical dense-urban case.
  rfClutter: 'dense_urban',
  name: 'NYPD Aviation — Times Square MCI',
  description: 'NYPD Aviation Unit deploys five drones for a mass casualty incident at Times Square, coordinating with FDNY EMS and ESU. Sectors: Broadway/7th Ave incident zone, 47th–49th St crowd flow, 42nd–45th St/Port Authority, TKTS elevated overwatch, comms relay. Two sorties for secondary search of surrounding blocks. SIMULATION ONLY.',
  seed: 20010,
  droneCount: 5,
  // Urban MCI: X10 primaries with an Anafi for rapid repositioning.
  dronePlatforms: mixedFleet(5, 'skydio_x10', 'parrot_anafi_usa'),
  missionType: 'waypoint',
  startPosition: { lat: 40.7570, lng: -73.9862 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'ts-01-plaza-ctr', position: { lat: 40.7580, lng: -73.9855 }, altitudeFt: 120, label: 'Plaza-Center',    dwellTimeSec: 20 },
      { id: 'ts-01-incident',  position: { lat: 40.7588, lng: -73.9856 }, altitudeFt: 100, label: 'Incident-Zone',   dwellTimeSec: 25 },
      { id: 'ts-01-broadway',  position: { lat: 40.7575, lng: -73.9862 }, altitudeFt: 120, label: 'Broadway-S',      dwellTimeSec: 15 },
    ],
    'uav-02': [
      { id: 'ts-02-north-47', position: { lat: 40.7600, lng: -73.9855 }, altitudeFt: 140, label: '47th-St',          dwellTimeSec: 15 },
      { id: 'ts-02-north-49', position: { lat: 40.7612, lng: -73.9862 }, altitudeFt: 140, label: '49th-St',          dwellTimeSec: 15 },
      { id: 'ts-02-crowd-n',  position: { lat: 40.7605, lng: -73.9858 }, altitudeFt: 120, label: 'Crowd-North',      dwellTimeSec: 18 },
    ],
    'uav-03': [
      { id: 'ts-03-42nd',     position: { lat: 40.7558, lng: -73.9878 }, altitudeFt: 140, label: '42nd-St',          dwellTimeSec: 15 },
      { id: 'ts-03-45th',     position: { lat: 40.7568, lng: -73.9865 }, altitudeFt: 120, label: '45th-St',          dwellTimeSec: 15 },
      { id: 'ts-03-pa-bus',   position: { lat: 40.7570, lng: -73.9900 }, altitudeFt: 160, label: 'PA-BusTerminal',   dwellTimeSec: 18 },
    ],
    'uav-04': [
      { id: 'ts-04-tkts',      position: { lat: 40.7580, lng: -73.9858 }, altitudeFt: 200, label: 'TKTS-Overwatch',  dwellTimeSec: 30 },
      { id: 'ts-04-one-times', position: { lat: 40.7590, lng: -73.9851 }, altitudeFt: 220, label: 'One-Times-Sq',   dwellTimeSec: 30 },
    ],
    'uav-05': [
      { id: 'ts-05-relay',     position: { lat: 40.7585, lng: -73.9855 }, altitudeFt: 260, label: 'Aviation-Relay',  dwellTimeSec: 60 },
      { id: 'ts-05-esu-link',  position: { lat: 40.7562, lng: -73.9870 }, altitudeFt: 220, label: 'ESU-Ground-Link', dwellTimeSec: 30 },
    ],
  },
  geofences: [
    { id: 'gf-ts-theatre-row', label: 'Theatre Row — No Fly',   polygon: [{ lat: 40.7575, lng: -73.9885 }, { lat: 40.7575, lng: -73.9865 }, { lat: 40.7582, lng: -73.9865 }, { lat: 40.7582, lng: -73.9885 }], maxAltitudeFt: 0,   type: 'no_fly',    bypassForMission: true },
    { id: 'gf-ts-nypd-perim',  label: 'NYPD Ground Perimeter', polygon: [{ lat: 40.7550, lng: -73.9880 }, { lat: 40.7622, lng: -73.9880 }, { lat: 40.7622, lng: -73.9830 }, { lat: 40.7550, lng: -73.9830 }], maxAltitudeFt: 200, type: 'restricted', bypassForMission: true },
  ],
  heatSources: [
    { id: 'hs-ts-victim-a',    class: 'generic-person', position: { lat: 40.7588, lng: -73.9856 }, tempC: 36,  radiusM: 1 },
    { id: 'hs-ts-victim-b',    class: 'generic-person', position: { lat: 40.7585, lng: -73.9858 }, tempC: 35,  radiusM: 1 },
    { id: 'hs-ts-crowd-a',     class: 'generic-person', position: { lat: 40.7612, lng: -73.9862 }, tempC: 37,  radiusM: 14 },
    { id: 'hs-ts-crowd-b',     class: 'generic-person', position: { lat: 40.7578, lng: -73.9870 }, tempC: 37,  radiusM: 10 },
    { id: 'hs-ts-fdny-veh',    class: 'vehicle',         position: { lat: 40.7602, lng: -73.9855 }, tempC: 90,  radiusM: 4 },
    { id: 'hs-ts-nypd-cruiser',class: 'vehicle',         position: { lat: 40.7595, lng: -73.9862 }, tempC: 85,  radiusM: 3 },
    { id: 'hs-ts-ems',         class: 'vehicle',         position: { lat: 40.7600, lng: -73.9848 }, tempC: 80,  radiusM: 4 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.024,
  rechargeTimeSec: 70,
  maxSorties: 2,
  commsLossWindows: [{ startSec: 60, durationSec: 20 }],
  perDroneMissionRoles: {
    'uav-01': 'Incident Zone — Broadway / 7th Ave hot zone overwatch',
    'uav-02': '47th–49th St — crowd flow control / surge monitoring',
    'uav-03': '42nd–45th St / Port Authority — secondary MCI triage',
    'uav-04': 'TKTS Elevated Overwatch — 220ft scene command view',
    'uav-05': 'Aviation Unit Relay — ESU / FDNY ground comms link',
  },
}

// ── 11. CAL FIRE / USFS — Dixie Fire Complex, Northern Flank ──────────────
export const calFireDixieComplex: ScenarioConfig = {
  id: 'extreme_cal_fire_dixie',
  name: 'CAL FIRE / USFS — Dixie Fire, Northern Flank',
  description: 'CAL FIRE IAAB and USFS Pacific Southwest Region deploy five UAS on the northern flank of the Dixie Fire Complex in Plumas County. Northern flank broke containment overnight with spotfires along the Feather River canyon rim. Three-sortie persistent recon over an 8-km perimeter segment. Tracks Hwy 70 fire edge, spotfires, Greenville structures, canyon crews, and ATGS-ICP comms relay. SIMULATION ONLY.',
  seed: 20011,
  droneCount: 5,
  // Wildfire doctrine: Teal 2 thermal ships with X10 overwatch.
  dronePlatforms: mixedFleet(5, 'teal_2', 'skydio_x10'),
  missionType: 'waypoint',
  // ICP staging south of the air-tanker drop corridor (never launch under retardant drops).
  startPosition: { lat: 40.0072, lng: -121.0085 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'dx-01-hwy70-w',    position: { lat: 40.0095, lng: -121.0120 }, altitudeFt: 200, label: 'Hwy70-West',      dwellTimeSec: 20 },
      { id: 'dx-01-hwy70-m',    position: { lat: 40.0098, lng: -121.0080 }, altitudeFt: 200, label: 'Hwy70-Mid',       dwellTimeSec: 25 },
      { id: 'dx-01-hwy70-e',    position: { lat: 40.0102, lng: -121.0040 }, altitudeFt: 200, label: 'Hwy70-East',      dwellTimeSec: 20 },
      { id: 'dx-01-struct-thr', position: { lat: 40.0090, lng: -121.0055 }, altitudeFt: 180, label: 'Structure-Threat', dwellTimeSec: 15 },
    ],
    'uav-02': [
      { id: 'dx-02-spot-a',     position: { lat: 40.0125, lng: -121.0095 }, altitudeFt: 180, label: 'Spotfire-A',      dwellTimeSec: 25 },
      { id: 'dx-02-spot-b',     position: { lat: 40.0138, lng: -121.0070 }, altitudeFt: 180, label: 'Spotfire-B',      dwellTimeSec: 25 },
      { id: 'dx-02-ember',      position: { lat: 40.0145, lng: -121.0048 }, altitudeFt: 200, label: 'Ember-Cast-Zone', dwellTimeSec: 20 },
      { id: 'dx-02-spot-c',     position: { lat: 40.0118, lng: -121.0040 }, altitudeFt: 160, label: 'Spotfire-C',      dwellTimeSec: 20 },
    ],
    'uav-03': [
      { id: 'dx-03-grn-n',      position: { lat: 40.0132, lng: -121.0125 }, altitudeFt: 160, label: 'Greenville-N',    dwellTimeSec: 20 },
      { id: 'dx-03-grn-core',   position: { lat: 40.0125, lng: -121.0115 }, altitudeFt: 140, label: 'Greenville-Core', dwellTimeSec: 25 },
      { id: 'dx-03-crescent',   position: { lat: 40.0112, lng: -121.0098 }, altitudeFt: 160, label: 'Crescent-Mills',  dwellTimeSec: 20 },
    ],
    'uav-04': [
      { id: 'dx-04-canyon-w',   position: { lat: 40.0068, lng: -121.0128 }, altitudeFt: 160, label: 'Canyon-West',     dwellTimeSec: 15 },
      { id: 'dx-04-canyon-m',   position: { lat: 40.0072, lng: -121.0092 }, altitudeFt: 160, label: 'Canyon-Mid',      dwellTimeSec: 20 },
      { id: 'dx-04-canyon-e',   position: { lat: 40.0075, lng: -121.0058 }, altitudeFt: 160, label: 'Canyon-East',     dwellTimeSec: 15 },
    ],
    'uav-05': [
      { id: 'dx-05-relay-hi',   position: { lat: 40.0105, lng: -121.0085 }, altitudeFt: 240, label: 'ATGS-ICP-Relay',  dwellTimeSec: 60 },
      { id: 'dx-05-relay-n',    position: { lat: 40.0135, lng: -121.0095 }, altitudeFt: 220, label: 'Relay-DivSup-N',  dwellTimeSec: 30 },
    ],
  },
  geofences: [
    { id: 'gf-dx-fire-column', label: 'Active Fire Column — No Fly',  polygon: [{ lat: 40.0085, lng: -121.0110 }, { lat: 40.0085, lng: -121.0068 }, { lat: 40.0115, lng: -121.0068 }, { lat: 40.0115, lng: -121.0110 }], maxAltitudeFt: 0,   type: 'no_fly' },
    { id: 'gf-dx-airtanker',   label: 'Air Tanker Drop Corridor',     polygon: [{ lat: 40.0080, lng: -121.0135 }, { lat: 40.0080, lng: -121.0060 }, { lat: 40.0088, lng: -121.0060 }, { lat: 40.0088, lng: -121.0135 }], maxAltitudeFt: 0,   type: 'no_fly' },
    { id: 'gf-dx-atgs-orbit',  label: 'ATGS Orbit Zone — Below 200ft', polygon: [{ lat: 40.0095, lng: -121.0110 }, { lat: 40.0095, lng: -121.0060 }, { lat: 40.0115, lng: -121.0060 }, { lat: 40.0115, lng: -121.0110 }], maxAltitudeFt: 200, type: 'restricted' },
  ],
  heatSources: [
    { id: 'hs-dx-main-fire',  class: 'campfire',    position: { lat: 40.0098, lng: -121.0090 }, tempC: 850, radiusM: 40 },
    { id: 'hs-dx-spot-a',     class: 'campfire',    position: { lat: 40.0128, lng: -121.0092 }, tempC: 520, radiusM: 18 },
    { id: 'hs-dx-spot-b',     class: 'campfire',    position: { lat: 40.0140, lng: -121.0068 }, tempC: 480, radiusM: 14 },
    { id: 'hs-dx-spot-c',     class: 'campfire',    position: { lat: 40.0120, lng: -121.0042 }, tempC: 380, radiusM: 10 },
    { id: 'hs-dx-struct-thr', class: 'heat-source', position: { lat: 40.0090, lng: -121.0055 }, tempC: 95,  radiusM: 8 },
    { id: 'hs-dx-grn-struct', class: 'heat-source', position: { lat: 40.0125, lng: -121.0115 }, tempC: 88,  radiusM: 6 },
    { id: 'hs-dx-crew-a',     class: 'vehicle',     position: { lat: 40.0072, lng: -121.0092 }, tempC: 80,  radiusM: 5 },
    { id: 'hs-dx-ember-cast', class: 'campfire',    position: { lat: 40.0142, lng: -121.0050 }, tempC: 280, radiusM: 8 },
    { id: 'hs-dx-flank-edge', class: 'campfire',    position: { lat: 40.0095, lng: -121.0042 }, tempC: 620, radiusM: 22 },
    { id: 'hs-dx-burnover',   class: 'heat-source', position: { lat: 40.0078, lng: -121.0085 }, tempC: 120, radiusM: 10 },
  ],
  batteryStartPct: 80,
  batteryDrainRatePerSec: 0.028,
  rechargeTimeSec: 60,
  maxSorties: 3,
  commsLossWindows: [{ startSec: 120, durationSec: 22 }, { startSec: 600, durationSec: 25 }],
  perDroneMissionRoles: {
    'uav-01': 'Hwy 70 Fire Edge — road corridor flame front tracker',
    'uav-02': 'Spotfire Detection — ember-cast spotfire north sector',
    'uav-03': 'Greenville Structure Threat — inhabited area priority',
    'uav-04': 'Feather River Canyon Crews — ground crew safety track',
    'uav-05': 'ATGS-ICP Relay — 240ft air-to-ground tactical link',
  },
}

// ── 12. CBP Big Bend Sector — Desert Humanitarian SAR ─────────────────────
export const cbpBigBendDesertSAR: ScenarioConfig = {
  id: 'extreme_cbp_big_bend_desert_sar',
  name: 'CBP Big Bend — Desert Humanitarian SAR',
  description: 'CBP Big Bend Sector deploys four UAS from Presidio Station for a humanitarian SAR for migrants overdue in the Chihuahuan Desert. Ground temperature 118°F. Thermal search primary: hyperthermic distress shows 40–42°C vs ~68°C desert surface. CBP EMT teams await cueing at two forward points. Two sorties due to extreme heat battery drain. SIMULATION ONLY — all positions are synthetic.',
  seed: 20012,
  droneCount: 4,
  // Desert SAR: X10D search ships with an Astro Max mapping payload.
  dronePlatforms: mixedFleet(4, 'skydio_x10d', 'freefly_astro_max'),
  missionType: 'waypoint',
  // Staging on the US side, north of the Mexican ADIZ boundary.
  startPosition: { lat: 29.3770, lng: -103.7285 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'bb-01-creek-s',    position: { lat: 29.3768, lng: -103.7270 }, altitudeFt: 80,  label: 'Creek-Bed-S',    dwellTimeSec: 20 },
      { id: 'bb-01-creek-m',    position: { lat: 29.3798, lng: -103.7255 }, altitudeFt: 80,  label: 'Creek-Bed-Mid',  dwellTimeSec: 25 },
      { id: 'bb-01-creek-n',    position: { lat: 29.3828, lng: -103.7238 }, altitudeFt: 80,  label: 'Creek-Bed-N',    dwellTimeSec: 25 },
      { id: 'bb-01-alluvial',   position: { lat: 29.3855, lng: -103.7232 }, altitudeFt: 100, label: 'Alluvial-Fan',   dwellTimeSec: 15 },
    ],
    'uav-02': [
      { id: 'bb-02-lava-s',     position: { lat: 29.3772, lng: -103.7310 }, altitudeFt: 100, label: 'Lava-Rock-S',    dwellTimeSec: 20 },
      { id: 'bb-02-lava-m',     position: { lat: 29.3800, lng: -103.7298 }, altitudeFt: 100, label: 'Lava-Rock-Mid',  dwellTimeSec: 25 },
      { id: 'bb-02-lava-n',     position: { lat: 29.3830, lng: -103.7285 }, altitudeFt: 100, label: 'Lava-Rock-N',    dwellTimeSec: 25 },
      { id: 'bb-02-shelter',    position: { lat: 29.3818, lng: -103.7305 }, altitudeFt: 80,  label: 'Rock-Shelter',   dwellTimeSec: 30 },
    ],
    'uav-03': [
      { id: 'bb-03-ranch-w',    position: { lat: 29.3808, lng: -103.7320 }, altitudeFt: 100, label: 'Ranch-Ruins-W',  dwellTimeSec: 25 },
      { id: 'bb-03-ranch-core', position: { lat: 29.3812, lng: -103.7312 }, altitudeFt: 80,  label: 'Ranch-Core',     dwellTimeSec: 35 },
      { id: 'bb-03-ranch-e',    position: { lat: 29.3815, lng: -103.7300 }, altitudeFt: 100, label: 'Ranch-East',     dwellTimeSec: 20 },
    ],
    'uav-04': [
      { id: 'bb-04-relay-hi',   position: { lat: 29.3800, lng: -103.7268 }, altitudeFt: 200, label: 'Presidio-Relay', dwellTimeSec: 60 },
      { id: 'bb-04-relay-n',    position: { lat: 29.3840, lng: -103.7258 }, altitudeFt: 180, label: 'Relay-North',    dwellTimeSec: 30 },
    ],
  },
  geofences: [
    { id: 'gf-bb-mexico-adiz', label: 'Mexican ADIZ — Absolute No Fly',    polygon: [{ lat: 29.3742, lng: -103.7350 }, { lat: 29.3742, lng: -103.7220 }, { lat: 29.3758, lng: -103.7220 }, { lat: 29.3758, lng: -103.7350 }], maxAltitudeFt: 0, type: 'no_fly' },
    { id: 'gf-bb-ems-lz',      label: 'EMS LZ — No Fly During Extraction', polygon: [{ lat: 29.3748, lng: -103.7298 }, { lat: 29.3748, lng: -103.7275 }, { lat: 29.3762, lng: -103.7275 }, { lat: 29.3762, lng: -103.7298 }], maxAltitudeFt: 0, type: 'no_fly' },
  ],
  heatSources: [
    { id: 'hs-bb-group-a',   class: 'generic-person', position: { lat: 29.3800, lng: -103.7258 }, tempC: 41,  radiusM: 4 },
    { id: 'hs-bb-group-b',   class: 'generic-person', position: { lat: 29.3815, lng: -103.7312 }, tempC: 40,  radiusM: 3 },
    { id: 'hs-bb-distress',  class: 'generic-person', position: { lat: 29.3828, lng: -103.7242 }, tempC: 42,  radiusM: 2 },
    { id: 'hs-bb-surface-a', class: 'heat-source',    position: { lat: 29.3790, lng: -103.7270 }, tempC: 65,  radiusM: 15 },
    { id: 'hs-bb-lava-surf', class: 'heat-source',    position: { lat: 29.3802, lng: -103.7305 }, tempC: 72,  radiusM: 20 },
    { id: 'hs-bb-cbp-veh-a', class: 'vehicle',        position: { lat: 29.3748, lng: -103.7285 }, tempC: 130, radiusM: 4 },
    { id: 'hs-bb-cbp-veh-b', class: 'vehicle',        position: { lat: 29.3752, lng: -103.7272 }, tempC: 125, radiusM: 4 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.026,
  rechargeTimeSec: 75,
  maxSorties: 2,
  commsLossWindows: [{ startSec: 160, durationSec: 28 }],
  perDroneMissionRoles: {
    'uav-01': 'Creek Bed Search — primary drainage thermal sweep',
    'uav-02': 'Lava Rock Sector — concealment search, rock shelter locate',
    'uav-03': 'Ranch Ruins Grid — structure remnant void search',
    'uav-04': 'Presidio Relay — 200ft high comms to sector dispatch',
  },
}

// ── 13. Multi-Agency — SF Financial District → Albany Hills Suspect Pursuit ──
export const multiAgencySFPursuit: ScenarioConfig = {
  id: 'extreme_multiagency_sf_pursuit',
  name: 'Multi-Agency — SF → Albany Hills Suspect Pursuit',
  description: 'SFPD / OPD / CHP / BART PD joint air pursuit of a vehicle fleeing from the SF Financial District, crossing the Bay Bridge, through Oakland, up I-580, through Berkeley, ending at Albany Hills. Eight drones with dedicated tactical roles: two shadows, hi-alt overwatch, two forward intercepts, two perimeter sealers, and a C2 relay. Two sorties with agency-specific staging across SF, Jack London Square simulated rooftop sites, the East Bay, and Oakland Airport. Comms degrade in Bay Bridge superstructure at T+60s. SIMULATION ONLY.',
  seed: 20013,
  droneCount: 8,
  // Multi-agency pursuit: X10 primaries with Anafis for fast infill.
  dronePlatforms: mixedFleet(8, 'skydio_x10', 'parrot_anafi_usa'),
  missionType: 'waypoint',
  startPosition: { lat: 37.7213, lng: -122.2205 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'sf-01-bb-mid',  position: { lat: 37.8058, lng: -122.3565 }, altitudeFt: 80,  label: 'Bay-Bridge-Mid',       dwellTimeSec: 10 },
      { id: 'sf-01-oak-td',  position: { lat: 37.7975, lng: -122.3490 }, altitudeFt: 80,  label: 'Oakland-Touchdown',    dwellTimeSec: 15 },
      { id: 'sf-01-i880',    position: { lat: 37.8072, lng: -122.2792 }, altitudeFt: 80,  label: 'I-880-N-Merge',       dwellTimeSec: 12 },
      { id: 'sf-01-i580',    position: { lat: 37.8220, lng: -122.2581 }, altitudeFt: 80,  label: 'I-580-Grand-Exit',    dwellTimeSec: 12 },
      { id: 'sf-01-tel',     position: { lat: 37.8498, lng: -122.2638 }, altitudeFt: 80,  label: 'Telegraph-Corridor',  dwellTimeSec: 15 },
      { id: 'sf-01-berk',    position: { lat: 37.8647, lng: -122.2803 }, altitudeFt: 80,  label: 'Bancroft-Berkeley',   dwellTimeSec: 12 },
      { id: 'sf-01-alb',     position: { lat: 37.8942, lng: -122.2988 }, altitudeFt: 80,  label: 'Albany-Hills-Term',   dwellTimeSec: 20 },
    ],
    'uav-02': [
      { id: 'sf-02-bb-s',    position: { lat: 37.7975, lng: -122.3490 }, altitudeFt: 100, label: 'BB-Oakland-400m-Back', dwellTimeSec: 10 },
      { id: 'sf-02-i880',    position: { lat: 37.8035, lng: -122.2848 }, altitudeFt: 100, label: 'I-880-Shadow',         dwellTimeSec: 12 },
      { id: 'sf-02-i580a',   position: { lat: 37.8180, lng: -122.2620 }, altitudeFt: 100, label: 'I-580-Shadow-A',      dwellTimeSec: 12 },
      { id: 'sf-02-tel',     position: { lat: 37.8460, lng: -122.2658 }, altitudeFt: 100, label: 'Telegraph-Shadow',    dwellTimeSec: 15 },
      { id: 'sf-02-berk',    position: { lat: 37.8620, lng: -122.2820 }, altitudeFt: 100, label: 'Berkeley-Shadow',     dwellTimeSec: 12 },
      { id: 'sf-02-alb',     position: { lat: 37.8910, lng: -122.3000 }, altitudeFt: 100, label: 'Albany-Shadow',       dwellTimeSec: 20 },
    ],
    'uav-03': [
      { id: 'sf-03-jls-climb', position: { lat: 37.7955, lng: -122.2765 }, altitudeFt: 180, label: 'JLS-Rooftop-Climb',   dwellTimeSec: 12 },
      { id: 'sf-03-ow2',       position: { lat: 37.8150, lng: -122.3100 }, altitudeFt: 260, label: 'OW-Oakland-Central',  dwellTimeSec: 20 },
      { id: 'sf-03-ow3',       position: { lat: 37.8350, lng: -122.2700 }, altitudeFt: 260, label: 'OW-I580-Corridor',    dwellTimeSec: 20 },
      { id: 'sf-03-ow4',       position: { lat: 37.8600, lng: -122.2850 }, altitudeFt: 260, label: 'OW-Berkeley-Sweep',   dwellTimeSec: 20 },
      { id: 'sf-03-ow5',       position: { lat: 37.8900, lng: -122.2980 }, altitudeFt: 260, label: 'OW-Albany-Hills',     dwellTimeSec: 25 },
    ],
    'uav-04': [
      { id: 'sf-04-jls-depart', position: { lat: 37.7958, lng: -122.2759 }, altitudeFt: 120, label: 'JLS-Intercept-Depart', dwellTimeSec: 10 },
      { id: 'sf-04-i880-hold',  position: { lat: 37.8072, lng: -122.2792 }, altitudeFt: 140, label: 'I880-Nimitz-Hold',    dwellTimeSec: 18 },
      { id: 'sf-04-int2',       position: { lat: 37.8220, lng: -122.2581 }, altitudeFt: 140, label: 'Intercept-I580-Hold', dwellTimeSec: 30 },
      { id: 'sf-04-int3',       position: { lat: 37.8498, lng: -122.2638 }, altitudeFt: 140, label: 'Intercept-Telegraph', dwellTimeSec: 25 },
    ],
    'uav-05': [
      { id: 'sf-05-jls-depart', position: { lat: 37.7949, lng: -122.2772 }, altitudeFt: 110, label: 'JLS-CHP-Depart',      dwellTimeSec: 10 },
      { id: 'sf-05-i880-north', position: { lat: 37.8048, lng: -122.2715 }, altitudeFt: 120, label: 'I880-North-Corridor', dwellTimeSec: 14 },
      { id: 'sf-05-i980-580',   position: { lat: 37.8145, lng: -122.2682 }, altitudeFt: 120, label: 'I980-I580-Transition', dwellTimeSec: 14 },
      { id: 'sf-05-i580-hold',  position: { lat: 37.8220, lng: -122.2581 }, altitudeFt: 120, label: 'I580-Hold-Point',     dwellTimeSec: 24 },
      { id: 'sf-05-int1',       position: { lat: 37.8498, lng: -122.2638 }, altitudeFt: 120, label: 'Intercept-Tel-I580',  dwellTimeSec: 30 },
      { id: 'sf-05-int2',       position: { lat: 37.8647, lng: -122.2803 }, altitudeFt: 120, label: 'Intercept-Bancroft',  dwellTimeSec: 30 },
      { id: 'sf-05-int3',       position: { lat: 37.8869, lng: -122.2964 }, altitudeFt: 120, label: 'Intercept-Albany',    dwellTimeSec: 25 },
    ],
    'uav-06': [
      { id: 'sf-06-per1',    position: { lat: 37.8698, lng: -122.2952 }, altitudeFt: 160, label: 'Perim-I80-Univ-Ave',  dwellTimeSec: 20 },
      { id: 'sf-06-per2',    position: { lat: 37.8720, lng: -122.2870 }, altitudeFt: 160, label: 'Perim-Gilman-W',      dwellTimeSec: 20 },
      { id: 'sf-06-per3',    position: { lat: 37.8690, lng: -122.2800 }, altitudeFt: 160, label: 'Perim-Ashby-West',    dwellTimeSec: 20 },
    ],
    'uav-07': [
      { id: 'sf-07-per1',    position: { lat: 37.8942, lng: -122.2988 }, altitudeFt: 180, label: 'Perim-Moeser-Albany', dwellTimeSec: 20 },
      { id: 'sf-07-per2',    position: { lat: 37.8960, lng: -122.2940 }, altitudeFt: 180, label: 'Perim-Pierce-St',     dwellTimeSec: 20 },
      { id: 'sf-07-per3',    position: { lat: 37.8950, lng: -122.3010 }, altitudeFt: 180, label: 'Perim-Stannage-N',    dwellTimeSec: 20 },
    ],
    'uav-08': [
      { id: 'sf-08-c2-1',    position: { lat: 37.8050, lng: -122.3480 }, altitudeFt: 280, label: 'C2-Relay-Bay-Bridge', dwellTimeSec: 30 },
      { id: 'sf-08-c2-2',    position: { lat: 37.8350, lng: -122.2800 }, altitudeFt: 280, label: 'C2-Relay-Oakland',    dwellTimeSec: 30 },
      { id: 'sf-08-c2-3',    position: { lat: 37.8700, lng: -122.2900 }, altitudeFt: 280, label: 'C2-Relay-Berkeley',   dwellTimeSec: 30 },
      { id: 'sf-08-c2-4',    position: { lat: 37.8940, lng: -122.2980 }, altitudeFt: 280, label: 'C2-Relay-Albany',     dwellTimeSec: 30 },
    ],
  },
  geofences: [
    { id: 'gf-sf-bridge',  label: 'Bay Bridge Active Lanes',       polygon: [{ lat: 37.7960, lng: -122.3950 }, { lat: 37.8100, lng: -122.3950 }, { lat: 37.8100, lng: -122.3450 }, { lat: 37.7960, lng: -122.3450 }], maxAltitudeFt: 150, type: 'restricted', bypassForMission: true },
    { id: 'gf-sf-schools', label: 'Berkeley School Zone',           polygon: [{ lat: 37.8620, lng: -122.2900 }, { lat: 37.8680, lng: -122.2900 }, { lat: 37.8680, lng: -122.2750 }, { lat: 37.8620, lng: -122.2750 }], maxAltitudeFt: 120, type: 'restricted', bypassForMission: true },
    { id: 'gf-sf-albany',  label: 'Albany Hills Residential Zone',  polygon: [{ lat: 37.8910, lng: -122.3040 }, { lat: 37.8980, lng: -122.3040 }, { lat: 37.8980, lng: -122.2920 }, { lat: 37.8910, lng: -122.2920 }], maxAltitudeFt: 100, type: 'restricted', bypassForMission: true },
  ],
  heatSources: [
    { id: 'hs-sf-suspect',    class: 'vehicle',        position: { lat: 37.7908, lng: -122.3933 }, tempC: 95,  radiusM: 3 },
    { id: 'hs-sf-sfpd-a',     class: 'vehicle',        position: { lat: 37.7900, lng: -122.3940 }, tempC: 85,  radiusM: 3 },
    { id: 'hs-sf-sfpd-b',     class: 'vehicle',        position: { lat: 37.7915, lng: -122.3925 }, tempC: 80,  radiusM: 3 },
    { id: 'hs-sf-opd-a',      class: 'vehicle',        position: { lat: 37.8072, lng: -122.2792 }, tempC: 85,  radiusM: 3 },
    { id: 'hs-sf-tel-crowd',  class: 'generic-person', position: { lat: 37.8498, lng: -122.2638 }, tempC: 37,  radiusM: 12 },
    { id: 'hs-sf-berk-crowd', class: 'generic-person', position: { lat: 37.8647, lng: -122.2803 }, tempC: 37,  radiusM: 8 },
    { id: 'hs-sf-chp-i580',   class: 'vehicle',        position: { lat: 37.8220, lng: -122.2581 }, tempC: 90,  radiusM: 4 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.022,
  rechargeTimeSec: 40,
  maxSorties: 2,
  commsLossWindows: [{ startSec: 60, durationSec: 18 }],
  perDroneMissionRoles: {
    'uav-01': 'Primary Shadow — direct pursuit, lowest altitude track',
    'uav-02': 'Secondary Shadow — 400m trail, intercepts reversal',
    'uav-03': 'Hi-Alt Overwatch — 260ft wide-area corridor coverage',
    'uav-04': 'Forward Intercept Alpha — pre-positions Bay Bridge → I-580',
    'uav-05': 'Forward Intercept Bravo — pre-positions I-580 → Albany Hills',
    'uav-06': 'Perimeter West — seals I-80 / University Ave exits',
    'uav-07': 'Perimeter North — Albany Hills Moeser / Pierce / Stannage',
    'uav-08': 'C2 Relay — 280ft AGL comms bridge all units',
  },
  // Per-agency staging: SFPD shadows spawn in SF, OPD/CHP intercept and overwatch drones launch from
  // simulated Jack London Square rooftops, perimeter drones pre-position near sectors, C2 relay at Oakland Airport.
  perDroneStartPositions: {
    'uav-01': { lat: 37.7908, lng: -122.3933 },
    'uav-02': { lat: 37.7900, lng: -122.3940 },
    'uav-03': { lat: 37.7955, lng: -122.2765 },
    'uav-04': { lat: 37.7958, lng: -122.2759 },
    'uav-05': { lat: 37.7949, lng: -122.2772 },
    'uav-06': { lat: 37.8698, lng: -122.2980 },
    'uav-07': { lat: 37.8942, lng: -122.3010 },
    'uav-08': { lat: 37.7213, lng: -122.2205 },
  },
  launchSites: {
    'uav-01': {
      kind: 'mobile_command',
      label: 'SFPD Embarcadero mobile command launch site',
      agency: 'SFPD',
      position: { lat: 37.7908, lng: -122.3933 },
      surfaceNote: 'Explicit simulated mobile command launch pad in the SF command area.',
    },
    'uav-02': {
      kind: 'mobile_command',
      label: 'SFPD Embarcadero secondary mobile command launch site',
      agency: 'SFPD',
      position: { lat: 37.7900, lng: -122.3940 },
      surfaceNote: 'Explicit simulated mobile command launch pad for the SF shadow aircraft.',
    },
    'uav-03': {
      kind: 'police_rooftop',
      label: 'Jack London Square OPD simulated rooftop overwatch launch site',
      agency: 'OPD',
      position: { lat: 37.7955, lng: -122.2765 },
      surfaceNote: 'Simulation-safe Jack London Square simulated rooftop launch surface for East Bay overwatch.',
    },
    'uav-04': {
      kind: 'police_rooftop',
      label: 'Jack London Square OPD simulated rooftop intercept launch site',
      agency: 'OPD',
      position: { lat: 37.7958, lng: -122.2759 },
      surfaceNote: 'Simulation-safe Jack London Square simulated rooftop launch surface for the I-880 to I-580 intercept.',
    },
    'uav-05': {
      kind: 'rooftop',
      label: 'Jack London Square CHP East Bay simulated rooftop launch site',
      agency: 'CHP',
      position: { lat: 37.7949, lng: -122.2772 },
      surfaceNote: 'Simulation-safe Jack London Square simulated rooftop launch surface for East Bay forward intercept.',
    },
    'uav-06': {
      kind: 'mobile_command',
      label: 'Berkeley I-80 mobile command launch site',
      agency: 'BART PD',
      position: { lat: 37.8698, lng: -122.2980 },
      surfaceNote: 'Explicit simulated mobile command launch pad for west Berkeley perimeter coverage.',
    },
    'uav-07': {
      kind: 'mobile_command',
      label: 'Albany Hills mobile command launch site',
      agency: 'Albany PD Liaison',
      position: { lat: 37.8942, lng: -122.3010 },
      surfaceNote: 'Explicit simulated mobile command launch pad for Albany Hills perimeter coverage.',
    },
    'uav-08': {
      kind: 'mobile_command',
      label: 'Oakland Airport mobile command relay launch site',
      agency: 'OPD Air Liaison',
      position: { lat: 37.7213, lng: -122.2205 },
      surfaceNote: 'Explicit simulated mobile command launch pad for C2 relay operations.',
    },
  },
  recoverySites: {
    'uav-01': {
      kind: 'mobile_command',
      label: 'SFPD Embarcadero mobile command recovery lane',
      agency: 'SFPD',
      position: { lat: 37.7908, lng: -122.3933 },
      surfaceNote: 'Primary simulated mobile command recovery lane for SF shadow aircraft.',
      isPrimaryRecovery: true,
    },
    'uav-02': {
      kind: 'mobile_command',
      label: 'SFPD Embarcadero secondary mobile command recovery lane',
      agency: 'SFPD',
      position: { lat: 37.7900, lng: -122.3940 },
      surfaceNote: 'Primary simulated mobile command recovery lane for the secondary SF shadow aircraft.',
      isPrimaryRecovery: true,
    },
    'uav-03': {
      kind: 'police_rooftop',
      label: 'Jack London Square OPD simulated rooftop recovery lane',
      agency: 'OPD',
      position: { lat: 37.7955, lng: -122.2765 },
      surfaceNote: 'Primary simulation-safe Jack London Square simulated rooftop recovery lane.',
      isPrimaryRecovery: true,
    },
    'uav-04': {
      kind: 'police_rooftop',
      label: 'Jack London Square OPD simulated rooftop intercept recovery lane',
      agency: 'OPD',
      position: { lat: 37.7958, lng: -122.2759 },
      surfaceNote: 'Primary simulation-safe Jack London Square simulated rooftop recovery lane.',
      isPrimaryRecovery: true,
    },
    'uav-05': {
      kind: 'rooftop',
      label: 'Jack London Square CHP East Bay simulated rooftop recovery lane',
      agency: 'CHP',
      position: { lat: 37.7949, lng: -122.2772 },
      surfaceNote: 'Primary simulation-safe Jack London Square simulated rooftop recovery lane.',
      isPrimaryRecovery: true,
    },
    'uav-06': {
      kind: 'mobile_command',
      label: 'Berkeley I-80 mobile command recovery lane',
      agency: 'BART PD',
      position: { lat: 37.8698, lng: -122.2980 },
      surfaceNote: 'Primary simulated mobile command recovery lane for west Berkeley perimeter coverage.',
      isPrimaryRecovery: true,
    },
    'uav-07': {
      kind: 'mobile_command',
      label: 'Albany Hills mobile command recovery lane',
      agency: 'Albany PD Liaison',
      position: { lat: 37.8942, lng: -122.3010 },
      surfaceNote: 'Primary simulated mobile command recovery lane for Albany Hills perimeter coverage.',
      isPrimaryRecovery: true,
    },
    'uav-08': {
      kind: 'mobile_command',
      label: 'Oakland Airport mobile command relay recovery lane',
      agency: 'OPD Air Liaison',
      position: { lat: 37.7213, lng: -122.2205 },
      surfaceNote: 'Primary simulated mobile command recovery lane for C2 relay operations.',
      isPrimaryRecovery: true,
    },
  },
}

const RIO_GRANDE_RECHARGE_STATIONS: RechargeStation[] = [
  {
    id: 'rg-rs-falcon-us83',
    label: 'Falcon / US-83 Staging',
    position: { lat: 26.5950, lng: -99.1050 },
    road: 'US-83 corridor',
    agency: 'CBP AMO MOBILE SUPPORT',
    notes: 'Forward mobile command and battery-swap truck clear of the Falcon Dam restricted box.',
    priority: 'advisory',
  },
  {
    id: 'rg-rs-roma-us83',
    label: 'Roma / US-83 Recharge',
    position: { lat: 26.4250, lng: -99.0200 },
    road: 'US-83 corridor',
    agency: 'CBP AMO MOBILE SUPPORT',
    notes: 'Roadside recharge node north of the Roma bridge restricted corridor.',
    priority: 'advisory',
  },
  {
    id: 'rg-rs-rgc-us83',
    label: 'Rio Grande City / US-83 Recharge',
    position: { lat: 26.3800, lng: -98.8200 },
    road: 'US-83 corridor',
    agency: 'CBP AMO MOBILE SUPPORT',
    notes: 'Mid-corridor battery swap and maintenance truck for sector handoff.',
    priority: 'advisory',
  },
  {
    id: 'rg-rs-lajoya-us83',
    label: 'La Joya / US-83 Recharge',
    position: { lat: 26.3150, lng: -98.4550 },
    road: 'US-83 corridor',
    agency: 'CBP AMO MOBILE SUPPORT',
    notes: 'Forward recovery node north of the airspace exclusion polygon.',
    priority: 'advisory',
  },
  {
    id: 'rg-rs-mission-us83',
    label: 'Mission Terminal / US-83 Recovery',
    position: { lat: 26.2180, lng: -98.3252 },
    road: 'US-83 corridor',
    agency: 'CBP AMO MOBILE SUPPORT',
    notes: 'Terminal recovery point for final sortie and post-mission battery servicing.',
    priority: 'routine',
  },
]

const RIO_GRANDE_RECHARGE_SEQUENCE = RIO_GRANDE_RECHARGE_STATIONS.map((station) => station.id)
const RIO_GRANDE_RECHARGE_POSITIONS = RIO_GRANDE_RECHARGE_STATIONS.map((station) => station.position)
const RIO_GRANDE_RECHARGE_BY_DRONE = Object.fromEntries(
  Array.from({ length: 5 }, (_, index) => [
    `uav-${String(index + 1).padStart(2, '0')}`,
    RIO_GRANDE_RECHARGE_POSITIONS,
  ]),
) as Record<string, typeof RIO_GRANDE_RECHARGE_POSITIONS>
const RIO_GRANDE_RECHARGE_IDS_BY_DRONE = Object.fromEntries(
  Array.from({ length: 5 }, (_, index) => [
    `uav-${String(index + 1).padStart(2, '0')}`,
    RIO_GRANDE_RECHARGE_SEQUENCE,
  ]),
) as Record<string, string[]>

// ── 14. CBP Laredo Sector — Rio Grande Long-Range Relay Patrol ────────────────
export const cbpRioGrandeLongRange: ScenarioConfig = {
  id: 'extreme_cbp_rio_grande_longrange',
  name: 'CBP Laredo — Rio Grande 25-Mile Relay Patrol',
  description: 'CBP Laredo Sector Air and Marine Operations deploys five long-range-kit drones from a mobile command post near Falcon Lake (Starr County, TX) eastward through a 25-mile corridor toward Mission, TX. Drones do NOT return to the origin between sorties — they advance through staged mobile recharge vehicles on the US-83 corridor at Falcon, Roma, Rio Grande City, La Joya, and Mission terminal recovery. Long-range Li-ion packs offset 104°F ambient heat and payload weight while a 25 percent reserve threshold forces forward recovery discipline. SIMULATION ONLY.',
  seed: 20014,
  droneCount: 5,
  // Long-range border: uniform X10D line. The scenario's 1.6 fleet battery
  // profile intentionally takes precedence over the platform endurance multiplier.
  dronePlatforms: mixedFleet(5, 'skydio_x10d'),
  missionType: 'waypoint',
  startPosition: { lat: 26.5655, lng: -99.1195 },
  waypoints: [],
  perDroneWaypoints: {
    'uav-01': [
      { id: 'rg-01-s1',  position: { lat: 26.5480, lng: -99.0850 }, altitudeFt: 60,  label: 'Riverbank-S1',     dwellTimeSec: 20 },
      { id: 'rg-01-s2',  position: { lat: 26.5320, lng: -99.0510 }, altitudeFt: 60,  label: 'Riverbank-S2',     dwellTimeSec: 25 },
      { id: 'rg-01-s3',  position: { lat: 26.5100, lng: -99.0180 }, altitudeFt: 60,  label: 'Riverbank-S3',     dwellTimeSec: 20 },
      { id: 'rg-01-s4',  position: { lat: 26.4850, lng: -98.9650 }, altitudeFt: 60,  label: 'Riverbank-S4',     dwellTimeSec: 25 },
      { id: 'rg-01-s5',  position: { lat: 26.4650, lng: -98.9300 }, altitudeFt: 60,  label: 'Riverbank-S5-Rel', dwellTimeSec: 15 },
      { id: 'rg-01-s6',  position: { lat: 26.4400, lng: -98.8950 }, altitudeFt: 60,  label: 'Riverbank-S6',     dwellTimeSec: 20 },
      { id: 'rg-01-s7',  position: { lat: 26.4200, lng: -98.8600 }, altitudeFt: 60,  label: 'Riverbank-S7',     dwellTimeSec: 25 },
      { id: 'rg-01-s8',  position: { lat: 26.4000, lng: -98.8250 }, altitudeFt: 60,  label: 'Riverbank-S8',     dwellTimeSec: 20 },
      { id: 'rg-01-s9',  position: { lat: 26.3800, lng: -98.7900 }, altitudeFt: 60,  label: 'Riverbank-S9',     dwellTimeSec: 25 },
      { id: 'rg-01-s10', position: { lat: 26.3400, lng: -98.7400 }, altitudeFt: 60,  label: 'Riverbank-S10',    dwellTimeSec: 20 },
      { id: 'rg-01-s11', position: { lat: 26.2900, lng: -98.6900 }, altitudeFt: 60,  label: 'Riverbank-S11',    dwellTimeSec: 25 },
      { id: 'rg-01-s12', position: { lat: 26.2180, lng: -98.3252 }, altitudeFt: 60,  label: 'Riverbank-Terminal', dwellTimeSec: 30 },
    ],
    'uav-02': [
      { id: 'rg-02-s1',  position: { lat: 26.5620, lng: -99.0820 }, altitudeFt: 100, label: 'US83-Watch-S1',    dwellTimeSec: 18 },
      { id: 'rg-02-s2',  position: { lat: 26.5380, lng: -99.0480 }, altitudeFt: 100, label: 'US83-Watch-S2',    dwellTimeSec: 22 },
      { id: 'rg-02-s3',  position: { lat: 26.5150, lng: -99.0140 }, altitudeFt: 100, label: 'US83-Watch-S3',    dwellTimeSec: 18 },
      { id: 'rg-02-s4',  position: { lat: 26.4920, lng: -98.9600 }, altitudeFt: 100, label: 'US83-Watch-S4',    dwellTimeSec: 22 },
      { id: 'rg-02-s5',  position: { lat: 26.4680, lng: -98.9200 }, altitudeFt: 100, label: 'US83-Watch-S5',    dwellTimeSec: 18 },
      { id: 'rg-02-s6',  position: { lat: 26.4450, lng: -98.8800 }, altitudeFt: 100, label: 'US83-Watch-S6',    dwellTimeSec: 22 },
      { id: 'rg-02-s7',  position: { lat: 26.4220, lng: -98.8400 }, altitudeFt: 100, label: 'US83-Watch-S7',    dwellTimeSec: 18 },
      { id: 'rg-02-s8',  position: { lat: 26.3850, lng: -98.7800 }, altitudeFt: 100, label: 'US83-Watch-S8',    dwellTimeSec: 22 },
      { id: 'rg-02-s9',  position: { lat: 26.3400, lng: -98.7200 }, altitudeFt: 100, label: 'US83-Watch-S9',    dwellTimeSec: 18 },
      { id: 'rg-02-s10', position: { lat: 26.2700, lng: -98.6500 }, altitudeFt: 100, label: 'US83-Watch-S10',   dwellTimeSec: 22 },
      { id: 'rg-02-s11', position: { lat: 26.2180, lng: -98.3252 }, altitudeFt: 100, label: 'US83-Terminal',    dwellTimeSec: 30 },
    ],
    'uav-03': [
      { id: 'rg-03-s1',  position: { lat: 26.5800, lng: -99.0800 }, altitudeFt: 180, label: 'WideArea-Hi-S1',   dwellTimeSec: 22 },
      { id: 'rg-03-s2',  position: { lat: 26.5550, lng: -99.0400 }, altitudeFt: 180, label: 'WideArea-Hi-S2',   dwellTimeSec: 22 },
      { id: 'rg-03-s3',  position: { lat: 26.5250, lng: -99.0000 }, altitudeFt: 180, label: 'WideArea-Hi-S3',   dwellTimeSec: 22 },
      { id: 'rg-03-s4',  position: { lat: 26.5000, lng: -98.9500 }, altitudeFt: 180, label: 'WideArea-Hi-S4',   dwellTimeSec: 22 },
      { id: 'rg-03-s5',  position: { lat: 26.4750, lng: -98.9050 }, altitudeFt: 180, label: 'WideArea-Hi-S5',   dwellTimeSec: 22 },
      { id: 'rg-03-s6',  position: { lat: 26.4500, lng: -98.8650 }, altitudeFt: 180, label: 'WideArea-Hi-S6',   dwellTimeSec: 22 },
      { id: 'rg-03-s7',  position: { lat: 26.4100, lng: -98.8100 }, altitudeFt: 180, label: 'WideArea-Hi-S7',   dwellTimeSec: 22 },
      { id: 'rg-03-s8',  position: { lat: 26.3600, lng: -98.7500 }, altitudeFt: 180, label: 'WideArea-Hi-S8',   dwellTimeSec: 22 },
      { id: 'rg-03-s9',  position: { lat: 26.3000, lng: -98.7000 }, altitudeFt: 180, label: 'WideArea-Hi-S9',   dwellTimeSec: 22 },
      { id: 'rg-03-s10', position: { lat: 26.2180, lng: -98.3252 }, altitudeFt: 180, label: 'WideArea-Terminal', dwellTimeSec: 30 },
    ],
    'uav-04': [
      { id: 'rg-04-s1',  position: { lat: 26.5900, lng: -99.0600 }, altitudeFt: 120, label: 'Ranch-Grid-S1',    dwellTimeSec: 25 },
      { id: 'rg-04-s2',  position: { lat: 26.5700, lng: -99.0200 }, altitudeFt: 120, label: 'Ranch-Grid-S2',    dwellTimeSec: 25 },
      { id: 'rg-04-s3',  position: { lat: 26.5450, lng: -98.9800 }, altitudeFt: 120, label: 'Ranch-Grid-S3',    dwellTimeSec: 25 },
      { id: 'rg-04-s4',  position: { lat: 26.5200, lng: -98.9350 }, altitudeFt: 120, label: 'Ranch-Grid-S4',    dwellTimeSec: 25 },
      { id: 'rg-04-s5',  position: { lat: 26.4950, lng: -98.8900 }, altitudeFt: 120, label: 'Ranch-Grid-S5',    dwellTimeSec: 25 },
      { id: 'rg-04-s6',  position: { lat: 26.4700, lng: -98.8500 }, altitudeFt: 120, label: 'Ranch-Grid-S6',    dwellTimeSec: 25 },
      { id: 'rg-04-s7',  position: { lat: 26.4300, lng: -98.8000 }, altitudeFt: 120, label: 'Ranch-Grid-S7',    dwellTimeSec: 25 },
      { id: 'rg-04-s8',  position: { lat: 26.3800, lng: -98.7600 }, altitudeFt: 120, label: 'Ranch-Grid-S8',    dwellTimeSec: 25 },
      { id: 'rg-04-s9',  position: { lat: 26.2180, lng: -98.3252 }, altitudeFt: 120, label: 'Ranch-Terminal',   dwellTimeSec: 30 },
    ],
    'uav-05': [
      { id: 'rg-05-s1',  position: { lat: 26.5655, lng: -99.0500 }, altitudeFt: 240, label: 'Relay-Sector-1',   dwellTimeSec: 60 },
      { id: 'rg-05-s2',  position: { lat: 26.5100, lng: -98.9700 }, altitudeFt: 240, label: 'Relay-Sector-2',   dwellTimeSec: 60 },
      { id: 'rg-05-s3',  position: { lat: 26.4500, lng: -98.8800 }, altitudeFt: 240, label: 'Relay-Sector-3',   dwellTimeSec: 60 },
      { id: 'rg-05-s4',  position: { lat: 26.3800, lng: -98.7800 }, altitudeFt: 240, label: 'Relay-Sector-4',   dwellTimeSec: 60 },
      { id: 'rg-05-s5',  position: { lat: 26.2180, lng: -98.3252 }, altitudeFt: 240, label: 'Relay-Terminal',   dwellTimeSec: 60 },
    ],
  },
  rechargeStations: RIO_GRANDE_RECHARGE_STATIONS,
  perDroneRechargeStations: RIO_GRANDE_RECHARGE_BY_DRONE,
  perDroneRechargeStationIds: RIO_GRANDE_RECHARGE_IDS_BY_DRONE,
  geofences: [
    { id: 'gf-rg-mexico',  label: 'Mexican Airspace ADIZ — No Fly',     polygon: [{ lat: 26.2500, lng: -99.1300 }, { lat: 26.2500, lng: -98.3000 }, { lat: 26.3100, lng: -98.3000 }, { lat: 26.3100, lng: -99.1300 }], maxAltitudeFt: 0,   type: 'no_fly' },
    { id: 'gf-rg-dam',     label: 'Falcon Dam — Restricted 150ft',       polygon: [{ lat: 26.5450, lng: -99.1450 }, { lat: 26.5450, lng: -99.1050 }, { lat: 26.5900, lng: -99.1050 }, { lat: 26.5900, lng: -99.1450 }], maxAltitudeFt: 150, type: 'restricted' },
    { id: 'gf-rg-roma',    label: 'Roma TX Bridge Corridor — 200ft',     polygon: [{ lat: 26.3950, lng: -99.0100 }, { lat: 26.3950, lng: -98.9950 }, { lat: 26.4200, lng: -98.9950 }, { lat: 26.4200, lng: -99.0100 }], maxAltitudeFt: 200, type: 'restricted' },
  ],
  heatSources: [
    { id: 'hs-rg-cane-a',   class: 'generic-person', position: { lat: 26.5100, lng: -99.0180 }, tempC: 41,  radiusM: 4 },
    { id: 'hs-rg-cane-b',   class: 'generic-person', position: { lat: 26.4650, lng: -98.9300 }, tempC: 40,  radiusM: 3 },
    { id: 'hs-rg-cane-c',   class: 'generic-person', position: { lat: 26.4200, lng: -98.8600 }, tempC: 42,  radiusM: 5 },
    { id: 'hs-rg-vehicle-a', class: 'vehicle',       position: { lat: 26.5620, lng: -99.0820 }, tempC: 120, radiusM: 4 },
    { id: 'hs-rg-vehicle-b', class: 'vehicle',       position: { lat: 26.5380, lng: -99.0480 }, tempC: 115, radiusM: 4 },
    { id: 'hs-rg-vegetation', class: 'heat-source',  position: { lat: 26.4850, lng: -98.9650 }, tempC: 52,  radiusM: 20 },
    { id: 'hs-rg-agent-a',  class: 'generic-person', position: { lat: 26.4250, lng: -99.0200 }, tempC: 38,  radiusM: 2 },
    { id: 'hs-rg-agent-b',  class: 'generic-person', position: { lat: 26.3800, lng: -98.8200 }, tempC: 38,  radiusM: 2 },
    { id: 'hs-rg-rs-falcon', class: 'vehicle',       position: { lat: 26.5950, lng: -99.1050 }, tempC: 96,  radiusM: 5 },
    { id: 'hs-rg-rs-roma', class: 'vehicle',         position: { lat: 26.4250, lng: -99.0200 }, tempC: 94,  radiusM: 5 },
    { id: 'hs-rg-rs-rgc', class: 'vehicle',          position: { lat: 26.3800, lng: -98.8200 }, tempC: 94,  radiusM: 5 },
    { id: 'hs-rg-rs-lajoya', class: 'vehicle',       position: { lat: 26.3150, lng: -98.4550 }, tempC: 92,  radiusM: 5 },
    { id: 'hs-rg-rs-mission', class: 'vehicle',      position: { lat: 26.2180, lng: -98.3252 }, tempC: 90,  radiusM: 5 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.030,
  rechargeTimeSec: 80,
  maxSorties: 6,
  batteryProfile: {
    id: 'battery-long-range-li-ion',
    label: 'Long-Range Li-ion Endurance Kit',
    capacityWh: 1420,
    enduranceMultiplier: 1.6,
    reservePct: 25,
    chargeRateMultiplier: 1.15,
    notes: 'Extended endurance pack with hot-weather reserve discipline for staged BVLOS corridor simulation.',
  },
  commsLossWindows: [{ startSec: 120, durationSec: 30 }, { startSec: 480, durationSec: 25 }],
  perDroneMissionRoles: {
    'uav-01': 'Riverbank Low Scanner — 60ft AGL river contact patrol',
    'uav-02': 'Parallel Track — US-83 vehicle road watch, 200m north',
    'uav-03': 'Wide Area High — 180ft AGL, 800m north-of-river sweep',
    'uav-04': 'Ranch Interior Grid — agricultural staging area search',
    'uav-05': 'Comms Relay / Hi-Alt — 240ft sector dispatch link',
  },
}

export const EXTREME_SCENARIOS: ScenarioConfig[] = [
  lapdHollywoodBowl,
  cbpEaglePassBorder,
  fbiHrtCompound,
  uscgCapeCodeSAR,
  usssPresidentialSF,
  femaFortMyers,
  atfOaklandStash,
  dhsPortLAChemical,
  lapdSkidRowWelfare,
  nypdTimesSqMCI,
  calFireDixieComplex,
  cbpBigBendDesertSAR,
  multiAgencySFPursuit,
  cbpRioGrandeLongRange,
]


