import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { buildMissionStatusFeed } from '@/sim/mission/dispatchFeed'
import { buildInvestorDemoChapters } from '@/sim/demo/demoScript'
import type { DispatchTimelineCategory } from '@/types'

const PRIORITY_LABEL: Record<string, string> = {
  routine: 'ROUTINE',
  advisory: 'ADVISORY',
  urgent: 'URGENT',
  critical: 'CRITICAL',
}

const CATEGORY_LABEL: Record<DispatchTimelineCategory, string> = {
  dispatch: 'DISPATCH',
  field_unit: 'FIELD UNIT',
  operator_task: 'OPERATOR TASK',
  agency_update: 'AGENCY UPDATE',
  safety: 'SAFETY',
}

export function MissionStatusFeed() {
  const { scenario, elapsedSec, events, drones, thermalContacts, routeSuggestions, replaySession, investorDemo } = useDroneStore(
    useShallow((s) => ({
      scenario: s.scenario, elapsedSec: s.elapsedSec, events: s.events, drones: s.drones,
      thermalContacts: s.thermalContacts, routeSuggestions: s.routeSuggestions,
      replaySession: s.replaySession, investorDemo: s.investorDemo,
    })),
  )
  const feed = useMemo(
    () => buildMissionStatusFeed({ scenario, elapsedSec, events, drones, thermalDetections: thermalContacts }),
    [scenario, elapsedSec, events, drones, thermalContacts],
  )
  const demoChapters = useMemo(
    () => buildInvestorDemoChapters({
      scenario,
      elapsedSec,
      events,
      routeSuggestionCount: routeSuggestions.length,
      replayAvailable: Boolean(replaySession),
    }),
    [scenario, elapsedSec, events, routeSuggestions.length, replaySession],
  )

  if (!scenario?.missionBrief) return null

  const brief = scenario.missionBrief

  return (
    <section className="mission-status-feed" aria-label="Mission brief and dispatch feed" data-testid="mission-status-feed">
      <div className="mission-brief-row">
        <div>
          <div className="mission-feed-label">{brief.agencies.join(' / ')}</div>
          <div className="mission-feed-title">{scenario.name}</div>
        </div>
        <div className="mission-feed-objective">{brief.primaryObjective}</div>
      </div>
      <div className="mission-feed-intent">{brief.commandIntent}</div>
      {investorDemo.enabled && (
        <div className="investor-demo-strip" data-testid="investor-demo-strip">
          {demoChapters.map((chapter) => (
            <div
              key={chapter.id}
              className={`investor-demo-step demo-step-${chapter.status}${investorDemo.currentChapterId === chapter.id ? ' demo-step-current' : ''}`}
              title={chapter.operatorCue}
            >
              <span>{chapter.title}</span>
              <small>{chapter.successSignal}</small>
            </div>
          ))}
        </div>
      )}
      <div className="dispatch-feed-list">
        {feed.map((entry) => (
          <article
            key={entry.id}
            className={`dispatch-entry dispatch-${entry.priority} dispatch-category-${entry.category}`}
            data-category={entry.category}
          >
            <div className="dispatch-meta">
              <span>{formatTime(entry.timeSec)}</span>
              <span>{entry.source}</span>
              <span>{CATEGORY_LABEL[entry.category]}</span>
              <span>{PRIORITY_LABEL[entry.priority]}</span>
            </div>
            <div className="dispatch-message">{entry.message}</div>
          </article>
        ))}
      </div>
    </section>
  )
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60).toString().padStart(2, '0')
  return `T+${m}:${s}`
}
