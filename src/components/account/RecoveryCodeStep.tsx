import { useState } from 'react'

// "Save your recovery code": shown once after signup, a password reset, or a
// regenerate. The code is never stored, so this is the only chance to keep it.
// The continue button stays disabled until the user ticks "I saved it".

export function recoveryCodeFileText(code: string, username: string): string {
  return [
    'Drone Ops Center - account recovery code',
    '',
    `Profile: ${username}`,
    `Recovery code: ${code}`,
    '',
    'Keep this file somewhere safe and private. The code can reset your password.',
    'Profiles live only on the device where they were created. Using the code',
    'issues a new one, so this one stops working after a reset.',
    '',
  ].join('\n')
}

export function RecoveryCodeStep({
  code,
  username,
  onDone,
  title = 'SAVE YOUR RECOVERY CODE',
  continueLabel = 'CONTINUE',
}: {
  code: string
  username: string
  onDone: () => void
  title?: string
  continueLabel?: string
}) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopied(false) // clipboard blocked: the code is still on screen and downloadable
    }
  }

  function handleDownload() {
    const blob = new Blob([recoveryCodeFileText(code, username)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `drone-ops-recovery-code-${username}.txt`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div data-testid="recovery-code-step" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="modal-title">{title}</div>
      <p style={{ fontSize: 'var(--fs-min)', color: 'var(--text-secondary)', margin: 0 }}>
        If you forget your password, this code is the only way to reset it. It is shown
        once and is not stored anywhere on this device. Using it issues a new code.
      </p>
      <div
        data-testid="recovery-code-value"
        style={{
          fontFamily: 'var(--font-mono)', fontSize: 18, letterSpacing: 2, textAlign: 'center',
          padding: '12px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-input)', color: 'var(--accent-green)', userSelect: 'all', wordBreak: 'break-all',
        }}
      >
        {code}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => void handleCopy()}>{copied ? 'COPIED' : 'COPY'}</button>
        <button className="btn" onClick={handleDownload}>DOWNLOAD .TXT</button>
      </div>
      <label style={{ fontSize: 'var(--fs-min)', color: 'var(--text-secondary)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I saved it
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" disabled={!saved} onClick={onDone}>{continueLabel}</button>
      </div>
    </div>
  )
}
