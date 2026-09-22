/**
 * cameraDirector.js — cinematic camera rig for a MapLibre GL JS map.
 *
 * Verified against maplibre-gl 6.6.0 (the version your preview build ships).
 * NOT verified against your source tree — I have not seen your components.
 *
 * Why this shape: every mode computes a camera POSITION and a LOOK-AT POINT in
 * (lng, lat, altitude-MSL), then hands both to map.calculateCameraOptionsFromTo().
 * MapLibre does the zoom/pitch/bearing math, so there is no hand-rolled
 * distance->zoom formula to get wrong, and it is the only path that produces
 * pitch > 90 (camera below the subject, looking up).
 *
 * Preconditions this module sets up for you (unlockCamera):
 *   map.setMaxPitch(180)                 // default is 60; setPitch() alone still re-clamps
 *   map.setCenterClampedToGround(false)  // required or elevation is ignored
 *   a sky layer                          // without one, everything above the horizon is void
 */

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos(lat * DEG);

const offsetMeters = (ll, east, north) => ({
  lng: ll.lng + east / mPerDegLng(ll.lat),
  lat: ll.lat + north / M_PER_DEG_LAT,
});

/** Critically damped spring. `smoothing` = seconds to cover ~63% of the gap. */
function damp(current, target, smoothing, dt) {
  if (smoothing <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / smoothing));
}

function dampAngle(current, target, smoothing, dt) {
  let d = ((target - current + 540) % 360) - 180;
  return current + d * (1 - Math.exp(-dt / smoothing));
}

export function unlockCamera(map, { sky = true } = {}) {
  map.setMaxPitch(180);
  map.setCenterClampedToGround(false);
  if (sky) installSky(map);
}

export function relockCamera(map, { maxPitch = 60 } = {}) {
  map.setCenterClampedToGround(true);
  map.setMaxPitch(maxPitch);
  map.setRoll(0);
  map.setVerticalFieldOfView(36.87);
}

/** Without this, pitch > ~80 shows raw canvas background above the horizon. */
export function installSky(map) {
  map.setSky({
    'sky-color': '#0b1c33',
    'sky-horizon-blend': 0.55,
    'horizon-color': '#7f9fc4',
    'horizon-fog-blend': 0.6,
    'fog-color': '#c3d2e2',
    'fog-ground-blend': 0.22,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0.6, 20, 0.35],
  });
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {object} opts
 * @param {() => ({lng:number, lat:number, altAgl:number, heading:number}|null)} opts.getSubject
 *        Called once per frame. altAgl in metres AGL, heading in degrees true.
 * @param {number} [opts.groundFallback]  MSL metres to use before DEM tiles resolve.
 */
export function createCameraDirector(map, { getSubject, groundFallback = 0 }) {
  let mode = 'TACTICAL';
  let raf = null;
  let last = 0;
  let orbitBearing = 0;
  let groundAnchor = null; // {lng, lat} observer standpoint for GROUND mode

  // Smoothed camera state, in the same units we feed to calculateCameraOptionsFromTo.
  const cam = { lng: 0, lat: 0, alt: 0, initialised: false };
  const look = { lng: 0, lat: 0, alt: 0 };
  let fov = 36.87;
  let roll = 0;

  const elevCache = new Map();
  function groundAt(ll) {
    const key = `${ll.lng.toFixed(4)},${ll.lat.toFixed(4)}`;
    const hit = elevCache.get(key);
    // queryTerrainElevation returns null until the DEM tile for that point is loaded.
    const q = map.queryTerrainElevation(ll);
    if (q != null) {
      elevCache.set(key, q);
      return q;
    }
    return hit != null ? hit : groundFallback;
  }

  const PRESETS = {
    // radius m, elevation angle above horizontal, deg/sec, fov, roll
    ORBIT:  { radius: 220, elev: 28, spin: 6,  fov: 42, roll: 0,  smooth: 0.8 },
    CHASE:  { behind: 90,  above: 35, fov: 55, roll: 0,  smooth: 0.35 },
    FPV:    { ahead: 260,  down: 18, fov: 78, roll: 0,  smooth: 0.18 },
    GROUND: { eye: 1.7,    standoff: 140, fov: 62, roll: 0, smooth: 1.1 },
  };

  /** Desired (unsmoothed) camera + look-at for the current mode. */
  function solve(subject, dt) {
    const gnd = groundAt(subject);
    const subjAlt = gnd + subject.altAgl;
    const subjLL = { lng: subject.lng, lat: subject.lat };

    if (mode === 'ORBIT') {
      const p = PRESETS.ORBIT;
      orbitBearing = (orbitBearing + p.spin * dt) % 360;
      const r = p.radius * Math.cos(p.elev * DEG);
      const pos = offsetMeters(subjLL, r * Math.sin(orbitBearing * DEG), r * Math.cos(orbitBearing * DEG));
      return {
        cam: { ...pos, alt: subjAlt + p.radius * Math.sin(p.elev * DEG) },
        look: { ...subjLL, alt: subjAlt },
        fov: p.fov, roll: p.roll, smooth: p.smooth,
      };
    }

    if (mode === 'CHASE') {
      const p = PRESETS.CHASE;
      const h = subject.heading * DEG;
      const pos = offsetMeters(subjLL, -p.behind * Math.sin(h), -p.behind * Math.cos(h));
      // Lead the look-at point so turns read as turns rather than as drift.
      const lead = offsetMeters(subjLL, 60 * Math.sin(h), 60 * Math.cos(h));
      return {
        cam: { ...pos, alt: subjAlt + p.above },
        look: { ...lead, alt: subjAlt },
        fov: p.fov, roll: p.roll, smooth: p.smooth,
      };
    }

    if (mode === 'FPV') {
      const p = PRESETS.FPV;
      const h = subject.heading * DEG;
      const ahead = offsetMeters(subjLL, p.ahead * Math.sin(h), p.ahead * Math.cos(h));
      return {
        cam: { ...subjLL, alt: subjAlt },
        look: { ...ahead, alt: subjAlt - p.ahead * Math.tan(p.down * DEG) },
        fov: p.fov, roll: p.roll, smooth: p.smooth,
      };
    }

    if (mode === 'GROUND') {
      const p = PRESETS.GROUND;
      if (!groundAnchor) {
        const h = subject.heading * DEG;
        groundAnchor = offsetMeters(subjLL, -p.standoff * Math.sin(h), -p.standoff * Math.cos(h));
      }
      // This is the shot that needs pitch > 90: eye at 1.7 m, subject overhead.
      return {
        cam: { ...groundAnchor, alt: groundAt(groundAnchor) + p.eye },
        look: { ...subjLL, alt: subjAlt },
        fov: p.fov, roll: p.roll, smooth: p.smooth,
      };
    }

    return null;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1); // clamp after a tab stall
    last = now;
    if (mode === 'TACTICAL') return;

    const subject = getSubject();
    if (!subject) return;

    const want = solve(subject, dt);
    if (!want) return;

    if (!cam.initialised) {
      Object.assign(cam, want.cam);
      Object.assign(look, want.look);
      cam.initialised = true;
    } else {
      const s = want.smooth;
      cam.lng = damp(cam.lng, want.cam.lng, s, dt);
      cam.lat = damp(cam.lat, want.cam.lat, s, dt);
      cam.alt = damp(cam.alt, want.cam.alt, s, dt);
      look.lng = damp(look.lng, want.look.lng, s, dt);
      look.lat = damp(look.lat, want.look.lat, s, dt);
      look.alt = damp(look.alt, want.look.alt, s, dt);
    }
    fov = damp(fov, want.fov, 0.6, dt);
    roll = dampAngle(roll, want.roll, 0.6, dt);

    // FOV first: calculateCameraOptionsFromTo derives zoom from the current FOV.
    map.setVerticalFieldOfView(fov);
    const o = map.calculateCameraOptionsFromTo(
      { lng: cam.lng, lat: cam.lat }, cam.alt,
      { lng: look.lng, lat: look.lat }, look.alt,
    );
    o.roll = roll;
    // jumpTo, never easeTo: per-frame eased moves queue up and fight each other.
    map.jumpTo(o);
  }

  return {
    get mode() { return mode; },

    setMode(next, { anchor = null } = {}) {
      if (next === mode) return;
      mode = next;
      cam.initialised = false;
      groundAnchor = anchor;
      if (next === 'TACTICAL') {
        relockCamera(map);
        this.stop();
      } else {
        unlockCamera(map);
        this.start();
      }
    },

    /** Drop the ground observer wherever the user clicked. */
    setGroundAnchor(lngLat) { groundAnchor = lngLat; cam.initialised = false; },

    start() {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },

    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    },

    destroy() { this.stop(); relockCamera(map); },
  };
}
