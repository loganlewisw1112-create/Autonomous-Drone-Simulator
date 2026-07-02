import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'

const CITY_LAUNCH_KINDS = new Set(['rooftop', 'police_rooftop', 'mobile_command'])
const GENERIC_OR_WATER_LABEL = /\b(generic|default|ocean|open water|bay water|bridge[- ]adjacent|unknown)\b/i

function droneId(index: number): string {
  return `uav-${String(index + 1).padStart(2, '0')}`
}

function isCityScenario(scenarioName: string, description: string): boolean {
  return /\b(SFPD|OPD|CHP|BART PD|LAPD|NYPD|ATF|DMH|Oakland|Hollywood|Times Square|Seattle|SF|city|urban|hotel|BART)\b/i
    .test(`${scenarioName} ${description}`)
}

describe('multiagency scenario metadata', () => {
  it('upgrades every scenario with mission brief, dispatch timeline, route briefs, and operational features', () => {
    expect(ALL_SCENARIOS).toHaveLength(21)

    for (const scenario of ALL_SCENARIOS) {
      expect(scenario.missionBrief?.agencies.length, scenario.id).toBeGreaterThan(0)
      expect(scenario.missionBrief?.commandIntent, scenario.id).toContain('SIMULATION ONLY')
      expect(scenario.dispatchTimeline?.length, scenario.id).toBeGreaterThanOrEqual(3)
      expect(scenario.operationalFeatures?.length, scenario.id).toBeGreaterThanOrEqual(3)

      for (let i = 1; i <= scenario.droneCount; i++) {
        const id = `uav-${String(i).padStart(2, '0')}`
        expect(scenario.droneRouteBriefs?.[id]?.role, `${scenario.id}/${id}`).toBeTruthy()
        expect(scenario.droneRouteBriefs?.[id]?.recoveryPlan, `${scenario.id}/${id}`).toContain('RTB')
      }
    }
  })

  it('requires every scenario drone to declare explicit launch and recovery sites', () => {
    for (const scenario of ALL_SCENARIOS) {
      for (let i = 0; i < scenario.droneCount; i++) {
        const id = droneId(i)
        const launch = scenario.launchSites?.[id]
        const recovery = scenario.recoverySites?.[id]

        expect(launch?.label, `${scenario.id}/${id} launch label`).toBeTruthy()
        expect(launch?.agency, `${scenario.id}/${id} launch agency`).toBeTruthy()
        expect(launch?.surfaceNote, `${scenario.id}/${id} launch surface`).toBeTruthy()
        expect(launch?.position.lat, `${scenario.id}/${id} launch latitude`).toBeTypeOf('number')
        expect(launch?.position.lng, `${scenario.id}/${id} launch longitude`).toBeTypeOf('number')

        expect(recovery?.label, `${scenario.id}/${id} recovery label`).toBeTruthy()
        expect(recovery?.agency, `${scenario.id}/${id} recovery agency`).toBeTruthy()
        expect(recovery?.surfaceNote, `${scenario.id}/${id} recovery surface`).toBeTruthy()
        expect(recovery?.position.lat, `${scenario.id}/${id} recovery latitude`).toBeTypeOf('number')
        expect(recovery?.position.lng, `${scenario.id}/${id} recovery longitude`).toBeTypeOf('number')
      }
    }
  })

  it('keeps city scenario launch sites on named rooftops or command units, never generic water points', () => {
    const cityScenarios = ALL_SCENARIOS.filter((scenario) => isCityScenario(scenario.name, scenario.description))
    expect(cityScenarios.length).toBeGreaterThan(0)

    for (const scenario of cityScenarios) {
      for (let i = 0; i < scenario.droneCount; i++) {
        const id = droneId(i)
        const launch = scenario.launchSites?.[id]
        expect(launch, `${scenario.id}/${id}`).toBeTruthy()
        if (!launch) continue

        expect(CITY_LAUNCH_KINDS.has(launch.kind), `${scenario.id}/${id} ${launch.kind}`).toBe(true)
        expect(launch.label, `${scenario.id}/${id} launch label`).not.toMatch(GENERIC_OR_WATER_LABEL)
        expect(launch.surfaceNote, `${scenario.id}/${id} launch surface`).not.toMatch(GENERIC_OR_WATER_LABEL)
      }
    }
  })

  it('stages SF pursuit UAV-03, UAV-04, and UAV-05 from simulated Jack London Square rooftops', () => {
    const scenario = ALL_SCENARIOS.find((item) => item.id === 'extreme_multiagency_sf_pursuit')
    expect(scenario).toBeTruthy()
    if (!scenario) return

    for (const id of ['uav-03', 'uav-04', 'uav-05']) {
      const launch = scenario.launchSites?.[id]
      expect(launch, id).toBeTruthy()
      if (!launch) continue
      expect(launch.label, id).toContain('Jack London Square')
      expect(launch.surfaceNote, id).toMatch(/simulated rooftop/i)
      expect(['rooftop', 'police_rooftop']).toContain(launch.kind)
      expect(launch.position.lat, id).toBeGreaterThan(37.793)
      expect(launch.position.lat, id).toBeLessThan(37.798)
      expect(launch.position.lng, id).toBeGreaterThan(-122.279)
      expect(launch.position.lng, id).toBeLessThan(-122.273)
    }
  })

  it('models Rio Grande as a long-range battery and staged US-83 recharge operation', () => {
    const scenario = ALL_SCENARIOS.find((item) => item.id === 'extreme_cbp_rio_grande_longrange')
    expect(scenario).toBeTruthy()
    if (!scenario) return

    expect(scenario.batteryProfile?.label).toBe('Long-Range Li-ion Endurance Kit')
    expect(scenario.batteryProfile?.reservePct).toBe(25)
    expect(scenario.rechargeStations?.map((station) => station.id)).toEqual([
      'rg-rs-falcon-us83',
      'rg-rs-roma-us83',
      'rg-rs-rgc-us83',
      'rg-rs-lajoya-us83',
      'rg-rs-mission-us83',
    ])

    const rechargeFeatures = scenario.operationalFeatures?.filter((feature) => feature.type === 'recharge_station') ?? []
    expect(rechargeFeatures).toHaveLength(5)

    for (let i = 1; i <= scenario.droneCount; i++) {
      const id = `uav-${String(i).padStart(2, '0')}`
      expect(scenario.perDroneRechargeStations?.[id], id).toHaveLength(5)
      expect(scenario.droneRouteBriefs?.[id]?.recoveryPlan, id).toContain('US-83')
    }
  })
})


