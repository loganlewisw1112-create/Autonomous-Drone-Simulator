import { lazy, Suspense, useCallback, useState } from 'react'
import { useDroneStore } from '@/store/droneStore'
import { reportSourceFromLive } from '@/sim/demo/reportAdapters'
import type { ReportSource } from '@/sim/demo/reportViewModel'

const AfterActionReport = lazy(() => import('@/components/debrief/AfterActionReport').then((m) => ({ default: m.AfterActionReport })))

/**
 * Phone end-of-mission surface: MobileShell mounts this (itself lazily) when lifecycle === 'completed'.
 * The label deliberately avoids the words "after action" because mobileShell.spec queries that text
 * for the Exports sheet button.
 */
export function MissionCompleteChip() {
  const [source, setSource] = useState<ReportSource | null>(null)
  const close = useCallback(() => setSource(null), [])
  return (
    <>
      <button
        type="button"
        className="mobile-complete-chip"
        data-testid="mission-complete-chip"
        onClick={() => setSource(reportSourceFromLive(useDroneStore.getState()))}
      >
        Mission complete · View report
      </button>
      {source && (
        <Suspense fallback={null}>
          <AfterActionReport source={source} onClose={close} />
        </Suspense>
      )}
    </>
  )
}

export default MissionCompleteChip
