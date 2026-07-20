import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import {
  buildAggregates, buildTimeline, completionReasons, eventTypeTotals, runsByScenario, safetyTrend, sortiesByPlatform,
} from '@/components/account/analyticsData'
import { useAuthStore } from '@/store/authStore'
import { decryptJson, deriveKey, encryptJson, makeCheckBlob, makeKdfParams, toBase64 } from '@/account/crypto'
import {
  clearRunDetails, clearRuns, deleteAccount, exportBackup, getAccountByUsername, getRunDetail, importBackup, listRuns, rekeyAllRecords,
} from '@/account/accountDb'
import { getScenarioOptions } from '@/scenarios/registry'
import { useDeviceMode } from '@/hooks/useDeviceMode'
import type { AccountRecord, StoredRunDetailV2, StoredRunSummary } from '@/account/types'

const RunDetailView = lazy(() => import('@/components/rundetail/RunDetailView').then((module) => ({ default: module.RunDetailView })))

// Full-screen Analytics + Settings panels, shared by both shells. Gated on
// auth-store flags so this whole chunk stays lazy until first opened.

interface DecryptedRunEntry { id: string; summary: StoredRunSummary }

function useDecryptedRuns(open: boolean): { runs: DecryptedRunEntry[]; loading: boolean; corruptCount: number } {
  const { activeAccount, sessionKey } = useAuthStore(
    useShallow((s) => ({ activeAccount: s.activeAccount, sessionKey: s.sessionKey })),
  )
  const [runs, setRuns] = useState<DecryptedRunEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [corruptCount, setCorruptCount] = useState(0)

  useEffect(() => {
    if (!open || !activeAccount || !sessionKey) return
    let cancelled = false
    setLoading(true)
    void listRuns(activeAccount.id).then((records) => {
      if (cancelled) return
      const decrypted: DecryptedRunEntry[] = []
      let corrupt = 0
      for (const record of records) {
        try {
          decrypted.push({ id: record.id, summary: decryptJson<StoredRunSummary>(sessionKey, record.blob) })
        } catch { corrupt++ }
      }
      setRuns(decrypted)
      setCorruptCount(corrupt)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, activeAccount, sessionKey])

  return { runs, loading, corruptCount }
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="account-stat-tile">
      <span className="account-stat-value">{value}</span>
      <span className="account-stat-label">{label}</span>
    </div>
  )
}

// Completion-reason slice colors. Ordered so the common "all routes complete"
// case reads green and failure modes read warm.
const REASON_COLORS = ['#44ff88', '#00d4ff', '#ffaa00', '#ff4444', '#a371f7', '#8b949e']

function AnalyticsPanel() {
  const deviceMode = useDeviceMode()
  const mobile = deviceMode === 'phone-landscape' || deviceMode === 'phone-portrait'
  const { showAnalytics, setShowAnalytics, activeAccount, sessionKey } = useAuthStore(
    useShallow((s) => ({ showAnalytics: s.showAnalytics, setShowAnalytics: s.setShowAnalytics, activeAccount: s.activeAccount, sessionKey: s.sessionKey })),
  )
  const { runs, loading, corruptCount } = useDecryptedRuns(showAnalytics)
  const [selected, setSelected] = useState<DecryptedRunEntry | null>(null)
  const [detail, setDetail] = useState<StoredRunDetailV2 | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    if (!showAnalytics) { setSelected(null); setDetail(null) }
  }, [showAnalytics])

  async function openRun(entry: DecryptedRunEntry) {
    setSelected(entry)
    setDetail(null)
    if (!sessionKey) return
    setDetailLoading(true)
    const record = await getRunDetail(entry.id)
    if (record) {
      try { setDetail(decryptJson<StoredRunDetailV2>(sessionKey, record.blob)) } catch { setDetail(null) }
    }
    setDetailLoading(false)
  }

  // Aggregation lives in analyticsData so it stays testable without the panel.
  const summaries = useMemo(() => runs.map((r) => r.summary), [runs])
  const aggregates = useMemo(() => buildAggregates(summaries), [summaries])
  const timeline = useMemo(() => buildTimeline(summaries), [summaries])
  const byScenario = useMemo(() => runsByScenario(summaries), [summaries])
  const byPlatform = useMemo(() => sortiesByPlatform(summaries), [summaries])
  const reasons = useMemo(() => completionReasons(summaries), [summaries])
  const safety = useMemo(() => safetyTrend(summaries), [summaries])
  const eventMix = useMemo(() => eventTypeTotals(summaries), [summaries])

  if (!showAnalytics) return null

  return (
    <div className="account-panel" data-testid="analytics-panel">
      <div className="account-panel-header">
        <span className="modal-title" style={{ marginBottom: 0 }}>📊 USAGE ANALYTICS — {activeAccount?.displayName?.toUpperCase()}</span>
        <button className="btn" onClick={() => setShowAnalytics(false)}>✕ CLOSE</button>
      </div>

      {!activeAccount && <p className="account-empty">Sign in to see your mission analytics.</p>}
      {activeAccount && loading && <p className="account-empty">Decrypting mission history…</p>}
      {activeAccount && !loading && runs.length === 0 && (
        <p className="account-empty">No saved missions yet. Complete a mission (▶ START → ■ END MISSION) and it will be recorded to this profile automatically.</p>
      )}

      {corruptCount > 0 && <p className="account-status warning">{corruptCount} saved run{corruptCount === 1 ? '' : 's'} could not be decrypted. The records were left unchanged.</p>}

      {runs.length > 0 && (
        <div className="account-panel-body">
          <div className="account-stat-row">
            <StatTile label="MISSIONS" value={aggregates.total} />
            <StatTile label="TOTAL DISTANCE" value={`${aggregates.distanceKm.toFixed(1)} km`} />
            <StatTile label="THERMAL CONTACTS" value={aggregates.contacts} />
            <StatTile label="WAYPOINTS" value={aggregates.waypoints} />
            <StatTile label="AVG DURATION" value={`${Math.round(aggregates.avgDuration / 60)}m ${Math.round(aggregates.avgDuration % 60)}s`} />
            <StatTile label="CHAIN VERIFIED" value={`${aggregates.verified}/${aggregates.total}`} />
            {/* All five come from metrics already persisted on every run — no backfill. */}
            <StatTile label="CONFLICTS" value={aggregates.conflicts} />
            <StatTile label="GEOFENCE BREACHES" value={aggregates.geofenceBreaches} />
            <StatTile label="RTB EVENTS" value={aggregates.rtbTriggers} />
            <StatTile label="RECOVERIES" value={aggregates.recoveryDispatches} />
            <StatTile label="GROUND DISPATCHES" value={aggregates.groundDispatches} />
          </div>

          <div className="account-chart-grid">
            <div className="account-chart-card">
              <span className="account-label">DISTANCE PER MISSION (KM)</span>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={timeline} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                  <XAxis dataKey="run" tick={{ fill: '#8b949e', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#8b949e', fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
                  <Line type="monotone" dataKey="distanceKm" stroke="#00d4ff" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="account-chart-card">
              <span className="account-label">MISSIONS BY SCENARIO</span>
              <ResponsiveContainer width="100%" height={180}>
                {/* Real scenario names, angled so they stay legible at this width. */}
                <BarChart data={byScenario} margin={{ top: 8, right: 12, bottom: 34, left: -18 }}>
                  <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={{ fill: '#8b949e', fontSize: 9 }} angle={-30} textAnchor="end" interval={0} height={48} />
                  <YAxis allowDecimals={false} tick={{ fill: '#8b949e', fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
                  <Bar dataKey="count" fill="#44ff88" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="account-chart-card">
              <span className="account-label">HOW MISSIONS ENDED</span>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={reasons} dataKey="count" nameKey="reason" cx="50%" cy="50%" outerRadius={62} label={{ fill: '#8b949e', fontSize: 9 }}>
                    {reasons.map((entry, i) => (
                      <Cell key={entry.reason} fill={REASON_COLORS[i % REASON_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="account-chart-card">
              <span className="account-label">SAFETY EVENTS PER MISSION</span>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={safety} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                  <XAxis dataKey="run" tick={{ fill: '#8b949e', fontSize: 10 }} />
                  <YAxis allowDecimals={false} tick={{ fill: '#8b949e', fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
                  <Line type="monotone" dataKey="conflicts" stroke="#ffaa00" strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="breaches" stroke="#ff4444" strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="account-chart-card">
              <span className="account-label">SORTIES BY AIRFRAME</span>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={byPlatform} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={{ fill: '#8b949e', fontSize: 9 }} interval={0} />
                  <YAxis allowDecimals={false} tick={{ fill: '#8b949e', fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
                  <Bar dataKey="sorties" fill="#00d4ff" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="account-chart-card">
              <span className="account-label">EVENT MIX (TOP 8)</span>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={eventMix.totals} layout="vertical" margin={{ top: 8, right: 12, bottom: 0, left: 46 }}>
                  <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                  <XAxis type="number" allowDecimals={false} tick={{ fill: '#8b949e', fontSize: 10 }} />
                  <YAxis type="category" dataKey="eventType" width={96} tick={{ fill: '#8b949e', fontSize: 8.5 }} />
                  <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
                  <Bar dataKey="count" fill="#a371f7" />
                </BarChart>
              </ResponsiveContainer>
              {eventMix.runsWithoutCounts > 0 && (
                <span className="account-chart-note">
                  {eventMix.runsWithoutCounts} earlier run{eventMix.runsWithoutCounts === 1 ? '' : 's'} predate event-type recording and are not included.
                </span>
              )}
            </div>
          </div>

          <div className={`account-analytics-master${selected ? ' account-analytics-master--selected' : ''}`}>
            <div className="account-run-list">
              <span className="account-label">MISSION LOG (NEWEST LAST)</span>
              {runs.map((entry, i) => {
                const r = entry.summary
                const evidenceLabel = r.eventCount === 0 ? '○ no evidence' : r.chainVerified ? '✓ chain verified' : '⚠ unverified'
                return (
                  <button key={entry.id || `${r.completedAt}-${i}`} className={`account-run-row${selected?.id === entry.id ? ' active' : ''}`} onClick={() => void openRun(entry)} aria-label={`Open ${r.scenarioId} run from ${new Date(r.completedAt).toLocaleString()}`}>
                    <span>{new Date(r.completedAt).toLocaleString()}</span>
                    <span className="account-run-scenario">{r.scenarioId.toUpperCase()}</span>
                    <span>{(r.metrics.totalFlightDistanceM / 1000).toFixed(2)} km</span>
                    <span>{r.metrics.thermalContacts} contacts</span>
                    <span className={`account-run-evidence account-run-evidence--${r.eventCount === 0 ? 'none' : r.chainVerified ? 'verified' : 'failed'}`}>{evidenceLabel}</span>
                    <span aria-hidden="true">›</span>
                  </button>
                )
              })}
            </div>
            {selected && <div className="account-run-detail-pane">{detailLoading ? <p className="account-empty">Decrypting full run…</p> : <Suspense fallback={<p className="account-empty">Opening run…</p>}><RunDetailView summary={selected.summary} detail={detail} mobile={mobile} onBack={() => { setSelected(null); setDetail(null) }} /></Suspense>}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

function SettingsPanel() {
  const {
    showSettings, setShowSettings, activeAccount, sessionKey, prefs, savePrefs, signOut, setShowAnalytics,
  } = useAuthStore(
    useShallow((s) => ({
      showSettings: s.showSettings, setShowSettings: s.setShowSettings,
      activeAccount: s.activeAccount, sessionKey: s.sessionKey,
      prefs: s.prefs, savePrefs: s.savePrefs, signOut: s.signOut, setShowAnalytics: s.setShowAnalytics,
    })),
  )
  const [status, setStatus] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!showSettings) return null
  if (!activeAccount || !sessionKey) {
    return (
      <div className="account-panel" data-testid="settings-panel">
        <div className="account-panel-header">
          <span className="modal-title" style={{ marginBottom: 0 }}>⚙ SETTINGS</span>
          <button className="btn" onClick={() => setShowSettings(false)}>✕ CLOSE</button>
        </div>
        <p className="account-empty">Sign in to manage your profile.</p>
      </div>
    )
  }

  const flash = (msg: string) => {
    setStatus(msg)
    window.setTimeout(() => setStatus(null), 4000)
  }

  async function handleBackupExport() {
    const envelope = await exportBackup(activeAccount!.id)
    if (!envelope) { flash('Backup failed — storage unavailable'); return }
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `drone-sim-backup-${activeAccount!.username}-${Date.now()}.json`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    flash('Backup exported (encrypted — same password required to restore)')
  }

  async function handleBackupImport(file: File) {
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const result = await importBackup(parsed)
      flash(result.ok ? 'Backup imported — sign in to that profile to view runs' : `Import failed: ${result.reason}`)
    } catch {
      flash('Import failed: not a valid backup JSON file')
    }
  }

  async function handleChangePassword() {
    if (newPassword.length < 8) { flash('New password must be at least 8 characters'); return }
    const record = await getAccountByUsername(activeAccount!.username)
    if (!record) { flash('Profile record not found'); return }
    // Re-key everything atomically: new salt + key, re-encrypted check blob and
    // prefs, plus every run / run-detail / mission blob — all in ONE transaction.
    // If any row fails to re-encrypt the whole change aborts and the old password
    // still decrypts the untouched data.
    const kdfParams = makeKdfParams()
    const newKey = deriveKey(newPassword, kdfParams)
    const newAccountRecord: AccountRecord = {
      ...record,
      kdfParams,
      checkBlob: makeCheckBlob(newKey),
      prefsBlob: encryptJson(newKey, prefs),
    }
    const ok = await rekeyAllRecords(activeAccount!.id, sessionKey!, newKey, newAccountRecord)
    if (!ok) { flash('Password change failed — nothing was modified; your old password still works'); return }
    useAuthStore.setState({ sessionKey: newKey })
    try {
      const raw = localStorage.getItem('drone-sim:session:v1')
      if (raw) localStorage.setItem('drone-sim:session:v1', JSON.stringify({ v: 1, username: record.username, key: toBase64(newKey) }))
    } catch { /* noop */ }
    setNewPassword('')
    flash('Password changed — all mission data re-encrypted')
  }

  async function handleClearRuns() {
    await clearRuns(activeAccount!.id)
    await clearRunDetails(activeAccount!.id)
    setConfirmClear(false)
    flash('Mission history cleared')
  }

  async function handleDeleteProfile() {
    await deleteAccount(activeAccount!.id)
    setConfirmDelete(false)
    setShowSettings(false)
    signOut()
  }

  return (
    <div className="account-panel" data-testid="settings-panel">
      <div className="account-panel-header">
        <span className="modal-title" style={{ marginBottom: 0 }}>⚙ SETTINGS — {activeAccount.displayName.toUpperCase()}</span>
        <button className="btn" onClick={() => setShowSettings(false)}>✕ CLOSE</button>
      </div>

      <div className="account-panel-body">
        {status && <p className="account-status">{status}</p>}

        <div className="account-settings-section">
          <span className="account-label">PREFERENCES</span>
          <div className="account-settings-row">
            <label>Default scenario
              <select
                className="account-input"
                value={prefs.defaultScenarioId ?? ''}
                onChange={(e) => void savePrefs({ ...prefs, defaultScenarioId: e.target.value || undefined })}
              >
                <option value="">— none —</option>
                {getScenarioOptions().map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <label>Default sim speed
              <select
                className="account-input"
                value={prefs.defaultSimSpeed ?? ''}
                onChange={(e) => void savePrefs({ ...prefs, defaultSimSpeed: e.target.value ? Number(e.target.value) as 1 | 5 | 10 : undefined })}
              >
                <option value="">— 1× —</option>
                <option value="1">1×</option>
                <option value="5">5×</option>
                <option value="10">10×</option>
              </select>
            </label>
          </div>
        </div>

        <div className="account-settings-section">
          <span className="account-label">DATA</span>
          <div className="account-settings-row">
            <button className="btn" onClick={() => void handleBackupExport()}>⬇ EXPORT BACKUP</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>⬆ IMPORT BACKUP</button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleBackupImport(f); e.target.value = '' }}
            />
            <button className="btn" onClick={() => setShowAnalytics(true)}>📊 OPEN ANALYTICS</button>
          </div>
          <div className="account-settings-row">
            {!confirmClear
              ? <button className="btn warning" onClick={() => setConfirmClear(true)}>CLEAR MISSION HISTORY</button>
              : (
                <>
                  <span style={{ color: 'var(--accent-yellow)', fontSize: 12 }}>Delete all saved missions for this profile?</span>
                  <button className="btn danger" onClick={() => void handleClearRuns()}>YES, CLEAR</button>
                  <button className="btn" onClick={() => setConfirmClear(false)}>CANCEL</button>
                </>
              )}
          </div>
        </div>

        <div className="account-settings-section">
          <span className="account-label">SECURITY</span>
          <div className="account-settings-row">
            <label>New password
              <input
                className="account-input"
                type="password"
                value={newPassword}
                autoComplete="new-password"
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <button className="btn" onClick={() => void handleChangePassword()} disabled={!newPassword}>CHANGE PASSWORD</button>
          </div>
          <p className="account-fineprint">
            Changing the password re-encrypts your entire mission history with a new key.
            Passwords cannot be recovered — a lost password means the encrypted history is unreadable.
          </p>
        </div>

        <div className="account-settings-section">
          <span className="account-label">DANGER ZONE</span>
          <div className="account-settings-row">
            <button className="btn" onClick={signOut}>⏻ SIGN OUT</button>
            {!confirmDelete
              ? <button className="btn danger" onClick={() => setConfirmDelete(true)}>DELETE PROFILE</button>
              : (
                <>
                  <span style={{ color: 'var(--accent-red)', fontSize: 12 }}>Permanently delete this profile and all its missions?</span>
                  <button className="btn danger" onClick={() => void handleDeleteProfile()}>YES, DELETE</button>
                  <button className="btn" onClick={() => setConfirmDelete(false)}>CANCEL</button>
                </>
              )}
          </div>
        </div>

        <div className="account-settings-section">
          <span className="account-label">ABOUT</span>
          <p className="account-fineprint">
            Drone Ops Center — local-first mission simulator. Profiles and mission history live
            only in this browser (IndexedDB), encrypted with AES-256-GCM (PBKDF2-SHA-256,
            {' '}310k iterations). Simulation only — no real flight data.
            Build: {import.meta.env.VITE_GIT_HASH ?? 'dev'}.
          </p>
        </div>
      </div>
    </div>
  )
}

export function AccountPanels() {
  return (
    <>
      <AnalyticsPanel />
      <SettingsPanel />
    </>
  )
}
