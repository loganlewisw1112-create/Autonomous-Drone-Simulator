import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'

// Site labels are operator-facing (launch/recovery panel, START title, weather blocker).
// They must read as a place, never as the internal pool id the catalog keys sites by.
describe('authored launch site labels', () => {
  const seeded = ALL_SCENARIOS.filter((scenario) => scenario.defaultLaunchAssignments)

  it('covers the seeded catalog', () => {
    expect(seeded.length).toBeGreaterThan(0)
  })

  it.each(seeded.map((scenario) => [scenario.id, scenario] as const))('%s labels its sites without internal ids', (_id, scenario) => {
    for (const [siteId, site] of Object.entries(scenario.launchSites ?? {})) {
      expect(site.label.toLowerCase()).not.toContain(siteId.toLowerCase())
      expect(site.label.toLowerCase()).not.toContain(scenario.id.toLowerCase())
      expect(site.label).not.toMatch(/launch-primary/i)
    }
  })
})
