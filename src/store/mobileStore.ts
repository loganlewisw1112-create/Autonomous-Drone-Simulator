import { create } from 'zustand'
import type { ActiveMobileSurface } from '@/types'

export type MobileOrientation = 'portrait' | 'landscape'
export type MobileRightTab = 'ops' | 'telemetry' | 'evidence'

interface MobileState {
  activeSurface: ActiveMobileSurface | null
  rightTab: MobileRightTab
  loadingDone: boolean
  orientation: MobileOrientation
  openSurface: (surface: ActiveMobileSurface) => void
  toggleSurface: (surface: ActiveMobileSurface) => void
  closeSurface: () => void
  setRightTab: (tab: MobileRightTab) => void
  setLoadingDone: (done: boolean) => void
  setOrientation: (orientation: MobileOrientation) => void
}

/**
 * Mobile chrome state lives outside the component tree so rotating a phone never
 * replays boot/onboarding or loses the panel the operator was using.
 */
export const useMobileStore = create<MobileState>((set, get) => ({
  activeSurface: null,
  rightTab: 'telemetry',
  loadingDone: false,
  orientation: 'landscape',
  openSurface: (activeSurface) => set({
    activeSurface,
    ...(isRightSurface(activeSurface) ? { rightTab: activeSurface } : {}),
  }),
  toggleSurface: (surface) => {
    if (get().activeSurface === surface) set({ activeSurface: null })
    else get().openSurface(surface)
  },
  closeSurface: () => set({ activeSurface: null }),
  setRightTab: (rightTab) => set({ rightTab, activeSurface: rightTab }),
  setLoadingDone: (loadingDone) => set({ loadingDone }),
  setOrientation: (orientation) => set({ orientation }),
}))

export function isRightSurface(surface: ActiveMobileSurface | null): surface is MobileRightTab {
  return surface === 'ops' || surface === 'telemetry' || surface === 'evidence'
}

