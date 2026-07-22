import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { joinClass } from '@/classroom/classroomClient'
import { isValidClassId, CLASS_ID_LENGTH } from '@/classroom/protocol'
import { useClassroomStore } from '@/classroom/classroomStore'

// Student entry: 6-char class code + display name → join. On success the parent
// swaps in the live simulator; the publisher then streams from the background.
export function JoinGate({ initialClassId = '' }: { initialClassId?: string }) {
  const [code, setCode] = useState(initialClassId.toUpperCase())
  const [name, setName] = useState('')
  const { status, error } = useClassroomStore(useShallow((s) => ({ status: s.status, error: s.error })))

  const codeOk = isValidClassId(code)
  const nameOk = name.trim().length > 0
  const connecting = status === 'connecting'

  function submit() {
    if (codeOk && nameOk && !connecting) joinClass(code, name.trim())
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
        <button className="cls-btn" disabled={!codeOk || !nameOk || connecting} onClick={submit}>
          {connecting ? 'Joining…' : 'Join class'}
        </button>
        {status === 'error' && (
          <div style={{ color: '#ff8080', fontSize: 12 }}>
            {error === 'class-full' ? 'That class is full.'
              : error === 'no-such-class' ? 'No class with that code is running.'
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
