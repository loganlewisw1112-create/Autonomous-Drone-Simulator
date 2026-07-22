import { useMemo, useState } from 'react'
import { getScenarioOptions } from '@/scenarios/registry'
import { startClass } from '@/classroom/classroomClient'
import { useClassroomStore } from '@/classroom/classroomStore'
import type { ClassConfig } from '@/classroom/protocol'
import type { ScenarioVariantConfig } from '@/types'

function defaultVariant(seed: number): ScenarioVariantConfig {
  return {
    seed, timeOfDay: 'day', season: 'summer',
    weatherSeverity: 0, commsDegradation: 0, thermalDensity: 0, batteryPressure: 0, terrainDifficulty: 0,
  }
}

// Instructor pre-class screen: pick a scenario, lock or reroll the seed, create the
// class. A locked seed is the graded contract — every student flies byte-identical
// conditions, which only determinism makes honest. On create, the parent swaps in
// the live console.
export function ClassSetup() {
  const options = useMemo(() => getScenarioOptions(), [])
  const [scenarioId, setScenarioId] = useState(options[0]?.id ?? '')
  const scenario = options.find((o) => o.id === scenarioId)?.config
  const [seed, setSeed] = useState(scenario?.seed ?? 1)
  const [graded, setGraded] = useState(true)
  const status = useClassroomStore((s) => s.status)

  function pick(id: string) {
    setScenarioId(id)
    const s = options.find((o) => o.id === id)?.config
    if (s) setSeed(s.seed)
  }

  function create() {
    if (!scenario) return
    const config: ClassConfig = { kind: 'catalog', scenarioId, variant: defaultVariant(seed) }
    startClass(config)
  }

  return (
    <div className="cls-center">
      <div className="cls-card">
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Start a training class</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            Students join from their own device with a 6-character code.
          </div>
        </div>

        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Scenario
          <select className="cls-select" style={{ marginTop: 4 }} value={scenarioId} onChange={(e) => pick(e.target.value)}>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Seed</div>
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>{seed}</code>
          <button className="cls-btn ghost" style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => setSeed(Math.floor(Math.random() * 1_000_000_000))}>
            Reroll
          </button>
          <label style={{ fontSize: 12, marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={graded} onChange={(e) => setGraded(e.target.checked)} />
            Graded (lock seed)
          </label>
        </div>

        <button className="cls-btn" disabled={!scenario || status === 'connecting'} onClick={create}>
          {status === 'connecting' ? 'Creating…' : 'Create class'}
        </button>

        {status === 'error' && (
          <div style={{ color: '#ff8080', fontSize: 12 }}>
            Could not reach the classroom relay. Is the server running on this machine?
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          End-to-end encrypted to a key only this browser holds. If you lose this tab’s session,
          the class’s data is unrecoverable — that is real E2EE, not a defect.
        </div>
      </div>
    </div>
  )
}
