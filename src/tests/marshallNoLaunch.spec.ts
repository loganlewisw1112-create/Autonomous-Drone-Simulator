import { describe, expect, it } from 'vitest'
import { getScenarioById } from '@/scenarios/registry'
import { observedWeatherFor } from '@/scenarios/observedWeather'
import { buildWeatherState } from '@/sim/weather/weatherEngine'
import { buildAutoLaunchDoctrinePlan } from '@/sim/mission/launchDoctrine'
import { useDroneStore } from '@/store/droneStore'
import type { MissionBrief } from '@/types'

const MARSHALL = 'hist_marshall_fire_2021'

function briefOf(id: string): MissionBrief {
  const brief = getScenarioById(id)?.config.missionBrief
  expect(brief, id).toBeTruthy()
  return brief as MissionBrief
}

describe('Marshall Fire no-launch drill', () => {
  it('closes every launch bay on the recorded peak-wind day, so the fleet cannot launch', () => {
    const scenario = getScenarioById(MARSHALL)?.config
    expect(scenario).toBeTruthy()
    if (!scenario?.weatherProfile) throw new Error('marshall has no weather profile')
    const weather = buildWeatherState(
      scenario.weatherProfile,
      useDroneStore.getState().scenarioVariant,
      observedWeatherFor(MARSHALL),
    )
    const plan = buildAutoLaunchDoctrinePlan(scenario, weather, {})
    expect(plan.bayStatuses.length).toBeGreaterThan(0)
    for (const bay of plan.bayStatuses) {
      expect(bay.weatherClosed, bay.siteId).toBe(true)
    }
    expect(plan.readyToLaunch).toBe(false)
  })

  it('has an authored brief that teaches the no-launch decision, not a spotfire map', () => {
    const brief = briefOf(MARSHALL)
    const text = JSON.stringify(brief)
    expect(text).not.toMatch(/spotfire/i)
    expect(brief.commandIntent).toContain('SIMULATION ONLY')
    expect(brief.agencies.length).toBeGreaterThan(0)
    expect(brief.primaryObjective).toMatch(/ground|hold|no-launch|not launch/i)
    const timeline = getScenarioById(MARSHALL)?.config.dispatchTimeline ?? []
    expect(timeline.length).toBeGreaterThanOrEqual(3)
    expect(timeline.some((e) => /weather-closed|stays on the ground/i.test(e.message))).toBe(true)
  })

  it('leaves the other wildfire briefs unchanged', () => {
    for (const id of ['train_wildfire_flank', 'hist_camp_fire_paradise_2018']) {
      const config = getScenarioById(id)?.config
      expect(config, id).toBeTruthy()
      // Derived (not authored) briefs still carry the generic wildfire objective.
      expect(config?.missionBrief?.primaryObjective, id).toBe(
        'Map fire edge, identify spotfires, and maintain standoff from the active column.',
      )
    }
  })
})
