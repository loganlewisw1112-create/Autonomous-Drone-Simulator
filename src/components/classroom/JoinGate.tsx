import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { joinClass } from '@/classroom/classroomClient'
import { isValidClassId, CLASS_ID_LENGTH } from '@/classroom/protocol'
import { useClassroomStore } from '@/classroom/classroomStore'
import { useAuthStore } from '@/store/authStore'

// Student entry: 6-char class code + display name → join. On success the parent
// swaps in the live simulator; the publisher then streams from the background.
// Auth is enforced by ClassroomAuthGate; display name prefills from the student account.
export function JoinGate({ initialClassId = '' }: { initialClassId?: string }) {
  const accountName = useAuthStore((s) => s.activeAccount?.displayName ?? '')
  const [code, setCode] = useState(initialClassId.toUpperCase())
  const [name, setName] = useState(accountName)
  const [remoteControlConsent, setRemoteControlConsent] = useState(false)
  const { status, error } = useClassroomStore(useShallow((s) => ({ status: s.status, error: s.error })))

  const codeOk = isValidClassId(code)
  const nameOk = name.trim().length > 0
  const connecting = status === 'connecting'

  function submit() {
    if (codeOk && nameOk && remoteControlConsent && !connecting) {
      const accountId = useAuthStore.getState().activeAccount?.id
      joinClass(code, name.trim(), true, accountId)
    }
  }

  return (
    <div className="cls-center">
      <div className="cls-card">
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Join a training class</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            Enter the code your instructor read aloud.
          </div>
        </div>
        <input
          className="cls-input"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 22, letterSpacing: 4, textAlign: 'center' }}
          placeholder="CODE"
          maxLength={CLASS_ID_LENGTH}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <input
          className="cls-input"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <label className="cls-consent">
          <input
            type="checkbox"
            checked={remoteControlConsent}
            onChange={(event) => setRemoteControlConsent(event.target.checked)}
          />
          <span>I understand that the instructor can observe and remotely control this simulator during the class.</span>
        </label>
        <button className="cls-btn" disabled={!codeOk || !nameOk || !remoteControlConsent || connecting} onClick={submit}>
          {connecting ? 'Joining…' : 'Join class'}
        </button>
        {status === 'error' && (
          <div style={{ color: '#ff8080', fontSize: 12 }}>
            {error === 'class-full' ? 'That class is full.'
              : error === 'no-such-class' ? 'No class with that code is running.'
                : error === 'remote-control-consent-required' ? 'Consent is required to join this class.'
                : `Could not join: ${error ?? 'unknown error'}`}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          Nothing you do here leaves your device unencrypted — your mission data is sealed to your instructor’s key.
        </div>
      </div>
    </div>
  )
}
