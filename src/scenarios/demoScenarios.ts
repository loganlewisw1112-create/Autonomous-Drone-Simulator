import type { ScenarioConfig } from '@/types'

/**
 * SFPD — Armed Robbery Suspect Grid Search · Financial District, San Francisco
 *
 * Op brief: Armed robbery at Embarcadero Center; suspect fled on foot into the Financial
 * District. SFPD UAV Unit deploys from the Ferry Building staging lot — closest open area
 * to the scene. Three drones execute an E-W lawnmower grid over Battery / Front / Davis
 * Street corridor. UAV-01 (100ft) delivers close-range thermal ID in alleys; UAV-02 (120ft)
 * covers mid-block gaps; UAV-03 (140ft) maintains wide-area overwatch and acts as comms relay.
 * Converge on a central intercept point after completing the grid sweep.
 * Comms degrade at T+40s — Salesforce Tower RF shadow.
 */
export const suspectSearch: ScenarioConfig = {
  id: 'demo_suspect_search',
  name: 'SFPD — Suspect Grid Search',
  description:
    'Armed robbery at Embarcadero Center. Three drones sweep Financial District in an E-W lawnmower grid. UAV-01 (100ft) thermal ID; UAV-02 (120ft) alley coverage; UAV-03 (140ft) overwatch/relay. Comms degraded by Salesforce Tower RF shadow at T+40s.',
  seed: 1001,
  droneCount: 3,
  missionType: 'waypoint',
  startPosition: { lat: 37.7955, lng: -122.3937 }, // Ferry Building staging lot
  waypoints: [
    { id: 'wp-battery-s', position: { lat: 37.7942, lng: -122.3991 }, altitudeFt: 120, label: 'Battery-S' },
    { id: 'wp-battery-n', position: { lat: 37.7960, lng: -122.3991 }, altitudeFt: 120, label: 'Battery-N' },
    { id: 'wp-front-n',   position: { lat: 37.7960, lng: -122.3971 }, altitudeFt: 120, label: 'Front-N' },
    { id: 'wp-front-s',   position: { lat: 37.7942, lng: -122.3971 }, altitudeFt: 120, label: 'Front-S' },
    { id: 'wp-davis-s',   position: { lat: 37.7942, lng: -122.3952 }, altitudeFt: 120, label: 'Davis-S' },
    { id: 'wp-davis-n',   position: { lat: 37.7960, lng: -122.3952 }, altitudeFt: 120, label: 'Davis-N' },
    { id: 'wp-intercept', position: { lat: 37.7950, lng: -122.3968 }, altitudeFt: 100, label: 'Intercept' },
  ],
  geofences: [
    {
      id: 'gf-transamerica',
      label: 'Transamerica Pyramid TFR',
      polygon: [
        { lat: 37.7952, lng: -122.4028 },
        { lat: 37.7952, lng: -122.4005 },
        { lat: 37.7962, lng: -122.4005 },
        { lat: 37.7962, lng: -122.4028 },
      ],
      maxAltitudeFt: 0,
      type: 'no_fly',
    },
  ],
  heatSources: [
    { id: 'hs-suspect', class: 'generic-person', position: { lat: 37.7952, lng: -122.3974 }, tempC: 37,  radiusM: 2 },
    { id: 'hs-getaway', class: 'vehicle',         position: { lat: 37.7948, lng: -122.3982 }, tempC: 110, radiusM: 5 },
  ],
  // Pincer approach — each drone sweeps its own block column then converges on intercept
  perDroneWaypoints: {
    'uav-01': [
      { id: 'd1-bat-s', position: { lat: 37.7942, lng: -122.3991 }, altitudeFt: 100, label: 'Battery-S' },
      { id: 'd1-bat-n', position: { lat: 37.7960, lng: -122.3991 }, altitudeFt: 100, label: 'Battery-N' },
      { id: 'd1-inter', position: { lat: 37.7950, lng: -122.3968 }, altitudeFt: 100, label: 'Intercept', dwellTimeSec: 10 },
    ],
    'uav-02': [
      { id: 'd2-frt-n', position: { lat: 37.7960, lng: -122.3971 }, altitudeFt: 120, label: 'Front-N' },
      { id: 'd2-frt-s', position: { lat: 37.7942, lng: -122.3971 }, altitudeFt: 120, label: 'Front-S' },
      { id: 'd2-inter', position: { lat: 37.7950, lng: -122.3968 }, altitudeFt: 100, label: 'Intercept', dwellTimeSec: 8 },
    ],
    'uav-03': [
      { id: 'd3-dav-n', position: { lat: 37.7960, lng: -122.3952 }, altitudeFt: 140, label: 'Davis-N' },
      { id: 'd3-dav-s', position: { lat: 37.7942, lng: -122.3952 }, altitudeFt: 140, label: 'Davis-S' },
      { id: 'd3-inter', position: { lat: 37.7950, lng: -122.3968 }, altitudeFt: 120, label: 'Intercept', dwellTimeSec: 6 },
    ],
  },
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.025, // urban turns, frequent heading changes
  commsLossWindows: [{ startSec: 40, durationSec: 12 }], // Salesforce Tower RF shadow
}

/**
 * OPD — Stolen Vehicle Pursuit · Oakland Broadway Corridor
 *
 * Op brief: Stolen vehicle spotted at 12th Street BART, fleeing south on Broadway toward the
 * waterfront. OPD Air Support deploys from Oakland City Center staging (adjacent to 12th St BART).
 * Doctrine: relay chain — UAV-01 (100ft) maintains tight overhead track; UAV-02 (120ft) holds
 * mid-corridor as handoff relay; UAV-03 (140ft) flies ahead to the I-880/Oak Street chokepoint
 * to establish intercept surveillance before the vehicle arrives. Staggered altitude bands ensure
 * zero mid-air risk while all three drones converge on the same pursuit corridor.
 * Comms degrade at T+55s — I-880 overpass RF shadow.
 */
export const vehiclePursuit: ScenarioConfig = {
  id: 'demo_vehicle_pursuit',
  name: 'OPD — Vehicle Pursuit (Oakland)',
  description:
    'Stolen vehicle fleeing south on Broadway. Relay chain: UAV-01 (100ft) tracks overhead, UAV-02 (120ft) mid-relay, UAV-03 (140ft) pre-positions at I-880 intercept. High battery drain — pursuit speed. Comms lost under overpass at T+55s.',
  seed: 2002,
  droneCount: 3,
  missionType: 'waypoint',
  startPosition: { lat: 37.8012, lng: -122.2750 }, // Oakland City Center / 12th St BART staging
  waypoints: [
    { id: 'wp-contact',   position: { lat: 37.8005, lng: -122.2739 }, altitudeFt: 100, label: 'Contact-N (Broadway/12th)' },
    { id: 'wp-pursuit-1', position: { lat: 37.7980, lng: -122.2752 }, altitudeFt: 100, label: 'Pursuit (Broadway/7th)' },
    { id: 'wp-pursuit-2', position: { lat: 37.7955, lng: -122.2773 }, altitudeFt: 100, label: 'Pursuit (Broadway/3rd)' },
    { id: 'wp-oak-ramp',  position: { lat: 37.7938, lng: -122.2800 }, altitudeFt: 100, label: 'Oak St / I-880 Ramp' },
    { id: 'wp-intercept', position: { lat: 37.7928, lng: -122.2820 }, altitudeFt: 80,  label: 'Intercept (UAV-03 pre-pos)' },
    { id: 'wp-cordon',    position: { lat: 37.7945, lng: -122.2795 }, altitudeFt: 100, label: 'Cordon-E (escape route)' },
  ],
  geofences: [
    {
      id: 'gf-oak-port',
      label: 'Port of Oakland Restricted Airspace',
      polygon: [
        { lat: 37.7880, lng: -122.2900 },
        { lat: 37.7880, lng: -122.2700 },
        { lat: 37.7820, lng: -122.2700 },
        { lat: 37.7820, lng: -122.2900 },
      ],
      maxAltitudeFt: 100,
      type: 'restricted',
    },
  ],
  heatSources: [
    { id: 'hs-vehicle', class: 'vehicle',         position: { lat: 37.7975, lng: -122.2755 }, tempC: 150, radiusM: 4 },
    { id: 'hs-driver',  class: 'generic-person', position: { lat: 37.7976, lng: -122.2756 }, tempC: 37,  radiusM: 2 },
  ],
  // True relay chain — each drone holds a distinct corridor segment
  perDroneWaypoints: {
    'uav-01': [
      { id: 'd1-contact',  position: { lat: 37.8005, lng: -122.2739 }, altitudeFt: 100, label: 'Contact-N', dwellTimeSec: 5 },
      { id: 'd1-bway-10', position: { lat: 37.7993, lng: -122.2745 }, altitudeFt: 100, label: 'Broadway/10th' },
      { id: 'd1-purs-1',  position: { lat: 37.7980, lng: -122.2752 }, altitudeFt: 100, label: 'Pursuit/7th' },
      { id: 'd1-purs-2',  position: { lat: 37.7955, lng: -122.2773 }, altitudeFt: 100, label: 'Pursuit/3rd' },
    ],
    'uav-02': [
      { id: 'd2-purs-1',  position: { lat: 37.7980, lng: -122.2752 }, altitudeFt: 120, label: 'Pursuit/7th' },
      { id: 'd2-oak-ramp', position: { lat: 37.7938, lng: -122.2800 }, altitudeFt: 120, label: 'Oak/I-880 Ramp' },
      { id: 'd2-cordon',  position: { lat: 37.7945, lng: -122.2795 }, altitudeFt: 120, label: 'Cordon-E' },
    ],
    'uav-03': [
      { id: 'd3-bway-s',  position: { lat: 37.7968, lng: -122.2755 }, altitudeFt: 140, label: 'Broadway-S' },
      { id: 'd3-oak-app', position: { lat: 37.7945, lng: -122.2788 }, altitudeFt: 140, label: 'Oak St approach' },
      { id: 'd3-inter',   position: { lat: 37.7928, lng: -122.2820 }, altitudeFt: 140, label: 'Intercept Pre-Pos', dwellTimeSec: 15 },
      { id: 'd3-cordon',  position: { lat: 37.7945, lng: -122.2795 }, altitudeFt: 140, label: 'Cordon-E' },
      { id: 'd3-oak-ramp', position: { lat: 37.7938, lng: -122.2800 }, altitudeFt: 140, label: 'Oak/I-880 Ramp' },
    ],
  },
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.030, // high-speed pursuit, sustained max throttle
  commsLossWindows: [{ startSec: 55, durationSec: 8 }], // I-880 overpass RF shadow
}

/**
 * SFPD + USCG — Missing Swimmers · Ocean Beach, San Francisco
 *
 * Op brief: Two swimmers overdue at sunset; now dark. Marine layer and sea mist reduce optical
 * visibility to near-zero — thermal is primary sensor. SFPD Harbor Unit coordinates with USCG
 * Station Golden Gate. UAV team deploys from Ocean Beach Balboa St parking lot. Hypothermic
 * swimmers have a weakened thermal signature (34–36°C vs 37°C healthy) and a detection radius
 * of just 1m — close approach by UAV-01 (100ft) along the nearshore strip is critical.
 * N-S parallel tracks run the full length of the beach strip before turning.
 * Marine layer RF degradation begins at T+90s over open water.
 */
export const sarCoastal: ScenarioConfig = {
  id: 'demo_sar_coastal',
  name: 'SAR — Coastal / Ocean Beach',
  description:
    'Two missing swimmers, hypothermic. Night op — thermal only. UAV-01 (100ft) sweeps nearshore; UAV-02 (120ft) beach face; UAV-03 (140ft) dune strip + comms relay. Weak thermal signature (34–36°C) demands close approach. Marine layer comms degradation at T+90s.',
  seed: 3003,
  droneCount: 3,
  missionType: 'sar_parallel',
  startPosition: { lat: 37.7695, lng: -122.5103 }, // Ocean Beach / Balboa St parking lot
  waypoints: [],
  searchArea: [
    { lat: 37.7740, lng: -122.5115 }, // NW — north end of search strip, near water
    { lat: 37.7640, lng: -122.5115 }, // SW — south end, near water
    { lat: 37.7640, lng: -122.5092 }, // SE — inland boundary south
    { lat: 37.7740, lng: -122.5092 }, // NE — inland boundary north
  ],
  geofences: [
    {
      id: 'gf-surf-zone',
      label: 'Surf Zone / Pelagic TFR (USCG active)',
      polygon: [
        { lat: 37.7640, lng: -122.5135 },
        { lat: 37.7640, lng: -122.5115 },
        { lat: 37.7740, lng: -122.5115 },
        { lat: 37.7740, lng: -122.5135 },
      ],
      maxAltitudeFt: 150,
      type: 'restricted',
    },
  ],
  heatSources: [
    { id: 'hs-swim-a', class: 'generic-person', position: { lat: 37.7712, lng: -122.5109 }, tempC: 35, radiusM: 1 },
    { id: 'hs-swim-b', class: 'generic-person', position: { lat: 37.7675, lng: -122.5112 }, tempC: 34, radiusM: 1 },
    { id: 'hs-rib',    class: 'vehicle',         position: { lat: 37.7725, lng: -122.5097 }, tempC: 65, radiusM: 4 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.020, // sea winds, methodical grid speed
  commsLossWindows: [{ startSec: 90, durationSec: 18 }], // marine layer RF absorption
}

/**
 * USCG + Oakland Port Police — Suspicious Vessel · Port of Oakland Terminal 56
 *
 * Op brief: Vessel "AMELIA ROSE" approached Terminal 56 without AIS transponder. Manifested
 * as bulk cargo but draft profile inconsistent with stated load. USCG Sector SF requests
 * aerial perimeter while a boarding team prepares. Tactic: overlapping perimeter sectors —
 * each drone completes the full terminal loop so any fixed point has at least two drones
 * in sensor range simultaneously. UAV-01 (100ft) stays close to the vessel and dock;
 * UAV-02 (120ft) covers gate vehicle movement; UAV-03 (140ft) provides full-terminal
 * overwatch. Four thermal contacts: vessel, person of interest, authorized security vehicle,
 * unscheduled vehicle at SE gate. Crane RF interference at T+120s.
 */
export const portPerimeter: ScenarioConfig = {
  id: 'demo_perimeter',
  name: 'Port Security — Perimeter Patrol',
  description:
    'Suspicious vessel at Terminal 56, no AIS. Overlapping perimeter: UAV-01 (100ft) vessel/dock; UAV-02 (120ft) gates; UAV-03 (140ft) full terminal overwatch. Four thermal contacts: vessel, POI, authorized truck, unscheduled vehicle. Crane RF interference at T+120s.',
  seed: 4004,
  droneCount: 3,
  missionType: 'waypoint',
  startPosition: { lat: 37.7965, lng: -122.2855 }, // Port Authority security building
  waypoints: [
    { id: 'wp-gate-n',  position: { lat: 37.7995, lng: -122.2875 }, altitudeFt: 120, label: 'Gate-N (berth entrance)' },
    { id: 'wp-bow-ne',  position: { lat: 37.7995, lng: -122.2820 }, altitudeFt: 120, label: 'Bow-NE (vessel bow)' },
    { id: 'wp-berth-e', position: { lat: 37.7968, lng: -122.2808 }, altitudeFt: 100, label: 'Berth-E (dockside)' },
    { id: 'wp-gate-se', position: { lat: 37.7942, lng: -122.2818 }, altitudeFt: 120, label: 'Gate-SE' },
    { id: 'wp-gate-s',  position: { lat: 37.7935, lng: -122.2858 }, altitudeFt: 120, label: 'Gate-S (truck entrance)' },
    { id: 'wp-fence-w', position: { lat: 37.7955, lng: -122.2882 }, altitudeFt: 120, label: 'Fence-W (perimeter)' },
  ],
  geofences: [
    {
      id: 'gf-cranes',
      label: 'Crane Superstructure — No Fly',
      polygon: [
        { lat: 37.7985, lng: -122.2848 },
        { lat: 37.7985, lng: -122.2810 },
        { lat: 37.7998, lng: -122.2810 },
        { lat: 37.7998, lng: -122.2848 },
      ],
      maxAltitudeFt: 0,
      type: 'no_fly',
    },
  ],
  heatSources: [
    { id: 'hs-vessel',  class: 'vehicle',         position: { lat: 37.7988, lng: -122.2820 }, tempC: 95,  radiusM: 8 },
    { id: 'hs-poi',     class: 'generic-person', position: { lat: 37.7985, lng: -122.2822 }, tempC: 37,  radiusM: 2 },
    { id: 'hs-sec',     class: 'vehicle',         position: { lat: 37.7960, lng: -122.2858 }, tempC: 75,  radiusM: 4 },
    { id: 'hs-unauth',  class: 'vehicle',         position: { lat: 37.7942, lng: -122.2825 }, tempC: 88,  radiusM: 4 },
  ],
  // Overlapping sectors — each drone owns a distinct zone around the terminal
  perDroneWaypoints: {
    'uav-01': [
      { id: 'd1-bow-ne',  position: { lat: 37.7995, lng: -122.2820 }, altitudeFt: 100, label: 'Bow-NE (vessel bow)', dwellTimeSec: 8 },
      { id: 'd1-berth-e', position: { lat: 37.7968, lng: -122.2808 }, altitudeFt: 100, label: 'Berth-E (dockside)', dwellTimeSec: 8 },
      { id: 'd1-gate-se', position: { lat: 37.7942, lng: -122.2818 }, altitudeFt: 100, label: 'Gate-SE', dwellTimeSec: 8 },
    ],
    'uav-02': [
      { id: 'd2-gate-n',   position: { lat: 37.7995, lng: -122.2875 }, altitudeFt: 120, label: 'Gate-N', dwellTimeSec: 8 },
      { id: 'd2-berth-mid', position: { lat: 37.7968, lng: -122.2845 }, altitudeFt: 120, label: 'Berth-Mid' },
      { id: 'd2-gate-se',  position: { lat: 37.7942, lng: -122.2818 }, altitudeFt: 120, label: 'Gate-SE', dwellTimeSec: 8 },
      { id: 'd2-gate-s',   position: { lat: 37.7935, lng: -122.2858 }, altitudeFt: 120, label: 'Gate-S (truck)', dwellTimeSec: 8 },
    ],
    'uav-03': [
      { id: 'd3-gate-n',  position: { lat: 37.7995, lng: -122.2875 }, altitudeFt: 140, label: 'Gate-N' },
      { id: 'd3-bow-ne',  position: { lat: 37.7995, lng: -122.2820 }, altitudeFt: 140, label: 'Bow-NE', dwellTimeSec: 8 },
      { id: 'd3-berth-e', position: { lat: 37.7968, lng: -122.2808 }, altitudeFt: 140, label: 'Berth-E', dwellTimeSec: 8 },
      { id: 'd3-gate-se', position: { lat: 37.7942, lng: -122.2818 }, altitudeFt: 140, label: 'Gate-SE' },
      { id: 'd3-gate-s',  position: { lat: 37.7935, lng: -122.2858 }, altitudeFt: 140, label: 'Gate-S' },
      { id: 'd3-fence-w', position: { lat: 37.7955, lng: -122.2882 }, altitudeFt: 140, label: 'Fence-W' },
    ],
  },
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.016, // slow deliberate perimeter patrol
  commsLossWindows: [{ startSec: 120, durationSec: 25 }], // port crane RF interference
}

/**
 * CAL FIRE + EBRPD — Active Wildfire Reconnaissance · Grizzly Peak / East Bay Hills
 *
 * Op brief: 15-acre grass fire at Grizzly Peak, SW winds pushing fire NE into Tilden Regional
 * Park. CAL FIRE Air Attack Base requests aerial recon to map the fire edge, locate spotfires,
 * and identify any structures in the fire path for ground crew prioritization.
 * Risk: thermal updrafts above the main fire column create turbulence — drones must NOT loiter
 * directly above the column. Tactic: three-flank approach.
 * UAV-01 (100ft): southern upwind flank — safest approach angle, thermal scan of backing fire.
 * UAV-02 (120ft): eastern flank — parallel to fire spread direction, mapping the leading edge.
 * UAV-03 (140ft): northern downwind flank at max altitude to avoid the column; doubles as
 * comms relay between staging and ICS operations section.
 * The no-fly geofence directly over the fire column enforces altitude discipline automatically.
 * Smoke RF degradation begins at T+80s.
 */
export const wildfireRecon: ScenarioConfig = {
  id: 'demo_wildfire',
  name: 'CAL FIRE — Wildfire Recon (East Bay)',
  description:
    '15-acre Grizzly Peak grass fire, SW winds. Three-flank approach: UAV-01 (100ft) southern upwind; UAV-02 (120ft) eastern leading edge; UAV-03 (140ft) northern downwind overwatch + relay. No-fly geofence over active fire column. 5 thermal contacts incl. spotfires and structure threat. Smoke RF at T+80s.',
  seed: 5005,
  droneCount: 3,
  missionType: 'waypoint',
  startPosition: { lat: 37.8992, lng: -122.2432 }, // Tilden Park / CAL FIRE staging area
  waypoints: [
    { id: 'wp-flank-s',  position: { lat: 37.8955, lng: -122.2395 }, altitudeFt: 160, label: 'Flank-S (upwind, safe)' },
    { id: 'wp-spot-sw',  position: { lat: 37.8960, lng: -122.2360 }, altitudeFt: 140, label: 'Spotfire-SW (thermal scan)' },
    { id: 'wp-flank-e',  position: { lat: 37.8985, lng: -122.2318 }, altitudeFt: 180, label: 'Flank-E (leading edge)' },
    { id: 'wp-spot-ne',  position: { lat: 37.9005, lng: -122.2335 }, altitudeFt: 180, label: 'Spotfire-NE (ember cast)' },
    { id: 'wp-flank-n',  position: { lat: 37.9020, lng: -122.2385 }, altitudeFt: 200, label: 'Flank-N (downwind, max alt)' },
    { id: 'wp-relay',    position: { lat: 37.9010, lng: -122.2445 }, altitudeFt: 200, label: 'Relay Pt (LOS to staging)' },
  ],
  geofences: [
    {
      id: 'gf-fire-column',
      label: 'Active Fire Column — No Fly',
      polygon: [
        { lat: 37.8970, lng: -122.2370 },
        { lat: 37.8970, lng: -122.2330 },
        { lat: 37.8995, lng: -122.2330 },
        { lat: 37.8995, lng: -122.2370 },
      ],
      maxAltitudeFt: 0,
      type: 'no_fly',
    },
  ],
  heatSources: [
    { id: 'hs-fire-core', class: 'campfire',     position: { lat: 37.8975, lng: -122.2352 }, tempC: 650, radiusM: 20 },
    { id: 'hs-spot-a',    class: 'campfire',     position: { lat: 37.9002, lng: -122.2338 }, tempC: 420, radiusM: 12 },
    { id: 'hs-spot-b',    class: 'campfire',     position: { lat: 37.8958, lng: -122.2365 }, tempC: 380, radiusM: 8  },
    { id: 'hs-structure', class: 'heat-source',  position: { lat: 37.8970, lng: -122.2328 }, tempC: 85,  radiusM: 6  },
    { id: 'hs-crew',      class: 'vehicle',      position: { lat: 37.8992, lng: -122.2432 }, tempC: 70,  radiusM: 4  },
  ],
  // Three-flank approach — each drone locked to its assigned flank, never crossing the column
  perDroneWaypoints: {
    'uav-01': [
      { id: 'd1-flank-s', position: { lat: 37.8955, lng: -122.2395 }, altitudeFt: 160, label: 'Flank-S (upwind)' },
      { id: 'd1-spot-sw', position: { lat: 37.8960, lng: -122.2360 }, altitudeFt: 140, label: 'Spotfire-SW', dwellTimeSec: 12 },
      { id: 'd1-relay',   position: { lat: 37.9010, lng: -122.2445 }, altitudeFt: 160, label: 'Relay Pt' },
    ],
    'uav-02': [
      { id: 'd2-flank-e', position: { lat: 37.8985, lng: -122.2318 }, altitudeFt: 180, label: 'Flank-E (leading edge)' },
      { id: 'd2-spot-ne', position: { lat: 37.9005, lng: -122.2335 }, altitudeFt: 180, label: 'Spotfire-NE', dwellTimeSec: 12 },
      { id: 'd2-relay',   position: { lat: 37.9010, lng: -122.2445 }, altitudeFt: 180, label: 'Relay Pt' },
    ],
    'uav-03': [
      { id: 'd3-flank-n', position: { lat: 37.9020, lng: -122.2385 }, altitudeFt: 200, label: 'Flank-N (downwind)' },
      { id: 'd3-relay',   position: { lat: 37.9010, lng: -122.2445 }, altitudeFt: 200, label: 'Relay Pt' },
      { id: 'd3-spot-ne', position: { lat: 37.9005, lng: -122.2335 }, altitudeFt: 200, label: 'Spotfire-NE', dwellTimeSec: 10 },
    ],
  },
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.028, // thermal updrafts, variable wind, high power draw
  commsLossWindows: [{ startSec: 80, durationSec: 20 }], // smoke column RF absorption
}
