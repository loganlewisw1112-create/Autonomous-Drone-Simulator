import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import App from './App'
import { initRunRecorder } from '@/account/runRecorder'
import { useAuthStore } from '@/store/authStore'
import { resolveClassroomRoute } from '@/platform/classroomRoute'
import { UsagePolicyGate } from '@/licensing/UsagePolicyGate'

initRunRecorder()
// v1 stored a raw account AES key for "remember me". v1.1 deliberately signs
// every profile out on reload and removes that legacy secret without touching
// any IndexedDB account or run data.
useAuthStore.getState().clearLegacyPersistedSession()

// Classroom is opt-in and OFF by default. Only a build with VITE_CLASSROOM_ENABLED
// reaches the lazy chunk, so its networking tree-shakes out of the mobile/Windows
// bundles entirely. On that build, bare `/` opens the classroom home chooser — not
// the ordinary Ops Center (that made the classroom Vercel URL look like Windows).
function resolveRoot() {
  if (import.meta.env.VITE_CLASSROOM_ENABLED === 'true') {
    const route = resolveClassroomRoute(location.search, true)
    if (route.kind === 'classroom') {
      const ClassroomEntry = lazy(() =>
        import('@/components/classroom/ClassroomEntry').then((m) => ({ default: m.ClassroomEntry })))
      return (
        <Suspense fallback={<div style={{ height: '100dvh', background: 'var(--bg-primary)' }} />}>
          <ClassroomEntry mode={route.mode} initialClassId={route.initialClassId} />
        </Suspense>
      )
    }
  }
  return <App />
}

const root = document.getElementById('root')!
createRoot(root).render(
  <StrictMode>
    <UsagePolicyGate>{resolveRoot()}</UsagePolicyGate>
  </StrictMode>,
)
