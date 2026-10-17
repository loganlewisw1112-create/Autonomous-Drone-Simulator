import type { ScenarioConfig } from '@/types'
import { mixedFleet } from './platformAssignments'

// Retired law-enforcement / federal scenarios that were never in the shipped catalog were removed
// from source in the pitch-review r2 pass; they remain in git history. Only the four scenarios
// imported by trainingScenarios.ts live here now.

// ── 4. USCG District 1 — Atlantic Mariner SAR ──────────────────────────────
export const uscgCapeCodeSAR: ScenarioConfig = {
  id: 'extreme_uscg_cape_cod_sar',
  name: 'USCG District 1 — Atlantic Mariner SAR',
  description: 'USCG Sector Southeastern New England deploys five multirotor UAS from Air Station Cape Cod (four Skydio X10D thermal search aircraft and a Freefly Astro Max mapping aircraft) for an overdue 28-ft recreational vessel. EPIRB activated at 0214 local. SAROPS drift model projects two probability sectors. Primary detection: thermal — hypothermic survivors at 33–35°C vs 18°C Atlantic water. Up to two sorties to cover the full probability area. SIMULATION ONLY.',
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

export const EXTREME_SCENARIOS: ScenarioConfig[] = [
  uscgCapeCodeSAR,
  dhsPortLAChemical,
  lapdSkidRowWelfare,
  calFireDixieComplex,
]
