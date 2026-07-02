import type { DemoChapter, EventType, ScenarioConfig } from '@/types'

interface BuildInvestorDemoChaptersInput {
  scenario: ScenarioConfig | null
  elapsedSec: number
  events: Array<{ eventType: EventType | string }>
  routeSuggestionCount: number
  replayAvailable: boolean
}

export function buildInvestorDemoChapters(input: BuildInvestorDemoChaptersInput): DemoChapter[] {
  const eventTypes = new Set(input.events.map((event) => event.eventType))
  const hasMissionProgress = input.elapsedSec > 0 || eventTypes.has('mission_start')
  const hasOperatorRetask = eventTypes.has('operator_command') || input.routeSuggestionCount > 0
  const hasDetection = eventTypes.has('thermal_detection')
  const hasRecovery = eventTypes.has('mission_complete')
    || eventTypes.has('route_complete')
    || eventTypes.has('drone_recovered')
    || eventTypes.has('rtb_triggered')

  const complete = {
    brief: Boolean(input.scenario),
    launch: hasMissionProgress || hasOperatorRetask,
    retask: hasOperatorRetask,
    detection: hasDetection,
    recovery: hasRecovery,
    review: input.replayAvailable,
  }

  const activeId = [
    ['mission-brief', complete.brief],
    ['launch-and-edit', complete.launch],
    ['live-retask', complete.retask],
    ['ai-detection', complete.detection],
    ['safe-recovery', complete.recovery],
    ['after-action', complete.review],
  ].find(([, done]) => !done)?.[0] as string | undefined

  return [
    {
      id: 'mission-brief',
      phase: 'brief',
      title: 'Mission Brief',
      operatorCue: input.scenario?.missionBrief?.primaryObjective ?? 'Load a scenario and brief the mission.',
      successSignal: 'Scenario, agencies, command intent, and constraints are visible.',
      status: chapterStatus('mission-brief', complete.brief, activeId),
    },
    {
      id: 'launch-and-edit',
      phase: 'launch',
      title: 'Launch And Editable Routes',
      operatorCue: 'Open launch planning, select a drone, and show draggable route markers.',
      successSignal: 'Fleet launches from assigned sites and route edits persist through validation.',
      status: chapterStatus('launch-and-edit', complete.launch, activeId),
    },
    {
      id: 'live-retask',
      phase: 'retask',
      title: 'Live Retask',
      operatorCue: 'Generate a route suggestion or issue a deep-scan/street-sweep command.',
      successSignal: 'Operator command is logged and route suggestions remain approval based.',
      status: chapterStatus('live-retask', complete.retask, activeId),
    },
    {
      id: 'ai-detection',
      phase: 'detection',
      title: 'AI Detection Cue',
      operatorCue: 'Switch to IR and select a thermal contact card.',
      successSignal: 'Detection confidence, evidence, and dispatch action are visible.',
      status: chapterStatus('ai-detection', complete.detection, activeId),
    },
    {
      id: 'safe-recovery',
      phase: 'recovery',
      title: 'Safe Recovery',
      operatorCue: 'Show RTB, recharge, ground unit, or recovery-team behavior.',
      successSignal: 'Recovery actions preserve route safety, battery reserve, and chain of custody.',
      status: chapterStatus('safe-recovery', complete.recovery, activeId),
    },
    {
      id: 'after-action',
      phase: 'review',
      title: 'After Action Package',
      operatorCue: 'Stop the mission and open replay/report export.',
      successSignal: 'Replay, KPIs, compliance, UTM, and evidence export are report ready.',
      status: chapterStatus('after-action', complete.review, activeId),
    },
  ]
}

function chapterStatus(id: string, done: boolean, activeId: string | undefined): DemoChapter['status'] {
  if (done) return 'complete'
  return id === activeId ? 'active' : 'pending'
}
