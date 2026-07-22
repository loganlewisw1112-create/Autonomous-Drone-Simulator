// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  SiteRepositionReview,
  collectTacticalMapSites,
  formatSiteRepositionDelta,
  isSiteRepositionable,
} from '@/components/TacticalMap'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import type { SiteRepositionResult } from '@/sim/mission/siteReposition'
import type { LaunchRecoverySite, ScenarioConfig } from '@/types'

const origin = { lat: 37.77, lng: -122.42 }

function site(
  id: string,
  kind: LaunchRecoverySite['kind'],
  mobile?: boolean,
  position = origin,
): LaunchRecoverySite {
  return {
    id,
    kind,
    mobile,
    label: id.toUpperCase(),
    agency: 'CITY UAS',
    position,
    surfaceNote: 'Test site',
  }
}

function scenario(): ScenarioConfig {
  return {
    ...ALL_SCENARIOS[0],
    launchSites: {
      mobile: site('mobile', 'field_icp'),
      fixed: site('fixed', 'helipad', undefined, { lat: 37.78, lng: -122.43 }),
    },
    recoverySites: {
      mobile: { ...site('mobile', 'field_icp'), isPrimaryRecovery: true },
      locked: site('locked', 'vessel', false, { lat: 37.79, lng: -122.44 }),
    },
  }
}

function preview(patch: Partial<SiteRepositionResult> = {}): SiteRepositionResult {
  const position = { lat: 37.771, lng: -122.421 }
  return {
    ok: true,
    siteId: 'mobile',
    from: origin,
    requestedPosition: position,
    position,
    clamped: false,
    distanceFromOriginM: 120,
    distanceToObjectiveDeltaM: -1_400,
    reserveDeltaPct: 9,
    affectedDrones: ['uav-01', 'uav-02', 'uav-03', 'uav-04'],
    affectedSiteIds: ['mobile'],
    overridePatch: { mobile: position },
    repositionTimeSec: 120,
    blockers: [],
    message: 'Move passes mission safety checks.',
    ...patch,
  }
}

describe('TacticalMap site presentation helpers', () => {
  it('deduplicates a physical launch/recovery site and applies runtime position overrides', () => {
    const sites = collectTacticalMapSites(scenario(), {
      mobile: { lat: 37.775, lng: -122.425 },
    })

    expect(sites).toHaveLength(3)
    expect(sites.find((entry) => entry.id === 'mobile')).toMatchObject({
      role: 'launch_recovery',
      site: { position: { lat: 37.775, lng: -122.425 } },
    })
  })

  it('combines distinct launch and recovery ids that represent the same physical station', () => {
    const config = scenario()
    config.recoverySites = {
      recoveryAlias: { ...site('recovery-alias', 'field_icp'), isPrimaryRecovery: true },
      locked: config.recoverySites?.locked as LaunchRecoverySite,
    }

    const sites = collectTacticalMapSites(config)

    expect(sites).toHaveLength(3)
    expect(sites.find((entry) => entry.id === 'mobile')).toMatchObject({ role: 'launch_recovery' })
    expect(sites.some((entry) => entry.id === 'recovery-alias')).toBe(false)
  })

  it('exposes only mobile stations as repositionable and honors an explicit fixed lock', () => {
    expect(isSiteRepositionable(site('field', 'field_icp'))).toBe(true)
    expect(isSiteRepositionable(site('vessel', 'vessel'))).toBe(true)
    expect(isSiteRepositionable(site('roof', 'police_rooftop'))).toBe(false)
    expect(isSiteRepositionable(site('locked', 'field_icp', false))).toBe(false)
    expect(isSiteRepositionable(site('opt-in', 'helipad', true))).toBe(true)
  })
})

describe('<SiteRepositionReview />', () => {
  it('shows placement guidance with cancel available and confirm gated', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<SiteRepositionReview siteLabel="Field ICP" preview={null} onCancel={onCancel} onConfirm={onConfirm} />)

    expect(screen.getByText(/Tap the map or drag the marker/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CONFIRM MOVE' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'CANCEL' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('renders the mission delta and commits a valid preview', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const result = preview()
    render(<SiteRepositionReview siteLabel="Field ICP" preview={result} onCancel={vi.fn()} onConfirm={onConfirm} />)

    expect(formatSiteRepositionDelta(result)).toBe('-1.4km to sector · +9% reserve · 4 drones replanned')
    expect(screen.getByText('-1.4km to sector · +9% reserve · 4 drones replanned')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'CONFIRM MOVE' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('shows a rejected preview and prevents confirmation', () => {
    render(
      <SiteRepositionReview
        siteLabel="Field ICP"
        preview={preview({ ok: false, blockers: ['active geofence'], message: 'Position enters an active geofence.' })}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByTestId('site-reposition-review')).toHaveAttribute('data-status', 'blocked')
    expect(screen.getByText('Position enters an active geofence.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CONFIRM MOVE' })).toBeDisabled()
  })
})
