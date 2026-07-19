import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import App from './App'
import { initRunRecorder } from '@/account/runRecorder'
import { useAuthStore } from '@/store/authStore'

initRunRecorder()
void useAuthStore.getState().restoreRememberedSession()

const root = document.getElementById('root')!
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
