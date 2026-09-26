import type { DronePlatformSpec, PlatformId } from './platformCatalog'

/**
 * Where every PLATFORM_CATALOG figure comes from (realism pass, retrieved 2026-09-25).
 *
 * - `published`: the manufacturer's own spec page, datasheet or manual, with the exact text the
 *   value was read from. Each was re-opened by an independent checker, except the Teal 2 values:
 *   tealdrones.com refused connections, so they come from Internet Archive captures of Teal's own
 *   pages (`archivedUrl`), re-read directly from those captures.
 * - `modelled`: the manufacturer publishes no figure; the value is a modelling choice, said so.
 * - `unpublished`: no figure is published and none is modelled; the catalog field is null.
 *
 * Deliberately not imported by the simulation: this is the audit trail, kept off the startup bundle.
 */

export const SPEC_SOURCES_RETRIEVED = '2026-09-25'

export type SpecProvenance =
  | { kind: 'published'; url: string; quote: string; archivedUrl?: string; note?: string }
  | { kind: 'modelled'; note: string }
  | { kind: 'unpublished'; note: string }

export type SourcedField = keyof Pick<DronePlatformSpec,
  | 'massKg' | 'maxSpeedMs' | 'airframeMaxSpeedMs' | 'climbRateFtS' | 'descentRateFtS'
  | 'turnRateDegS' | 'accelMs2' | 'windToleranceMs' | 'gustToleranceMs' | 'enduranceMin'
  | 'operatingTempC' | 'ipRating' | 'battery'>

export const PLATFORM_SOURCES: Record<PlatformId, Record<SourcedField, SpecProvenance>> = {
  skydio_x10: {
    massKg: { kind: "published", url: "https://pages.skydio.com/rs/784-TUF-591/images/X10_Data%20Sheet_Digital_10_09_2023.pdf", quote: "Weight (including batteries) Connect SL: 2.11 kg / 4.65 lbs Connect SL + 5G: 2.14 kg / 4.72 lbs", note: "With battery, Connect SL radio; no accessory payload." },
    maxSpeedMs: { kind: "published", url: "https://www.skydio.com/x10/technical-specs", quote: "Max horizontal speed (at sea level) 45mph / 20 m/s" },
    airframeMaxSpeedMs: { kind: "published", url: "https://www.skydio.com/x10/technical-specs", quote: "Max horizontal speed (at sea level) 45mph / 20 m/s" },
    climbRateFtS: { kind: "published", url: "https://www.skydio.com/x10/technical-specs", quote: "Max ascent/descent speed Ascent: 6 m/s / 13.4 mph", note: "6 m/s = 19.7 ft/s." },
    descentRateFtS: { kind: "published", url: "https://www.skydio.com/x10/technical-specs", quote: "Descent: 4 m/s / 9.0 mph", note: "Vertical descent 4 m/s = 13.1 ft/s." },
    turnRateDegS: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    accelMs2: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    windToleranceMs: { kind: "modelled", note: "Skydio publishes no sustained-wind rating, only the 12.8 m/s gust figure; model value set below it." },
    gustToleranceMs: { kind: "published", url: "https://www.skydio.com/x10/technical-specs", quote: "Max gust handling 12.8 m/s / 28.6 mph" },
    enduranceMin: { kind: "published", url: "https://www.skydio.com/x10/technical-specs", quote: "Max flight time* 40 minutes ... *Conducted under ideal lab conditions", note: "Quoted under ideal lab conditions; max hover time is published separately as 35 min." },
    operatingTempC: { kind: "published", url: "https://pages.skydio.com/rs/784-TUF-591/images/X10_Data%20Sheet_Digital_10_09_2023.pdf", quote: "Operational Temperature Range -20 °C to +45 °C / -4 °F to 113 °F" },
    ipRating: { kind: "published", url: "https://pages.skydio.com/rs/784-TUF-591/images/X10_Data%20Sheet_Digital_10_09_2023.pdf", quote: "Ingress Protection Rating IP55" },
    battery: { kind: "published", url: "https://www.skydio.com/x10/technical-specs", quote: "Flight battery Rev 2 ... Capacity 8800 mAh Voltage 17.5 V ... Energy 154 Wh · Voltage 17.5 V", note: "Flight battery Rev 2 (current). Cell count not published." },
  },
  skydio_x10d: {
    massKg: { kind: "published", url: "https://www.skydio.com/x10d/technical-specs", quote: "Weight (incl. batteries) Connect SL: 4.65lbs / 2.11kg Connect MH: 4.72lbs / 2.14kg", note: "With batteries, Connect SL radio; no attachments." },
    maxSpeedMs: { kind: "published", url: "https://www.skydio.com/x10d/technical-specs", quote: "Max horizontal speed (at sea level) 45mph / 20 m/s" },
    airframeMaxSpeedMs: { kind: "published", url: "https://www.skydio.com/x10d/technical-specs", quote: "Max horizontal speed (at sea level) 45mph / 20 m/s" },
    climbRateFtS: { kind: "published", url: "https://www.skydio.com/x10d/technical-specs", quote: "Max ascent/descent speed Ascent: 13.4mph / 6 m/s", note: "6 m/s = 19.7 ft/s." },
    descentRateFtS: { kind: "published", url: "https://www.skydio.com/x10d/technical-specs", quote: "Descent: 9.0mph / 4 m/s", note: "Vertical descent 4 m/s = 13.1 ft/s." },
    turnRateDegS: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    accelMs2: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    windToleranceMs: { kind: "modelled", note: "Skydio publishes no sustained-wind rating, only the 12.8 m/s gust figure; model value set below it." },
    gustToleranceMs: { kind: "published", url: "https://www.skydio.com/x10d/technical-specs", quote: "Max gust handling At or under 28 mph / 12.8 m/s" },
    enduranceMin: { kind: "published", url: "https://www.skydio.com/x10d/technical-specs", quote: "Max flight time* 40 minutes ... *Conducted under ideal lab conditions", note: "Quoted under ideal lab conditions; max hover time is published separately as 35 min." },
    operatingTempC: { kind: "published", url: "https://www.skydio.com/x10d/technical-specs", quote: "Operational temperature range -4°F to 113°F / -20°C to +45°C" },
    ipRating: { kind: "published", url: "https://www.skydio.com/x10d/technical-specs", quote: "Ingress protection rating IP55" },
    battery: { kind: "published", url: "https://www.skydio.com/x10d/technical-specs", quote: "Energy 156.17 Wh · Voltage 18.55 V", note: "The X10D page lists only this pack (the X10 Rev 1 battery). Cell count not published." },
  },
  parrot_anafi_usa: {
    massKg: { kind: "published", url: "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", quote: "Mass: 500 g / 1.10 lb", note: "Battery inclusion not stated outright; 500 g against a 644 g MTOM reads as flight-ready mass." },
    maxSpeedMs: { kind: "published", url: "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", quote: "Maximum horizontal speed: 14.7 m/s" },
    airframeMaxSpeedMs: { kind: "published", url: "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", quote: "Maximum horizontal speed: 14.7 m/s" },
    climbRateFtS: { kind: "published", url: "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", quote: "Maximum ascent speed: 4 m/s (6 m/s on unlocked SE, GOV and MIL versions)", note: "Standard (locked) 4 m/s = 13.1 ft/s; 6 m/s on unlocked GOV/MIL/SE versions." },
    descentRateFtS: { kind: "published", url: "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", quote: "Maximum descent speed: 3 m/s", note: "3 m/s = 9.8 ft/s." },
    turnRateDegS: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    accelMs2: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    windToleranceMs: { kind: "published", url: "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", quote: "Maximum wind resistance: 14.7 m/s" },
    gustToleranceMs: { kind: "published", url: "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", quote: "Maximum wind resistance: 14.7 m/s", note: "Parrot publishes one wind limit, not split into sustained and gust; used for both." },
    enduranceMin: { kind: "published", url: "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", quote: "Maximum flight time: 32 minutes (30 minutes on MIL version)", note: "Flight regime not stated (30 min on the MIL version)." },
    operatingTempC: { kind: "published", url: "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", quote: "Operating temperature: -33 °F (-36 °C) to +122 °F (+50 °C)" },
    ipRating: { kind: "published", url: "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", quote: "IP53 certified: dust and rain resistant" },
    battery: { kind: "published", url: "https://www.parrot.com/assets/s3fs-public/2023-01/ANAFI-USA-GOV-user-manual.pdf", quote: "Voltage (nominal): 11.55 V (3 x 3.85 V cells) · Type: High density LiPo (3 x 4.4 V cells)", note: "Pack energy (Wh) not published." },
  },
  teal_2: {
    massKg: { kind: "published", url: "https://tealdrones.com/solutions/teal-2/", archivedUrl: "https://web.archive.org/web/20260813141641id_/https://tealdrones.com/solutions/teal-2/", quote: "Weight: 2.75 lbs (1.25 kg)", note: "Not stated whether the battery is included." },
    maxSpeedMs: { kind: "published", url: "https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", archivedUrl: "https://web.archive.org/web/20240813011103id_/https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", quote: "Top Horizontal Speed 32.8 ft/s (10 m/s, 23 mph)" },
    airframeMaxSpeedMs: { kind: "published", url: "https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", archivedUrl: "https://web.archive.org/web/20240813011103id_/https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", quote: "Top Horizontal Speed 32.8 ft/s (10 m/s, 23 mph)" },
    climbRateFtS: { kind: "published", url: "https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", archivedUrl: "https://web.archive.org/web/20240813011103id_/https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", quote: "Maximum Vertical Speed 8.2 ft/s (2.5 m/s)", note: "One shared vertical-speed limit." },
    descentRateFtS: { kind: "published", url: "https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", archivedUrl: "https://web.archive.org/web/20240813011103id_/https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", quote: "Maximum Vertical Speed 8.2 ft/s (2.5 m/s)", note: "One shared vertical-speed limit." },
    turnRateDegS: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    accelMs2: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    windToleranceMs: { kind: "published", url: "https://tealdrones.com/solutions/teal-2/", archivedUrl: "https://web.archive.org/web/20260813141641id_/https://tealdrones.com/solutions/teal-2/", quote: "Wind Limits: 18 mph (16 kn) Sustained to 25 mph (22 kn) Gusts", note: "18 mph = 8.05 m/s." },
    gustToleranceMs: { kind: "published", url: "https://tealdrones.com/solutions/teal-2/", archivedUrl: "https://web.archive.org/web/20260813141641id_/https://tealdrones.com/solutions/teal-2/", quote: "Wind Limits: 18 mph (16 kn) Sustained to 25 mph (22 kn) Gusts", note: "25 mph = 11.18 m/s." },
    enduranceMin: { kind: "published", url: "https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", archivedUrl: "https://web.archive.org/web/20240813011103id_/https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", quote: "Flight Time 30+ minutes (US Standard Atmosphere 1976, which is 59F, Sea Level, 29.92 Barometric Pressure)", note: "\"30+\" at ISA sea level; 30 is a lower bound." },
    operatingTempC: { kind: "published", url: "https://tealdrones.com/solutions/teal-2/", archivedUrl: "https://web.archive.org/web/20260813141641id_/https://tealdrones.com/solutions/teal-2/", quote: "Operation Temp Range: -32 to 110 F (-35.6 to 43.3 C)" },
    ipRating: { kind: "published", url: "https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", archivedUrl: "https://web.archive.org/web/20240813011103id_/https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", quote: "The AV is designed for IP-53." },
    battery: { kind: "published", url: "https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", archivedUrl: "https://web.archive.org/web/20240813011103id_/https://tealdrones.com/wp-content/uploads/2024/04/60111-Rev-B-Teal-2-and-Android14-with-RID-Operator-Manual.pdf", quote: "The cells have a capacity of 3 Ah (amp-hours), producing a total nominal energy of 66.6 Wh (watt-hours). This results in approximately 60 usable Wh from the pack · The Teal Performance Battery Pack consists of six (6) Sony VTC6 18650 lithium-ion cells wired in series to produce a total nominal voltage of 22.2 volts (3.7 VDC per cell)." },
  },
  freefly_astro_max: {
    massKg: { kind: "published", url: "https://docs.freeflysystems.com/astro/other-user-manuals/specs-and-interfaces/performance", quote: "Typical Empty Weight | 5,831 | Airframe, Radio, Smart Dovetail, Isolator, FPV, 2x Batteries", note: "Typical empty weight: airframe, radio, dovetail, isolator, FPV and both batteries; no payload." },
    maxSpeedMs: { kind: "published", url: "https://docs.freeflysystems.com/astro/other-user-manuals/specs-and-interfaces/performance", quote: "| Position | 15 | 4 | 3 |", note: "Flight Speeds table, Position-mode row: horizontal 15 | climb 4 | descent 3 (m/s); the table is shared by Astro and Astro Max." },
    airframeMaxSpeedMs: { kind: "published", url: "https://docs.freeflysystems.com/astro/other-user-manuals/specs-and-interfaces/performance", quote: "| Position | 15 | 4 | 3 |" },
    climbRateFtS: { kind: "published", url: "https://docs.freeflysystems.com/astro/other-user-manuals/specs-and-interfaces/performance", quote: "| Position | 15 | 4 | 3 |", note: "4 m/s = 13.1 ft/s (position mode)." },
    descentRateFtS: { kind: "published", url: "https://docs.freeflysystems.com/astro/other-user-manuals/specs-and-interfaces/performance", quote: "| Position | 15 | 4 | 3 |", note: "3 m/s = 9.8 ft/s (position mode)." },
    turnRateDegS: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    accelMs2: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    windToleranceMs: { kind: "modelled", note: "No Astro Max wind rating is published; the original Astro handbook cautions that winds greater than 8-10 m/s can be dangerous. Model value." },
    gustToleranceMs: { kind: "modelled", note: "No gust rating is published (see wind). Model value." },
    enduranceMin: { kind: "published", url: "https://store.freeflysystems.com/products/astro-max", quote: "31 minutes with LR1 Payload", note: "Modelling choice among published configurations: the LR1 mapping-payload figure, matching the catalog role (Mapping / heavy payload) and the scenarios that call the Astro the mapping aircraft. No-payload figures: 39 min (spec sheet) / up to 43 min (store). massKg is the no-payload empty weight." },
    operatingTempC: { kind: "published", url: "https://freeflysystems.com/astro/specs", quote: "Operating Temperatures: -20 to 50 C" },
    ipRating: { kind: "published", url: "https://freeflysystems.com/astro/specs", quote: "Ingress Protection: Tested to IP43" },
    battery: { kind: "published", url: "https://freeflysystems.com/astro/specs", quote: "Capacity (SL8-Air): 157Wh · Nominal Battery Voltage: 21.6V · Cells: 6S", note: "Two SL8-Air packs of 157 Wh each fly together: 314 Wh total." },
  },
  brinc_lemur_2: {
    massKg: { kind: "published", url: "https://brincdrones.com/lemur-2/specifications/", quote: "Takeoff Weight 3.3 lbs / 1.5 kg" },
    maxSpeedMs: { kind: "modelled", note: "Interior-operations speed. BRINC publishes only the 48 mph top speed; its slower near-obstacle setting has no published number. Model value." },
    airframeMaxSpeedMs: { kind: "published", url: "https://brincdrones.com/lemur-2/specifications/", quote: "Max Speed 48 mph", note: "48 mph = 21.46 m/s." },
    climbRateFtS: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    descentRateFtS: { kind: "unpublished", note: "Not published; the model descends at the climb rate." },
    turnRateDegS: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    accelMs2: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    windToleranceMs: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    gustToleranceMs: { kind: "modelled", note: "Not published by the manufacturer; model value." },
    enduranceMin: { kind: "published", url: "https://brincdrones.com/lemur-2/specifications/", quote: "Max Flight Time 20 minutes", note: "No flight condition stated." },
    operatingTempC: { kind: "published", url: "https://brincdrones.com/lemur-2/specifications/", quote: "- 4°F to 113°F / -20°C to 45°C" },
    ipRating: { kind: "published", url: "https://brincdrones.com/lemur-2/", quote: "Designed and tested at BRINC’s HQ in Seattle, LEMUR 2 meets IP24 guidelines based on internal testing." },
    battery: { kind: "published", url: "https://brincdrones.com/lemur-2/specifications/", quote: "Capacity 97.2 Wh · Voltage 10.8V Nominal / 12.6V Maximum", note: "Cell count not published." },
  },
}
