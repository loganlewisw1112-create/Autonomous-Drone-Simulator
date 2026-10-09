import { buildReportHtml, reportHtmlFilename } from '@/sim/demo/reportHtml'
import { buildReportViewModel, type ReportSource, type ReportViewModel } from '@/sim/demo/reportViewModel'

/**
 * Builds the offline HTML report for a view model and hands it to the browser as a file download
 * (small Blob + anchor helper). Browser-only: the pure builder lives in reportHtml.ts.
 *
 * Load this module lazily from anything on the startup path:
 *   const { downloadReportHtml } = await import('@/components/debrief/reportDownload')
 */
export function downloadReportHtml(vm: ReportViewModel): void {
  const url = URL.createObjectURL(new Blob([buildReportHtml(vm)], { type: 'text/html;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = reportHtmlFilename(vm)
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  window.setTimeout(() => {
    URL.revokeObjectURL(url)
    anchor.remove()
  }, 1000)
}

/** Same download, starting from a ReportSource (for callers that do not hold a view model yet). */
export function downloadReportHtmlFromSource(source: ReportSource): void {
  downloadReportHtml(buildReportViewModel(source))
}
