// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { ControlBar } from '@/components/ControlBar'
import { useDroneStore } from '@/store/droneStore'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { observedWeatherFor } from '@/scenarios/observedWeather'
import { prepareScenarioTerrain } from '@/scenarios/terrainFixtures'
import { initFleet } from '@/sim/SimulationLoop'
import { buildWeatherState } from '@/sim/weather/weatherEngine'
import { seededLaunchPlanFromScenario } from '@/sim/mission/launchPlanGeometry'
import { weatherGateForSite } from '@/sim/mission/launchDoctrine'
import type { ScenarioConfig, WeatherVariantState } from '@/types'

// Seeded launch plans must honour the launch-doctrine weather gate (demo blocker c11).
const GROUNDED_BY_WEATHER = ['hist_marshall_fire_2021', 'train_uscg_maritime_sar']
const seeded = ALL_SCENARIOS.filter((s) => s.defaultLaunchAssignments)
const byId = (id: string): ScenarioConfig => {
  const found = ALL_SCENARIOS.find((s) => s.id === id)
  if (!found) throw new Error(`missing scenario ${id}`)
  return found
}
const defaultWeather = (s: ScenarioConfig): WeatherVariantState => {
  const variant = useDroneStore.getState().scenarioVariant
  return buildWeatherState(s.weatherProfile!, variant, observedWeatherFor(s.id))
}

describe('seeded launch plans honour the doctrine weather gate', () => {
  it.each(GROUNDED_BY_WEATHER)('%s seeds a NOT-ready plan with every bay weather-closed and a reason', (id) => {
    const scenario = byId(id)
    const plan = seededLaunchPlanFromScenario(scenario, defaultWeather(scenario))
    expect(plan).not.toBeNull()
    expect(plan!.readyToLaunch).toBe(false)
    expect(plan!.blockers.length).toBeGreaterThan(0)
    const assignedSites = new Set(Object.values(plan!.assignments))
    const statuses = plan!.bayStatuses.filter((b) => assignedSites.has(b.siteId))
    expect(statuses.length).toBe(assignedSites.size)
    for (const bay of statuses) {
      expect(bay.weatherClosed).toBe(true)
      expect(bay.closureReason).toBeTruthy()
    }
  })

  it.each(seeded.filter((s) => !GROUNDED_BY_WEATHER.includes(s.id)).map((s) => s.id))(
    '%s stays ready to launch under its default weather',
    (id) => {
      const scenario = byId(id)
      const weather = defaultWeather(scenario)
      const plan = seededLaunchPlanFromScenario(scenario, weather)
      expect(plan!.readyToLaunch).toBe(true)
      expect(plan!.blockers).toEqual([])
      for (const siteId of new Set(Object.values(plan!.assignments))) {
        const site = scenario.launchSites?.[siteId]
        if (site) expect(weatherGateForSite(site, weather)).toBeNull()
      }
    },
  )
})

describe('Marshall Fire START shows the weather reason', () => {
  beforeEach(async () => {
    const scenario = byId('hist_marshall_fire_2021')
    await prepareScenarioTerrain(scenario)
    const store = useDroneStore.getState()
    useDroneStore.setState({ launchPlan: null })
    store.setScenario(scenario)
    store.setWeatherState(defaultWeather(scenario))
    initFleet()
    useDroneStore.setState({ operatorRole: 'pic' })
  })
  afterEach(() => cleanup())

  it('disables START and names the closed bay and the weather', () => {
    render(<ControlBar />)
    const start = screen.getByRole('button', { name: '▶ START' })
    expect(start).toBeDisabled()
    expect(start.getAttribute('title')).toMatch(/weather/i)
    const reason = screen.getByTestId('launch-weather-blocker')
    expect(reason.textContent).toMatch(/closed/i)
    expect(reason.textContent).toMatch(/gust/i)
    expect(reason.textContent).not.toMatch(/launch-primary/) // the site label, not the internal pool id
    expect(screen.getByText('⚠ BAY PLAN REQUIRED')).toBeInTheDocument()
  })

  it('re-weathers a seeded plan on a variant change, and back', () => {
    const scenario = byId('hist_marshall_fire_2021')
    const calm = { ...defaultWeather(scenario), gustKts: 8, ceilingFt: 5000, activeHazards: [] as WeatherVariantState['activeHazards'] }
    act(() => useDroneStore.getState().setWeatherState(calm))
    expect(useDroneStore.getState().launchPlan?.readyToLaunch).toBe(true)
    act(() => useDroneStore.getState().setWeatherState({ ...calm, gustKts: 56 }))
    expect(useDroneStore.getState().launchPlan?.readyToLaunch).toBe(false)
    act(() => useDroneStore.getState().setWeatherState(calm))
    expect(useDroneStore.getState().launchPlan?.readyToLaunch).toBe(true)
  })

  it('does not re-weather an operator-confirmed plan', () => {
    const confirmed = { assignments: {}, bayStatuses: [], readyToLaunch: true, blockers: [], assignmentDetails: {} }
    useDroneStore.setState({ launchPlan: confirmed })
    act(() => useDroneStore.getState().setWeatherState({ ...defaultWeather(byId('hist_marshall_fire_2021')), gustKts: 70 }))
    expect(useDroneStore.getState().launchPlan).toBe(confirmed)
  })
})
