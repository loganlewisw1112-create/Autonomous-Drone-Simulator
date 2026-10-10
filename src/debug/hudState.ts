import { create } from 'zustand'

// Whether the admin DebugHud corner readout is shown. Deliberately its own tiny store so the
// `hud` command and the component share one flag without touching the sim store.

interface DebugHudState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const useDebugHudStore = create<DebugHudState>((set) => ({
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
}))
