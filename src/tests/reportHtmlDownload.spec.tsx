// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AfterActionReport } from '@/components/debrief/AfterActionReport'
import { RunDetailView } from '@/components/rundetail/RunDetailView'
import { downloadReportHtml } from '@/components/debrief/reportDownload'
import { buildReportViewModel } from '@/sim/demo/reportViewModel'
import { reportSourceFromLive } from '@/sim/demo/reportAdapters'
import { makeFixture } from './reportFixtures'

const BUTTON = 'Download report (HTML)'

interface Captured {
  blobs: Blob[]
  downloads: string[]
  revoked: string[]
}

let captured: Captured

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

beforeEach(() => {
  captured = { blobs: [], downloads: [], revoked: [] }
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      captured.blobs.push(blob)
      return `blob:test/${captured.blobs.length}`
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((url: string) => { captured.revoked.push(url) }),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    captured.downloads.push(this.download)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('downloadReportHtml', () => {
  it('hands the browser one text/html Blob named from the sanitized scenario id', async () => {
    const vm = buildReportViewModel(reportSourceFromLive(makeFixture().live)!)
    downloadReportHtml(vm)
    expect(captured.downloads).toEqual([`${vm.summary.scenarioId.replace(/[^A-Za-z0-9_-]+/g, '-')}-report.html`])
    expect(captured.blobs).toHaveLength(1)
    expect(captured.blobs[0].type).toBe('text/html;charset=utf-8')
    const html = await readBlob(captured.blobs[0])
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain(vm.summary.title)
  })

  it('removes its anchor and revokes the object url shortly afterwards', async () => {
    const vm = buildReportViewModel(reportSourceFromLive(makeFixture().live)!)
    downloadReportHtml(vm)
    await waitFor(() => expect(captured.revoked).toEqual(['blob:test/1']), { timeout: 3000 })
    expect(document.querySelectorAll('a[download]').length).toBe(0)
  })
})

describe('Download report (HTML) in <AfterActionReport />', () => {
  it('dialog mode: one button, and clicking it downloads the same report that is on screen', async () => {
    const source = reportSourceFromLive(makeFixture().live)!
    render(<AfterActionReport source={source} />)
    const buttons = screen.getAllByRole('button', { name: BUTTON })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAttribute('data-testid', 'aar-download-html')
    fireEvent.click(buttons[0])
    expect(captured.downloads).toHaveLength(1)
    expect(captured.downloads[0]).toMatch(/^[A-Za-z0-9_-]+-report\.html$/)
    const html = await readBlob(captured.blobs[0])
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelectorAll('script').length).toBe(0)
    expect(doc.body.textContent).toContain(source.package.missionReport.title)
    expect(doc.body.textContent).toMatch(/Event chain: VERIFIED/)
  })

  it('inline mode with the raw-data row: the button sits in that row; without the row there is no button', () => {
    const source = reportSourceFromLive(makeFixture().live)!
    const { unmount } = render(<AfterActionReport source={source} mode="inline" />)
    const button = screen.getByRole('button', { name: BUTTON })
    expect(screen.getByTestId('aar-exports').contains(button)).toBe(true)
    unmount()
    render(<AfterActionReport source={source} mode="inline" showExports={false} />)
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull()
  })

  it('a tampered chain downloads a report that says FAIL', async () => {
    const fx = makeFixture()
    const tampered = fx.events.map((e, i) => (i === 3 ? { ...e, payload: { x: 1 } } : e))
    const source = reportSourceFromLive({ ...fx.live, events: tampered, replaySession: { ...fx.session, events: tampered } })!
    render(<AfterActionReport source={source} />)
    fireEvent.click(screen.getByRole('button', { name: BUTTON }))
    const html = await readBlob(captured.blobs[0])
    expect(new DOMParser().parseFromString(html, 'text/html').querySelector('#chain-status')?.textContent).toMatch(/FAIL/)
  })
})

describe('Download report (HTML) in the RunDetailView header', () => {
  it('is enabled with full detail, downloads a report built from the stored run, and works from any tab', async () => {
    const fx = makeFixture()
    render(<RunDetailView summary={fx.summary} detail={fx.detail} onBack={() => undefined} />)
    const button = screen.getByRole('button', { name: BUTTON })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('data-testid', 'rundetail-download-html')
    expect(button.closest('.rundetail-header')).not.toBeNull()
    fireEvent.click(button)
    await waitFor(() => expect(captured.downloads).toHaveLength(1))
    expect(captured.downloads[0]).toBe(`${fx.summary.scenarioId.replace(/[^A-Za-z0-9_-]+/g, '-')}-report.html`)
    const html = await readBlob(captured.blobs[0])
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelectorAll('script').length).toBe(0)
    expect(doc.body.textContent).toContain(fx.detail.report.missionReport.title)
    expect(doc.body.textContent).toMatch(/Event chain: VERIFIED/)
  })

  it('is disabled when the run has no full detail', () => {
    const fx = makeFixture()
    render(<RunDetailView summary={fx.summary} detail={null} onBack={() => undefined} />)
    expect(screen.getByRole('button', { name: BUTTON })).toBeDisabled()
  })

  it('reports a failure instead of staying silent when the report cannot be prepared', async () => {
    const fx = makeFixture()
    const broken = { ...fx.detail, report: undefined } as unknown as typeof fx.detail
    render(<RunDetailView summary={fx.summary} detail={broken} onBack={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: BUTTON }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not/i)
    expect(captured.downloads).toHaveLength(0)
  })
})

describe('keeping the report code out of the startup graph', () => {
  it('RunDetailView loads the HTML export on click (dynamic import), never statically', () => {
    const src = readFileSync('src/components/rundetail/RunDetailView.tsx', 'utf8')
    expect(src).not.toMatch(/^import[^\n]*(reportHtml|reportDownload)/m)
    expect(src).toMatch(/import\(\s*['"]@\/components\/debrief\/reportDownload['"]\s*\)/)
  })

  it('App and MobileShell never import the report modules directly', () => {
    for (const file of ['src/App.tsx', 'src/components/mobile/MobileShell.tsx']) {
      const src = readFileSync(file, 'utf8')
      expect(src, file).not.toMatch(/reportHtml|reportDownload/)
    }
  })

  it('report UI files contain no classroom import and no text below 12px', () => {
    for (const file of ['src/sim/demo/reportHtml.ts', 'src/components/debrief/reportDownload.ts']) {
      const src = readFileSync(file, 'utf8')
      expect(src, file).not.toMatch(/classroom/i)
      expect(src, file).not.toMatch(/fontSize:\s*(?:\d|1[01])\b/)
    }
  })
})
