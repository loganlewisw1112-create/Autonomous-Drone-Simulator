import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts'
import type { TelemetryPoint } from '@/types'

// Tactical palette (hex — CSS vars don't work in recharts props)
const C_BG = '#0d1117'
const C_GRID = '#1e2b3a'

// Extracted from TelemetryPanel so recharts (a ~530kB vendor chunk) loads lazily —
// TelemetryPanel itself stays in the first-paint bundle, the charts arrive async.
export function TelemetryCharts({ history, batColor }: { history: TelemetryPoint[]; batColor: string }) {
  return (
    <>
      <ChartSection label="Altitude (ft AGL)" history={history} dataKey="alt" color="#00d4ff" domain={[0, 420]} gradId="altGrad" formatter={(v: number) => [`${v} ft`, 'ALT']} />
      <ChartSection label="Battery (%)" history={history} dataKey="bat" color={batColor} domain={[0, 100]} gradId="batGrad" formatter={(v: number) => [`${v}%`, 'BAT']} />
      <ChartSection label="Speed (m/s)" history={history} dataKey="spd" color="#ffaa00" domain={[0, 15]} gradId="spdGrad" formatter={(v: number) => [`${v} m/s`, 'SPD']} />
    </>
  )
}

function ChartSection({ label, history, dataKey, color, domain, gradId, formatter }: {
  label: string
  history: TelemetryPoint[]
  dataKey: string
  color: string
  domain: [number, number]
  gradId: string
  formatter: (v: number) => [string, string]
}) {
  return (
    <div className="panel-section">
      <div className="panel-label" style={{ marginBottom: 4 }}>{label}</div>
      <ResponsiveContainer width="100%" height={60}>
        <AreaChart data={history} margin={{ top: 2, right: 4, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" hide />
          <YAxis domain={domain} tick={{ fill: '#556677', fontSize: 9 }} tickCount={3} />
          <Tooltip contentStyle={{ background: C_BG, border: `1px solid ${C_GRID}`, fontSize: 10 }} labelStyle={{ color: '#8899aa' }} itemStyle={{ color }} formatter={formatter} labelFormatter={(t: number) => `T+${t}s`} />
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} fill={`url(#${gradId})`} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
