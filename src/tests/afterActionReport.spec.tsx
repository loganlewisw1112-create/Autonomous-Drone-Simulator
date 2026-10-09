// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AfterActionReport } from '@/components/debrief/AfterActionReport'
import { MissionCompleteChip } from '@/components/debrief/MissionCompleteChip'
import { ReplayPanel } from '@/components/ReplayPanel'
import { RunDetailView } from '@/components/rundetail/RunDetailView'
import { reportSourceFromLive, reportSourceFromStoredRun } from '@/sim/demo/reportAdapters'
import { useDroneStore } from '@/store/droneStore'
import { makeFixture, type Fixture } from './reportFixtures'

const SECTIONS = ['summary', 'timeline', 'map', 'scores', 'chain']

function sectionOrder(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('[data-section]')).map((el) => el.getAttribute('data-section') ?? '')
}

function seedStore(fx: Fixture) {
  useDroneStore.setState({
    scenario: fx.live.scenario,
    scenarioVariant: fx.live.scenarioVariant,
    drones: fx.drones,
    metrics: fx.live.metrics,
    thermalContacts: fx.contacts,
    groundUnits: [],
    recoveryTeams: [],
    events: fx.events,
    elapsedSec: 70,
    positionHistory: fx.history,
    replaySession: fx.session,
    replayIndex: 0,
    lifecycle: 'completed',
    ui: { ...useDroneStore.getState().ui, isRunning: false, isReplayMode: false },
  })
}

afterEach(() => cleanup())

describe('<AfterActionReport />', () => {
  it('renders all 5 sections in order (inline mode)', () => {
    const source = reportSourceFromLive(makeFixture().live)!
    const { container } = render(<AfterActionReport source={source} mode="inline" />)
    expect(sectionOrder(container)).toEqual(SECTIONS)
    expect(screen.getByTestId('aar-map')).toBeInTheDocument()
    expect(screen.getByTestId('aar-chain-status')).toHaveTextContent('Event chain: VERIFIED')
    expect(screen.getByText('UAV-02 down: recovery team dispatched (no road data)')).toBeInTheDocument()
  })

  it('dialog mode portals an accessible overlay, closes on button and Escape, and is not nested in the caller', () => {
    const onClose = vi.fn()
    const source = reportSourceFromLive(makeFixture().live)!
    const { container } = render(<AfterActionReport source={source} onClose={onClose} />)
    expect(container).toBeEmptyDOMElement()
    const dialog = screen.getByRole('dialog', { name: 'Mission report' })
    expect(sectionOrder(dialog)).toEqual(SECTIONS)
    fireEvent.click(screen.getByTestId('aar-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('shows FAIL and the first failing link for a tampered chain', () => {
    const fx = makeFixture()
    const tampered = fx.events.map((e, i) => (i === 3 ? { ...e, payload: { x: 1 } } : e))
    const source = reportSourceFromLive({ ...fx.live, events: tampered, replaySession: { ...fx.session, events: tampered } })!
    render(<AfterActionReport source={source} mode="inline" />)
    expect(screen.getByTestId('aar-chain-status')).toHaveTextContent('FAIL')
    expect(screen.getByTestId('aar-chain-status')).toHaveTextContent('#4')
  })

  it('escapes hostile strings through React (no element is created from scenario, drone or class text)', () => {
    const fx = makeFixture()
    const hostile = '<img src=x onerror=alert(1)>'
    const source = reportSourceFromLive({ ...fx.live, scenario: { ...fx.live.scenario!, name: hostile } })!
    const withDrone = {
      ...source,
      package: { ...source.package, scenarioName: hostile, missionReport: { ...source.package.missionReport, title: hostile } },
      finalDrones: source.finalDrones.map((d) => ({ ...d, label: '"><b>x</b>' })),
    }
    const { container } = render(<AfterActionReport source={withDrone} mode="inline" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain(hostile)
  })

  it('draws supplied vehicle tracks dashed with a legend entry', () => {
    const fx = makeFixture()
    const s = fx.live.scenario!.startPosition
    const source = {
      ...reportSourceFromLive(fx.live)!,
      vehicleTracks: [{ id: 'rt-1', kind: 'recovery' as const, points: [s, { lat: s.lat + 0.01, lng: s.lng + 0.01 }] }],
    }
    const { container } = render(<AfterActionReport source={source} mode="inline" />)
    const dashed = Array.from(container.querySelectorAll('polyline')).find((el) => el.getAttribute('stroke') === '#ff88ff')
    expect(dashed?.getAttribute('stroke-dasharray')).toBeTruthy()
    expect(screen.getByText('Recovery team route')).toBeInTheDocument()
  })

  it('keeps JSON / evidence / KML / GeoJSON as secondary buttons, and can hide them', () => {
    const source = reportSourceFromLive(makeFixture().live)!
    const { unmount } = render(<AfterActionReport source={source} mode="inline" />)
    for (const name of ['JSON', 'EVIDENCE', 'KML', 'GEOJSON']) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    unmount()
    render(<AfterActionReport source={source} mode="inline" showExports={false} />)
    expect(screen.queryByTestId('aar-exports')).toBeNull()
  })

  it('has print CSS and no raw-HTML injection in the component source', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync('src/styles/report.css', 'utf8')
    expect(css).toContain('@media print')
    const tsx = readFileSync('src/components/debrief/AfterActionReport.tsx', 'utf8')
    expect(tsx).not.toContain('dangerouslySetInnerHTML')
  })
})

describe('signed-in history Report tab', () => {
  it('renders the report component instead of <pre> JSON dumps', async () => {
    const fx = makeFixture()
    const { container } = render(<RunDetailView summary={fx.summary} detail={fx.detail} onBack={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(await screen.findByTestId('after-action-report')).toBeInTheDocument()
    expect(sectionOrder(container)).toEqual(SECTIONS)
    expect(container.querySelector('pre')).toBeNull()
  })

  it('says so when the run has no full detail', () => {
    const fx = makeFixture()
    render(<RunDetailView summary={fx.summary} detail={null} onBack={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(screen.getByText('No full report is available for this run.')).toBeInTheDocument()
    expect(reportSourceFromStoredRun(fx.summary, null)).toBeNull()
  })
})

describe('guest path from the live store', () => {
  beforeEach(() => seedStore(makeFixture()))

  it('ReplayPanel VIEW REPORT opens the report, and EXPORT REPORT stays available', async () => {
    render(<ReplayPanel />)
    expect(screen.getByRole('button', { name: 'EXPORT REPORT' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'VIEW REPORT' }))
    const dialog = await screen.findByRole('dialog', { name: 'Mission report' })
    expect(sectionOrder(dialog)).toEqual(SECTIONS)
    fireEvent.click(screen.getByTestId('aar-close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the report reflects the final state even when the replay is scrubbed to frame 0', async () => {
    useDroneStore.getState().setReplayIndex(0)
    render(<ReplayPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'VIEW REPORT' }))
    expect(await screen.findByText('UAV-02 recovered')).toBeInTheDocument()
  })

  it('the phone end chip opens the same report', async () => {
    render(<MissionCompleteChip />)
    fireEvent.click(screen.getByTestId('mission-complete-chip'))
    expect(await screen.findByRole('dialog', { name: 'Mission report' })).toBeInTheDocument()
  })
})
