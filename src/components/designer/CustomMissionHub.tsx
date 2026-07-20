import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { decryptJson, encryptJson, makeId } from '@/account/crypto'
import { deleteMission, listMissions, putMission } from '@/account/accountDb'
import { MAX_CUSTOM_MISSIONS } from '@/account/types'
import { registerCustomScenario, unregisterCustomScenario } from '@/scenarios/registry'
import { initFleet, stopTicking } from '@/sim/SimulationLoop'
import { buildWeatherState } from '@/sim/weather/weatherEngine'
import { useAuthStore } from '@/store/authStore'
import { useDroneStore } from '@/store/droneStore'
import type { CustomMissionDefinition, CustomMissionRecord } from '@/account/types'
import type { LaunchRecoverySiteKind, Waypoint } from '@/types'
import {
  MAX_CUSTOM_DRONES,
  MAX_WAYPOINTS_PER_DRONE,
  compileCustomMission,
  customDroneId,
  validateCustomMission,
} from './designerValidation'
import { DesignerMap } from './DesignerMap'

const STEPS = ['Mission', 'Location', 'Sites', 'Routes', 'Review'] as const

const SITE_KINDS: Array<{ value: LaunchRecoverySiteKind; label: string }> = [
  { value: 'building_rooftop', label: 'Building rooftop' },
  { value: 'police_station', label: 'Police station' },
  { value: 'fire_station', label: 'Fire station' },
  { value: 'mobile_command', label: 'Mobile command' },
  { value: 'helipad', label: 'Helipad' },
  { value: 'vessel', label: 'Vessel' },
]

function emptyDefinition(): CustomMissionDefinition {
  const now = Date.now()
  return {
    id: makeId(),
    name: '',
    locationLabel: '',
    purpose: '',
    endGoal: '',
    center: { lat: 34.0522, lng: -118.2437 },
    droneCount: 1,
    sites: [],
    launchAssignments: {},
    recoveryAssignments: {},
    routes: { [customDroneId(0)]: [] },
    createdAt: now,
    updatedAt: now,
  }
}

function download(filename: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

function MissionStep({ value, onChange }: { value: CustomMissionDefinition; onChange: (value: CustomMissionDefinition) => void }) {
  return (
    <div className="designer-form-grid">
      <label>Mission name<input value={value.name} maxLength={60} onChange={(e) => onChange({ ...value, name: e.target.value })} /></label>
      <label>Location name<input value={value.locationLabel} maxLength={80} placeholder="City, district, or operation area" onChange={(e) => onChange({ ...value, locationLabel: e.target.value })} /></label>
      <label className="designer-span-2">What is the mission for?<textarea value={value.purpose} maxLength={500} onChange={(e) => onChange({ ...value, purpose: e.target.value })} /></label>
      <label className="designer-span-2">What ends the mission successfully?<textarea value={value.endGoal} maxLength={500} onChange={(e) => onChange({ ...value, endGoal: e.target.value })} /></label>
      <label>Fleet size<select value={value.droneCount} onChange={(e) => {
        const droneCount = Number(e.target.value)
        const routes = { ...value.routes }
        for (let i = 0; i < droneCount; i++) routes[customDroneId(i)] ??= []
        onChange({ ...value, droneCount, routes })
      }}>{Array.from({ length: MAX_CUSTOM_DRONES }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} drone{index ? 's' : ''}</option>)}</select></label>
    </div>
  )
}

function LocationStep({ value, onChange }: { value: CustomMissionDefinition; onChange: (value: CustomMissionDefinition) => void }) {
  return (
    <>
      <div className="designer-coordinate-row">
        <label>Latitude<input type="number" step="0.000001" value={value.center.lat} onChange={(e) => onChange({ ...value, center: { ...value.center, lat: Number(e.target.value) } })} /></label>
        <label>Longitude<input type="number" step="0.000001" value={value.center.lng} onChange={(e) => onChange({ ...value, center: { ...value.center, lng: Number(e.target.value) } })} /></label>
      </div>
      <DesignerMap definition={value} mode="center" selectedDrone={customDroneId(0)} waypointAltitude={120} onChange={onChange} />
    </>
  )
}

function SitesStep({ value, onChange }: { value: CustomMissionDefinition; onChange: (value: CustomMissionDefinition) => void }) {
  return (
    <>
      <DesignerMap definition={value} mode="site" selectedDrone={customDroneId(0)} waypointAltitude={120} onChange={onChange} />
      <div className="designer-list">
        {value.sites.map((site) => (
          <div className="designer-list-row" key={site.id}>
            <input aria-label="Site label" value={site.label} onChange={(e) => onChange({ ...value, sites: value.sites.map((candidate) => candidate.id === site.id ? { ...candidate, label: e.target.value } : candidate) })} />
            <select aria-label="Site type" value={site.kind} onChange={(e) => onChange({ ...value, sites: value.sites.map((candidate) => candidate.id === site.id ? { ...candidate, kind: e.target.value as LaunchRecoverySiteKind } : candidate) })}>
              {SITE_KINDS.map((kind) => <option key={kind.label} value={kind.value}>{kind.label}</option>)}
            </select>
            <label>Capacity <input aria-label="Site capacity" type="number" min={1} max={MAX_CUSTOM_DRONES} value={site.capacityDrones ?? 1} onChange={(e) => onChange({ ...value, sites: value.sites.map((candidate) => candidate.id === site.id ? { ...candidate, capacityDrones: Number(e.target.value) } : candidate) })} /></label>
            <button className="btn danger" onClick={() => onChange({
              ...value,
              sites: value.sites.filter((candidate) => candidate.id !== site.id),
              launchAssignments: Object.fromEntries(Object.entries(value.launchAssignments).filter(([, siteId]) => siteId !== site.id)),
              recoveryAssignments: Object.fromEntries(Object.entries(value.recoveryAssignments).filter(([, siteId]) => siteId !== site.id)),
            })}>DELETE</button>
          </div>
        ))}
        {!value.sites.length && <p className="account-empty">Click the map to add a launch or recovery site.</p>}
      </div>
    </>
  )
}

function RoutesStep({ value, onChange }: { value: CustomMissionDefinition; onChange: (value: CustomMissionDefinition) => void }) {
  const [selectedDrone, setSelectedDrone] = useState(customDroneId(0))
  const [altitude, setAltitude] = useState(120)
  const activeDroneIds = Array.from({ length: value.droneCount }, (_, index) => customDroneId(index))
  const route = value.routes[selectedDrone] ?? []
  const patchRoute = (next: Waypoint[]) => onChange({ ...value, routes: { ...value.routes, [selectedDrone]: next } })
  return (
    <>
      <div className="designer-route-toolbar">
        <label>Drone<select value={selectedDrone} onChange={(e) => setSelectedDrone(e.target.value)}>{activeDroneIds.map((id) => <option key={id}>{id}</option>)}</select></label>
        <label>New waypoint altitude<input type="number" min={20} max={400} value={altitude} onChange={(e) => setAltitude(Number(e.target.value))} /></label>
        <span>{route.length}/{MAX_WAYPOINTS_PER_DRONE} waypoints</span>
      </div>
      <DesignerMap definition={value} mode="waypoint" selectedDrone={selectedDrone} waypointAltitude={altitude} onChange={onChange} />
      <div className="designer-assignments">
        {activeDroneIds.map((droneId) => (
          <div key={droneId} className="designer-assignment-row">
            <strong>{droneId.toUpperCase()}</strong>
            <label>Launch<select value={value.launchAssignments[droneId] ?? ''} onChange={(e) => onChange({ ...value, launchAssignments: { ...value.launchAssignments, [droneId]: e.target.value } })}><option value="">Choose site</option>{value.sites.map((site) => <option key={site.id} value={site.id}>{site.label}</option>)}</select></label>
            <label>Recovery<select value={value.recoveryAssignments[droneId] ?? ''} onChange={(e) => onChange({ ...value, recoveryAssignments: { ...value.recoveryAssignments, [droneId]: e.target.value } })}><option value="">Choose site</option>{value.sites.map((site) => <option key={site.id} value={site.id}>{site.label}</option>)}</select></label>
          </div>
        ))}
      </div>
      <div className="designer-list">
        {route.map((waypoint, index) => (
          <div className="designer-list-row designer-waypoint-row" key={waypoint.id}>
            <span>{index + 1}</span>
            <input aria-label={`Waypoint ${index + 1} label`} value={waypoint.label ?? ''} onChange={(e) => patchRoute(route.map((candidate) => candidate.id === waypoint.id ? { ...candidate, label: e.target.value } : candidate))} />
            <label>ft <input aria-label={`Waypoint ${index + 1} altitude`} type="number" min={20} max={400} value={waypoint.altitudeFt} onChange={(e) => patchRoute(route.map((candidate) => candidate.id === waypoint.id ? { ...candidate, altitudeFt: Number(e.target.value) } : candidate))} /></label>
            <button className="btn" disabled={index === 0} onClick={() => { const next = [...route]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; patchRoute(next) }}>↑</button>
            <button className="btn" disabled={index === route.length - 1} onClick={() => { const next = [...route]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; patchRoute(next) }}>↓</button>
            <button className="btn danger" onClick={() => patchRoute(route.filter((candidate) => candidate.id !== waypoint.id))}>DELETE</button>
          </div>
        ))}
      </div>
    </>
  )
}

function ReviewStep({ value }: { value: CustomMissionDefinition }) {
  const result = useMemo(() => validateCustomMission(value), [value])
  return (
    <div className="designer-review">
      <div><strong>{value.name || 'Unnamed mission'}</strong><span>{value.locationLabel || 'No location name'}</span><span>{value.droneCount} drones · {value.sites.length} sites · {Object.values(value.routes).reduce((sum, route) => sum + route.length, 0)} waypoints</span></div>
      <div><span className="account-label">PURPOSE</span><p>{value.purpose || 'Not provided'}</p></div>
      <div><span className="account-label">END GOAL</span><p>{value.endGoal || 'Not provided'}</p></div>
      {result.valid
        ? <p className="designer-valid">✓ Mission passes route and safety checks.</p>
        : <div className="designer-errors" role="alert"><strong>Fix before saving:</strong><ul>{result.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
    </div>
  )
}

export function CustomMissionHub({ onClose, mobile = false }: { onClose: () => void; mobile?: boolean }) {
  const { activeAccount, sessionKey, setShowSignIn } = useAuthStore(useShallow((state) => ({
    activeAccount: state.activeAccount,
    sessionKey: state.sessionKey,
    setShowSignIn: state.setShowSignIn,
  })))
  const lifecycle = useDroneStore((state) => state.lifecycle)
  const [definitions, setDefinitions] = useState<CustomMissionDefinition[]>([])
  const [draft, setDraft] = useState<CustomMissionDefinition | null>(null)
  const [step, setStep] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const activeRun = lifecycle === 'running' || lifecycle === 'paused'

  function enterPreflight(scenario: ReturnType<typeof compileCustomMission>) {
    const store = useDroneStore.getState()
    stopTicking()
    store.setRunning(false)
    store.setScenario(scenario)
    if (scenario.weatherProfile) store.setWeatherState(buildWeatherState(scenario.weatherProfile, store.scenarioVariant))
    initFleet()
    store.setLifecycle('preflight')
    store.setShowPreflight(true)
  }

  useEffect(() => {
    setDefinitions([])
    setDraft(null)
    if (!activeAccount || !sessionKey) return
    let cancelled = false
    setLoading(true)
    void listMissions(activeAccount.id).then((records) => {
      if (cancelled) return
      const next: CustomMissionDefinition[] = []
      for (const record of records) {
        try { next.push(decryptJson<CustomMissionDefinition>(sessionKey, record.blob)) } catch { /* corrupt rows stay unavailable */ }
      }
      setDefinitions(next)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [activeAccount, sessionKey])

  async function saveDraft(useNow: boolean) {
    if (!draft || !activeAccount || !sessionKey) return
    const result = validateCustomMission(draft)
    if (!result.valid || !result.scenario) { setStep(4); setStatus('Fix the review issues before saving.'); return }
    const updated = { ...draft, updatedAt: Date.now() }
    const record: CustomMissionRecord = {
      schemaVersion: 2,
      id: updated.id,
      accountId: activeAccount.id,
      updatedAt: updated.updatedAt,
      blob: encryptJson(sessionKey, updated),
    }
    const stored = await putMission(record)
    if (!stored.ok) {
      setStatus('reason' in stored && stored.reason === 'limit' ? `You can save up to ${MAX_CUSTOM_MISSIONS} custom missions. Delete one before creating another.` : 'Mission could not be saved on this device.')
      return
    }
    setDefinitions((current) => [...current.filter((item) => item.id !== updated.id), updated])
    setDraft(updated)
    const scenario = registerCustomScenario(result.scenario).config
    setStatus('Mission saved to this profile.')
    if (useNow) {
      enterPreflight(scenario)
      onClose()
    }
  }

  async function removeDefinition(definition: CustomMissionDefinition) {
    if (activeRun || !window.confirm(`Delete “${definition.name}”?`)) return
    if (await deleteMission(definition.id)) {
      unregisterCustomScenario(`custom-${definition.id}`)
      setDefinitions((current) => current.filter((item) => item.id !== definition.id))
    }
  }

  function loadDefinition(definition: CustomMissionDefinition) {
    const checked = validateCustomMission(definition)
    if (!checked.valid || !checked.scenario) { setDraft(definition); setStep(4); setStatus('This saved mission needs attention before it can run.'); return }
    const scenario = registerCustomScenario(compileCustomMission(definition)).config
    enterPreflight(scenario)
    onClose()
  }

  return (
    <div className={`designer-overlay${mobile ? ' designer-overlay--mobile' : ''}`} role="dialog" aria-modal="true" aria-label="Custom mission designer" data-testid="custom-mission-hub">
      <section className="designer-shell">
        <header className="designer-header">
          <div><span className="modal-title">CUSTOM MISSIONS</span><small>Build, save, and reload up to {MAX_CUSTOM_MISSIONS} missions per profile.</small></div>
          <button className="btn" onClick={onClose}>✕ CLOSE</button>
        </header>

        {!activeAccount || !sessionKey ? (
          <div className="designer-signed-out"><p>Sign in to create and save custom missions on this device.</p><button className="btn primary" onClick={() => setShowSignIn(true)}>SIGN IN OR CREATE ACCOUNT</button></div>
        ) : draft ? (
          <>
            <nav className="designer-steps" aria-label="Designer steps">{STEPS.map((label, index) => <button key={label} className={index === step ? 'active' : ''} onClick={() => setStep(index)}><span>{index + 1}</span>{label}</button>)}</nav>
            <div className="designer-body">
              {step === 0 && <MissionStep value={draft} onChange={setDraft} />}
              {step === 1 && <LocationStep value={draft} onChange={setDraft} />}
              {step === 2 && <SitesStep value={draft} onChange={setDraft} />}
              {step === 3 && <RoutesStep value={draft} onChange={setDraft} />}
              {step === 4 && <ReviewStep value={draft} />}
            </div>
            <footer className="designer-footer">
              <button className="btn" onClick={() => setDraft(null)}>← SAVED MISSIONS</button>
              {status && <span role="status">{status}</span>}
              <div className="designer-footer-actions">
                <button className="btn" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>BACK</button>
                {step < 4 && <button className="btn primary" onClick={() => setStep((current) => Math.min(4, current + 1))}>NEXT</button>}
                {step === 4 && <><button className="btn" onClick={() => void saveDraft(false)}>SAVE</button><button className="btn primary" onClick={() => void saveDraft(true)}>SAVE & USE</button></>}
              </div>
            </footer>
          </>
        ) : (
          <div className="designer-library">
            <div className="designer-library-toolbar"><span>{definitions.length}/{MAX_CUSTOM_MISSIONS} saved</span><button className="btn primary" disabled={activeRun || definitions.length >= MAX_CUSTOM_MISSIONS} onClick={() => { setStep(0); setDraft(emptyDefinition()); setStatus(null) }}>＋ NEW MISSION</button></div>
            {activeRun && <p className="designer-warning">End the active mission before editing, deleting, or loading another one.</p>}
            {loading && <p className="account-empty">Decrypting custom missions…</p>}
            {!loading && !definitions.length && <p className="account-empty">No custom missions saved yet.</p>}
            <div className="designer-library-grid">{definitions.map((definition) => (
              <article key={definition.id} className="designer-mission-card">
                <div><strong>{definition.name}</strong><span>{definition.locationLabel}</span><small>{definition.droneCount} drones · {Object.values(definition.routes).reduce((sum, route) => sum + route.length, 0)} waypoints</small></div>
                <p>{definition.purpose}</p>
                <div><button className="btn primary" disabled={activeRun} onClick={() => loadDefinition(definition)}>USE MISSION</button><button className="btn" disabled={activeRun} onClick={() => { setDraft(structuredClone(definition)); setStep(0); setStatus(null) }}>EDIT</button><button className="btn danger" disabled={activeRun} onClick={() => void removeDefinition(definition)}>DELETE</button><button className="btn" onClick={() => download(`${definition.name.replace(/\W+/g, '-').toLowerCase()}.json`, JSON.stringify(definition, null, 2))}>EXPORT</button></div>
              </article>
            ))}</div>
          </div>
        )}
      </section>
    </div>
  )
}

export default CustomMissionHub
