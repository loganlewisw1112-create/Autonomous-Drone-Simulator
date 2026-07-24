import { describe, expect, it } from 'vitest'
import { INCIDENT_MISSION_COUNT, INCIDENT_SCENARIOS } from '@/scenarios/catalog'

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
    expect(INCIDENT_SCENARIOS).toHaveLength(INCIDENT_MISSION_COUNT)

    for (const scenario of INCIDENT_SCENARIOS) {
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
    for (const scenario of INCIDENT_SCENARIOS) {
      for (let i = 0; i < scenario.droneCount; i++) {
        const id = droneId(i)
        const launchId = scenario.defaultLaunchAssignments?.[id]
        const recoveryId = scenario.defaultRecoveryAssignments?.[id]
        const launch = launchId ? scenario.launchSites?.[launchId] : undefined
        const recovery = recoveryId ? scenario.recoverySites?.[recoveryId] : undefined

        expect(launchId, `${scenario.id}/${id} launch assignment`).toBeTruthy()
        expect(recoveryId, `${scenario.id}/${id} recovery assignment`).toBeTruthy()
        expect(launch?.id, `${scenario.id}/${id} stable launch id`).toBe(launchId)
        expect(recovery?.id, `${scenario.id}/${id} stable recovery id`).toBe(recoveryId)
        expect(launch?.exposure, `${scenario.id}/${id} launch exposure`).toMatch(/^(sheltered|semi|exposed)$/)
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

  it('gives every mobile catalog site a bounded relocation radius and setup time', () => {
    const mobileSites = INCIDENT_SCENARIOS.flatMap((scenario) => [
      ...Object.values(scenario.launchSites ?? {}),
      ...Object.values(scenario.recoverySites ?? {}),
    ]).filter((site) => site.mobile)

    expect(mobileSites.length).toBeGreaterThan(0)
    for (const site of mobileSites) {
      expect(site.repositionRadiusM, site.id).toBeGreaterThan(0)
      expect(site.repositionTimeSec, site.id).toBeGreaterThan(0)
    }
  })

  it('keeps city scenario launch sites on named rooftops or command units, never generic water points', () => {
    const cityScenarios = INCIDENT_SCENARIOS.filter((scenario) => isCityScenario(scenario.name, scenario.description))
    expect(cityScenarios.length).toBeGreaterThan(0)

    for (const scenario of cityScenarios) {
      for (let i = 0; i < scenario.droneCount; i++) {
        const id = droneId(i)
        const launchId = scenario.defaultLaunchAssignments?.[id]
        const launch = launchId ? scenario.launchSites?.[launchId] : undefined
        expect(launch, `${scenario.id}/${id}`).toBeTruthy()
        if (!launch) continue

        expect(CITY_LAUNCH_KINDS.has(launch.kind), `${scenario.id}/${id} ${launch.kind}`).toBe(true)
        expect(launch.label, `${scenario.id}/${id} launch label`).not.toMatch(GENERIC_OR_WATER_LABEL)
        expect(launch.surfaceNote, `${scenario.id}/${id} launch surface`).not.toMatch(GENERIC_OR_WATER_LABEL)
      }
    }
  })

  it('models long-range maritime SAR with relay progression', () => {
    const scenario = INCIDENT_SCENARIOS.find((item) => item.id === 'train_uscg_maritime_sar')
    expect(scenario).toBeTruthy()
    if (!scenario) return

    expect(scenario.maxSorties).toBe(2)
    const relay = scenario.perDroneWaypoints?.['uav-05']
    expect(relay?.length).toBeGreaterThan(1)
    expect(relay?.every((wp) => (wp.dwellTimeSec ?? 0) <= 25)).toBe(true)
  })
})


